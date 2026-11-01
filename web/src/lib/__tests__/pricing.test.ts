import { describe, expect, it } from 'vitest';
import { conversationCost, estimateCost, fmtCost, fmtUsd, priceFor, turnCost } from '../pricing';
import { latestRatelimit, turnSeries, type ObsConversation, type Tokens } from '../observe';

const tok = (t: Partial<Tokens>): Tokens => ({ input: 0, output: 0, thinking: null, cache_read: 0, cache_write: 0, cache_write_5m: null, cache_write_1h: null, ...t });

describe('pricing', () => {
  it('resolves models by longest prefix, including Devin-suffixed ids', () => {
    expect(priceFor('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(priceFor('claude-fable-5-1-medium')?.cacheRead).toBe(0.25);
    expect(priceFor('claude-fable-5')?.cacheRead).toBe(1);
    expect(priceFor('claude-opus-4-6-thinking')?.input).toBe(5);
    expect(priceFor('claude-opus-5-5')?.output).toBe(20);
    expect(priceFor('gpt-5-5-medium')).toBeNull();
    expect(priceFor(null)).toBeNull();
  });

  it('prices the design §1.5 example: #1 of the screenshot ≈ $0.40, dominated by the 1h cache write', () => {
    // r 12816 · w 19481 (1h) · in 2 · out 233 on Fable 5.1
    const c = estimateCost(tok({ cache_read: 12816, cache_write: 19481, cache_write_1h: 19481, cache_write_5m: 0, input: 2, output: 233 }), 'claude-fable-5-1');
    expect(c?.assumedTtl).toBe(false);
    expect(c!.usd).toBeCloseTo(0.4048, 3);
  });

  it('assumes the 1h price when the TTL split is missing and flags it', () => {
    const c = estimateCost(tok({ cache_write: 1_000_000 }), 'claude-opus-5-5');
    expect(c).toEqual({ usd: 8, assumedTtl: true });
    const d = estimateCost(tok({ cache_write: 1_000_000, cache_write_5m: 1_000_000, cache_write_1h: 0 }), 'claude-opus-5-5');
    expect(d).toEqual({ usd: 5, assumedTtl: false });
  });

  it('sums a turn over its generations, flagging assumed TTL and unpriced models', () => {
    const g = (id: string, model: string, t: Partial<Tokens>): any => ({
      id, seq_no: 1, type: 'generation', inputs: [], ref: null, payload: { model, request_id: null, effort: null },
      result: { output_text: null, thinking: null, stop_reason: 'end_turn', tokens: tok(t) }, started_at: null, ended_at: null,
    });
    const turn = (actions: any[]): any => ({ id: 'S:t0', seq_no: 0, actions, stop_action_id: null, started_at: null, ended_at: null });
    const c = turnCost(turn([g('a', 'claude-opus-5-5', { output: 1_000_000 }), g('b', 'claude-opus-5-5', { cache_write: 1_000_000 }), g('c', 'gpt-5-5', { output: 9 })]));
    expect(c).toEqual({ usd: 28, assumedTtl: true, unpriced: 1, subUsd: null, subagents: 0 });
    expect(turnCost(turn([g('c', 'gpt-5-5', { output: 9 })]))).toEqual({ usd: null, assumedTtl: false, unpriced: 1, subUsd: null, subagents: 0 });
    expect(turnCost(turn([]))).toEqual({ usd: null, assumedTtl: false, unpriced: 0, subUsd: null, subagents: 0 });
  });

  it('rolls spawned conversations into the parent turn and conversation, grandchildren included', () => {
    const g = (id: string, model: string, t: Partial<Tokens>): any => ({
      id, seq_no: 1, type: 'generation', inputs: [], ref: null, payload: { model, request_id: null, effort: null },
      result: { output_text: null, thinking: null, stop_reason: 'end_turn', tokens: tok(t) }, started_at: null, ended_at: null,
    });
    const tc = (id: string, spawned: string | null): any => ({
      id, seq_no: 2, type: 'tool_call', inputs: [], ref: null, payload: { name: 'Agent', args: null },
      result: { status: 'success', content: null, latency_ms: 1, spawned_conversation_id: spawned }, started_at: null, ended_at: null,
    });
    const conv = (id: string, parent: { conversation_id: string; action_id: string } | null, actions: any[]): ObsConversation => ({
      schema: 'observation/3', id, parent, root_conversation_id: 'S', agent_type: 'claude', subagent_type: null, model: 'm', started_at: null, ended_at: null, wire_orphans: [], meta: {},
      turns: [{ id: `${id}:t0`, seq_no: 0, actions, stop_action_id: null, started_at: null, ended_at: null }],
    });
    const root = conv('S', null, [g('g0', 'claude-opus-5-5', { output: 1_000_000 }), tc('a1', 'S:c1'), tc('a2', 'S:c2')]);
    const c1 = conv('S:c1', { conversation_id: 'S', action_id: 'a1' }, [g('g1', 'claude-opus-5-5', { output: 100_000 }), tc('a3', 'S:c3')]);
    const c3 = conv('S:c3', { conversation_id: 'S:c1', action_id: 'a3' }, [g('g3', 'claude-opus-5-5', { output: 10_000 })]);
    const c2 = conv('S:c2', { conversation_id: 'S', action_id: 'a2' }, [g('g2', 'gpt-5-5', { output: 9 })]);
    const all = [root, c1, c2, c3];
    const t = turnCost(root.turns[0], all);
    expect(t).toEqual({ usd: 22.2, assumedTtl: false, unpriced: 1, subUsd: 2.2, subagents: 3 });
    expect(conversationCost(root, all)).toEqual(t);
    // the child's own total only covers itself and its descendants
    expect(conversationCost(c1, all)).toEqual({ usd: 2.2, assumedTtl: false, unpriced: 0, subUsd: 0.2, subagents: 1 });
    expect(fmtCost(t)).toBe('≈$22.20 (+1 unpriced, incl. 3 subagents $2.20)');
    expect(fmtCost(turnCost(root.turns[0]))).toBe('≈$20.00');
  });

  it('formats dollars at a useful precision', () => {
    expect([fmtUsd(123.4), fmtUsd(1.234), fmtUsd(0.04048), fmtUsd(0.00012)]).toEqual(['$123', '$1.23', '$0.040', '$0.0001']);
  });
});

describe('turnSeries / latestRatelimit', () => {
  const gen = (id: string, t: Partial<Tokens>, wire?: Record<string, string>): any => ({
    id, seq_no: 1, type: 'generation', inputs: [], ref: null, payload: { model: 'm', request_id: null, effort: null },
    result: { output_text: null, thinking: null, stop_reason: 'end_turn', tokens: tok(t), ...(wire ? { wire: { ratelimit: wire } } : {}) },
    started_at: null, ended_at: null,
  });
  const conv: ObsConversation = {
    schema: 'observation/3', id: 'S', parent: null, root_conversation_id: 'S', agent_type: 'claude', subagent_type: null, model: 'm', started_at: null, ended_at: null, wire_orphans: [], meta: {},
    turns: [
      { id: 'S:t0', seq_no: 0, actions: [gen('g1', { cache_read: 900, cache_write: 100 }, { '5h-utilization': '0.2' }), gen('g2', { cache_read: 1000, input: 0, output: 10 })], stop_action_id: 'g2', started_at: null, ended_at: null },
      { id: 'S:t1', seq_no: 1, actions: [gen('g3', { input: 5 }, { '5h-utilization': '0.3', '7d-utilization': '0.1' })], stop_action_id: null, started_at: null, ended_at: null },
    ],
  };
  it('sums tokens per turn and derives the hit rate', () => {
    const s = turnSeries(conv);
    expect(s[0]).toMatchObject({ seq: 0, cacheRead: 1900, cacheWrite: 100, input: 0, output: 10, generations: 2, noStop: false });
    expect(s[0].hitRate).toBeCloseTo(0.95, 3);
    expect(s[1]).toMatchObject({ seq: 1, input: 5, hitRate: 0, noStop: true });
  });
  it('returns the latest wire ratelimit headers', () => {
    expect(latestRatelimit(conv)).toEqual({ '5h-utilization': '0.3', '7d-utilization': '0.1' });
    expect(latestRatelimit({ ...conv, turns: [] })).toBeNull();
  });
});
