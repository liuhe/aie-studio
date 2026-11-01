import { describe, expect, it } from 'vitest';
import {
  argsSummary,
  blockText,
  contentBlocks,
  sseBlocks,
  sseEventSummary,
  wireKey,
  cacheDropIds,
  childrenByAction,
  conversationStats,
  fmtMs,
  fmtTokens,
  seqIndex,
  tokenSegments,
  turnRows,
  turnSummary,
  type ObsAction,
  type ObsConversation,
  type ObsTurn,
} from '../observe';

const ui = (id: string, seq: number, text: string, kind: 'new_task' | 'follow_up' | 'interrupt' = 'new_task'): ObsAction => ({
  id, seq_no: seq, type: 'user_input', inputs: [], ref: null,
  payload: { content: [{ type: 'text', inline_text: text, length: text.length }], kind, source: 'human' },
  result: null, started_at: '2026-10-31T10:00:00.000Z', ended_at: '2026-10-31T10:00:00.000Z',
});
const gen = (id: string, seq: number, inputs: string[], tokens: Partial<ObsAction & { type: 'generation' }>['result'] extends infer _ ? { cache_read?: number | null; cache_write?: number; input?: number; output?: number } : never, stop = 'end_turn'): ObsAction => ({
  id, seq_no: seq, type: 'generation', inputs, ref: null,
  payload: { model: 'm', request_id: null, effort: null },
  result: { output_text: null, thinking: null, stop_reason: stop, tokens: { input: tokens.input ?? 0, output: tokens.output ?? 0, thinking: null, cache_read: tokens.cache_read === undefined ? 0 : tokens.cache_read, cache_write: tokens.cache_write ?? 0, cache_write_5m: null, cache_write_1h: null } },
  started_at: '2026-10-31T10:00:01.000Z', ended_at: '2026-10-31T10:00:02.000Z',
});
const tc = (id: string, seq: number, genId: string, name = 'Bash', args = '{"command":"ls -la"}'): ObsAction => ({
  id, seq_no: seq, type: 'tool_call', inputs: [genId], ref: null,
  payload: { name, args: { digest: 'x', length: args.length, inline_text: args } },
  result: { status: 'success', content: null, latency_ms: 120, spawned_conversation_id: null },
  started_at: '2026-10-31T10:00:01.000Z', ended_at: '2026-10-31T10:00:01.500Z',
});
const turn = (id: string, seq: number, actions: ObsAction[], stop: string | null): ObsTurn => ({
  id, seq_no: seq, actions, stop_action_id: stop, started_at: actions[0]?.started_at ?? null, ended_at: '2026-10-31T10:00:05.000Z',
});
const conv = (turns: ObsTurn[], over: Partial<ObsConversation> = {}): ObsConversation => ({
  schema: 'observation/3', id: 'S', parent: null, root_conversation_id: 'S', agent_type: 'claude', subagent_type: null,
  model: 'm', started_at: '2026-10-31T10:00:00.000Z', ended_at: '2026-10-31T10:00:05.000Z', turns, wire_orphans: [], meta: { validation: { ok: true, issues: [] } }, ...over,
});

describe('turnRows', () => {
  it('puts parallel tool_calls of one generation side by side and everything else on its own row', () => {
    const t = turn('S:t0', 0, [ui('u', 0, 'go'), gen('g1', 1, ['u'], {}, 'tool_use'), tc('a', 2, 'g1'), tc('b', 3, 'g1'), gen('g2', 4, ['a', 'b'], {}), tc('c', 5, 'g2')], 'g2');
    const rows = turnRows(t).map((r) => r.map((a) => a.id));
    expect(rows).toEqual([['u'], ['g1'], ['a', 'b'], ['g2'], ['c']]);
  });
  it('indexes seq numbers by action id', () => {
    const t = turn('S:t0', 0, [ui('u', 0, 'go'), gen('g1', 1, ['u'], {})], 'g1');
    expect(seqIndex(t).get('g1')).toBe(1);
  });
});

describe('conversationStats', () => {
  it('counts actions, sums tokens, derives hit rate and unfinished turns', () => {
    const c = conv([
      turn('S:t0', 0, [ui('u1', 0, 'a'), gen('g1', 1, ['u1'], { cache_read: 900, cache_write: 100, input: 0, output: 10 }, 'tool_use'), tc('t1', 2, 'g1')], null),
      turn('S:t1', 1, [ui('u2', 0, 'b', 'interrupt'), gen('g2', 1, ['u2'], { cache_read: 1000, input: 0, output: 5 })], 'g2'),
    ]);
    const s = conversationStats(c);
    expect(s).toMatchObject({ turns: 2, userInputs: 2, generations: 2, toolCalls: 1, unfinishedTurns: 1, generationsWithWire: 0, validationOk: true, durationMs: 5000 });
    expect(s.tokens).toEqual({ input: 0, output: 15, thinking: 0, cacheRead: 1900, cacheWrite: 100 });
    expect(s.cacheHitRate).toBeCloseTo(0.95, 3);
  });
  it('reports null hit rate when nothing was read or written', () => {
    expect(conversationStats(conv([])).cacheHitRate).toBeNull();
  });
});

describe('cacheDropIds', () => {
  it('flags a generation whose cache_read fell to 0 after a cached one, across turns', () => {
    const c = conv([
      turn('S:t0', 0, [ui('u1', 0, 'a'), gen('g1', 1, ['u1'], { cache_read: 0, cache_write: 500 })], 'g1'),
      turn('S:t1', 1, [ui('u2', 0, 'b'), gen('g2', 1, ['u2'], { cache_read: 500 }, 'tool_use'), tc('t', 2, 'g2'), gen('g3', 3, ['t'], { cache_read: 0, cache_write: 900 })], 'g3'),
      turn('S:t2', 2, [ui('u3', 0, 'c'), gen('g4', 1, ['u3'], { cache_read: null })], 'g4'),
    ]);
    expect([...cacheDropIds(c)]).toEqual(['g3']);
  });
});

describe('text helpers', () => {
  it('summarizes a turn by its first real user line, skipping injected blocks', () => {
    const t = turn('S:t0', 0, [ui('u', 0, '<system-reminder>\nstuff\n</system-reminder>\n  Fix the bug in foo.ts  \nmore')], null);
    expect(turnSummary(t)).toBe('Fix the bug in foo.ts');
    expect(turnSummary(turn('S:t1', 1, [ui('u', 0, 'x'.repeat(200))], null)).length).toBe(90);
    expect(turnSummary(turn('S:t2', 2, [], null))).toBe('');
  });
  it('picks the telling arg field, else falls back to raw text', () => {
    expect(argsSummary({ digest: '', length: 0, inline_text: '{"command":"git   status","description":"d"}' })).toBe('git status');
    expect(argsSummary({ digest: '', length: 0, inline_text: '{"file_path":"/a/b.ts"}' })).toBe('/a/b.ts');
    expect(argsSummary({ digest: '', length: 0, inline_text: '{"n": 3, "flag": true, "name": "x"}' })).toBe('x');
    expect(argsSummary({ digest: '', length: 0, inline_text: '{"command":"...[truncated]' })).toBe('{"command":"...[truncated]');
    expect(argsSummary(null)).toBe('');
  });
  it('formats tokens and durations compactly', () => {
    expect([fmtTokens(0), fmtTokens(999), fmtTokens(1234), fmtTokens(45678), fmtTokens(2_500_000), fmtTokens(null)]).toEqual(['0', '999', '1.2k', '46k', '2.50M', '–']);
    expect([fmtMs(12), fmtMs(1234), fmtMs(45_000), fmtMs(125_000), fmtMs(null)]).toEqual(['12ms', '1.2s', '45s', '2m05s', '–']);
  });
  it('splits the token bar into four fractions that sum to one', () => {
    const segs = tokenSegments({ input: 10, output: 20, thinking: null, cache_read: 60, cache_write: 10, cache_write_5m: null, cache_write_1h: null });
    // most expensive first: output, cache write, input, cache read
    expect(segs.map((s) => s.key)).toEqual(['output', 'cacheWrite', 'input', 'cacheRead']);
    expect(segs.reduce((n, s) => n + s.frac, 0)).toBeCloseTo(1, 9);
    expect(segs[3].frac).toBeCloseTo(0.6, 9);
    expect(tokenSegments({ input: null, output: null, thinking: null, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null }).every((s) => s.frac === 0)).toBe(true);
  });
});

describe('childrenByAction', () => {
  it('maps subagent conversations to the parent tool_call that spawned them', () => {
    const root = conv([]);
    const child = conv([], { id: 'agent-1', parent: { conversation_id: 'S', action_id: 'tA' }, agent_type: 'Explore', subagent_type: 'Explore' });
    const other = conv([], { id: 'agent-2', parent: { conversation_id: 'X', action_id: 'tB' } });
    const m = childrenByAction([root, child, other], 'S');
    expect([...m.keys()]).toEqual(['tA']);
    expect(m.get('tA')?.id).toBe('agent-1');
  });
});

describe('wire record helpers (web.ObserveTab wire detail)', () => {
  const events = [
    { t: 1.1, event: 'message_start', data: { type: 'message_start', message: { model: 'claude-fable-5-1', usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 31727 } } } },
    { t: 1.2, event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { t: 1.5, event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
    { t: 1.6, event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xxx' } } },
    { t: 1.7, event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { t: 2.1, event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
    { t: 2.2, event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hel' } } },
    { t: 2.3, event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } } },
    { t: 2.4, event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } } },
    { t: 2.5, event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":' } } },
    { t: 2.6, event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } } },
    { t: 2.7, event: 'ping', data: { type: 'ping' } },
    { t: 3.0, event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 209 } } },
    { t: 3.1, event: 'message_stop', data: { type: 'message_stop' } },
  ];

  it('rebuilds content blocks in order with assembled text and timing', () => {
    const blocks = sseBlocks(events);
    expect(blocks.map((b) => [b.index, b.type, b.name, b.text, b.deltas, b.t_start, b.t_end])).toEqual([
      [0, 'thinking', null, 'hmm', 2, 1.2, 1.7],
      [1, 'text', null, 'hello', 2, 2.1, 2.3],
      [2, 'tool_use', 'Bash', '{"command":"ls"}', 2, 2.4, 2.6],
    ]);
    expect(sseBlocks(null)).toEqual([]);
  });

  it('summarises events on one line', () => {
    expect(sseEventSummary(events[0])).toBe('claude-fable-5-1 · in 2 · cache r 0 · w 32k');
    expect(sseEventSummary(events[1])).toBe('#0 thinking');
    expect(sseEventSummary(events[3])).toBe('#0 signature_delta (signature)');
    expect(sseEventSummary(events[6])).toBe('#1 text_delta "hel"');
    expect(sseEventSummary(events[8])).toBe('#2 tool_use Bash');
    expect(sseEventSummary(events[11])).toBe('');
    expect(sseEventSummary(events[12])).toBe('stop tool_use · out 209');
  });

  it('normalises request content and picks the text of each block', () => {
    expect(contentBlocks('hi')).toEqual([{ type: 'text', text: 'hi' }]);
    expect(contentBlocks(null)).toEqual([]);
    expect(blockText({ type: 'text', text: 'x' })).toBe('x');
    expect(blockText({ type: 'tool_use', name: 'Bash', input: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(blockText({ type: 'tool_result', content: [{ type: 'text', text: 'r1' }, { type: 'text', text: 'r2' }] })).toBe('r1\nr2');
    expect(blockText({ type: 'tool_result', content: 'plain' })).toBe('plain');
  });

  it('keys a record by request_id first, then seq', () => {
    expect(wireKey({ request_id: 'req_1', seq: 2 })).toBe('req_1');
    expect(wireKey({ request_id: null, seq: 2 })).toBe('seq-2');
    expect(wireKey({ request_id: null, seq: null })).toBeNull();
    expect(wireKey(null)).toBeNull();
  });
});
