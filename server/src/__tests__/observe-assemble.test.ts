import { describe, expect, it } from 'vitest';
import { assembleSession, buildConversation, counts, validate } from '../observe/assemble.js';
import { mergeStreamedAssistant, parseJsonl, type ContentBlock, type TranscriptEntry } from '../observe/transcript.js';
import type { GenerationAction, ToolCallAction, UserInputAction } from '../observe/types.js';

// 手写 fixture：字段只保留装配用到的（design §2.5）。时间递增 1 秒方便算 latency。
let clock = Date.parse('2026-10-31T10:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();

const user = (uuid: string, content: string | ContentBlock[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  type: 'user',
  uuid,
  timestamp: ts(),
  message: { role: 'user', content },
  ...extra,
});

const assistant = (
  uuid: string,
  mid: string,
  content: ContentBlock[],
  opts: { stop?: string | null; usage?: Record<string, unknown>; requestId?: string; model?: string; time?: string } = {},
): TranscriptEntry => ({
  type: 'assistant',
  uuid,
  timestamp: opts.time ?? ts(),
  requestId: opts.requestId ?? `req_${uuid}`,
  effort: 'high',
  message: {
    id: mid,
    role: 'assistant',
    model: opts.model ?? 'claude-fable-5-1',
    stop_reason: opts.stop === undefined ? 'end_turn' : opts.stop,
    usage: opts.usage ?? {
      input_tokens: 3,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
      output_tokens_details: { thinking_tokens: 5 },
    },
    content,
  },
});

const toolUse = (id: string, name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id, name, input });
const toolResult = (tool_use_id: string, content: unknown, is_error = false): ContentBlock => ({ type: 'tool_result', tool_use_id, content, is_error });
const noise = (type: string): TranscriptEntry => ({ type, uuid: `${type}-x`, timestamp: ts() });

describe('mergeStreamedAssistant', () => {
  it('remembers the anchor of the first text block across merged lines', () => {
    const a = assistant('g1a', 'msg_1', [{ type: 'thinking', thinking: '' }], { stop: 'tool_use' });
    const b = assistant('g1b', 'msg_1', [{ type: 'text', text: 'hi' }], { stop: 'tool_use' });
    const merged = mergeStreamedAssistant([a, b]);
    expect(merged[0]._text_anchor).toEqual({ uuid: 'g1b', blockIdx: 0 });
    const conv = buildConversation([user('u1', 'x'), a, b], 'S');
    expect(conv.turns[0].actions[1].ref).toBe('a:g1b:0');
  });

  it('splits cache writes by TTL when usage.cache_creation is present', () => {
    const g = assistant('g1', 'msg_1', [{ type: 'text', text: 'hi' }], { usage: { input_tokens: 1, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } });
    const conv = buildConversation([user('u1', 'x'), g], 'S');
    expect((conv.turns[0].actions[1] as GenerationAction).result.tokens).toMatchObject({ cache_write: 30, cache_write_5m: 10, cache_write_1h: 20 });
  });

  it('merges thinking / text / tool_use lines with the same message.id and keeps the last usage', () => {
    const a = assistant('g1a', 'msg_1', [{ type: 'thinking', thinking: '' }], { stop: 'tool_use', usage: { output_tokens: 1 } });
    const b = assistant('g1b', 'msg_1', [{ type: 'text', text: 'hi' }], { stop: 'tool_use', usage: { output_tokens: 2 } });
    const c = assistant('g1c', 'msg_1', [toolUse('t1', 'Bash', { command: 'ls' })], { stop: 'tool_use', usage: { output_tokens: 3 } });
    const merged = mergeStreamedAssistant([a, b, c]);
    expect(merged).toHaveLength(1);
    expect(merged[0].uuid).toBe('g1a');
    expect((merged[0].message!.content as unknown[]).map((x: any) => x.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(merged[0].message!.usage).toEqual({ output_tokens: 3 });
    expect(merged[0]._ended_at).toBe(c.timestamp);
    // 不改调用方的对象
    expect((a.message!.content as unknown[]).length).toBe(1);
  });
});

describe('buildConversation', () => {
  it('builds one turn: user_input → generation → tool_call → generation(stop), with latency and tokens', () => {
    const entries = [
      noise('file-history-snapshot'),
      user('u1', 'list files'),
      assistant('g1', 'msg_1', [toolUse('t1', 'Bash', { command: 'ls' })], { stop: 'tool_use' }),
      noise('attachment'),
      user('u2', [toolResult('t1', 'a.txt\nb.txt')], { toolUseResult: {} }),
      assistant('g2', 'msg_2', [{ type: 'text', text: 'two files' }], { stop: 'end_turn' }),
    ];
    const conv = buildConversation(entries, 'S');
    expect(validate(conv)).toEqual([]);
    expect(conv.turns).toHaveLength(1);
    const t = conv.turns[0];
    expect(t.actions.map((a) => a.type)).toEqual(['user_input', 'generation', 'tool_call', 'generation']);
    expect(t.actions.map((a) => a.seq_no)).toEqual([0, 1, 2, 3]);
    expect(t.stop_action_id).toBe('g2');
    expect(t.started_at).toBe(entries[1].timestamp);
    expect(t.ended_at).toBe(entries[5].timestamp);

    const [ui, g1, tc, g2] = t.actions as [UserInputAction, GenerationAction, ToolCallAction, GenerationAction];
    expect(ui.payload).toMatchObject({ kind: 'new_task', source: 'human' });
    expect(ui.payload.content[0]).toMatchObject({ type: 'text', inline_text: 'list files', length: 10 });
    expect(g1.inputs).toEqual(['u1']);
    expect(g1.payload).toMatchObject({ model: 'claude-fable-5-1', request_id: 'req_g1', effort: 'high' });
    expect(g1.result.tokens).toEqual({ input: 3, output: 20, thinking: 5, cache_read: 1000, cache_write: 50, cache_write_5m: null, cache_write_1h: null });
    expect([ui.ref, g1.ref, tc.ref, g2.ref]).toEqual(['u:u1', 't:t1', 't:t1', 'a:g2:0']);
    expect(tc.inputs).toEqual(['g1']);
    expect(tc.payload.name).toBe('Bash');
    expect(tc.payload.args!.inline_text).toBe('{"command":"ls"}');
    expect(tc.result).toMatchObject({ status: 'success', latency_ms: 2000, spawned_conversation_id: null });
    expect(tc.result!.content!.inline_text).toBe('a.txt\nb.txt');
    expect(tc.ended_at).toBe(entries[4].timestamp);
    expect(g2.inputs).toEqual(['t1']);
    expect(g2.result.output_text!.inline_text).toBe('two files');
    expect(conv.model).toBe('claude-fable-5-1');
    expect(counts(conv)).toEqual({ turns: 1, user_inputs: 1, generations: 2, tool_calls: 1, unfinished_turns: 0 });
  });

  it('parallel tool calls: one generation fans out, all results fan into the next generation', () => {
    const entries = [
      user('u1', 'go'),
      assistant('g1', 'msg_1', [toolUse('t1', 'Read', { f: 1 }), toolUse('t2', 'Read', { f: 2 })], { stop: 'tool_use' }),
      user('r1', [toolResult('t1', 'one')]),
      user('r2', [toolResult('t2', [{ type: 'text', text: 'two' }], true)]),
      assistant('g2', 'msg_2', [{ type: 'text', text: 'done' }]),
    ];
    const conv = buildConversation(entries, 'S');
    expect(validate(conv)).toEqual([]);
    const acts = conv.turns[0].actions;
    expect(acts.map((a) => a.type)).toEqual(['user_input', 'generation', 'tool_call', 'tool_call', 'generation']);
    const g2 = acts[4] as GenerationAction;
    expect(g2.inputs).toEqual(['t1', 't2']);
    const t2 = acts[3] as ToolCallAction;
    expect(t2.result).toMatchObject({ status: 'error' });
    expect(t2.result!.content!.inline_text).toBe('two');
  });

  it('follow_up vs interrupt: a user text while the previous turn is still waiting marks interrupt and leaves stop null', () => {
    const entries = [
      user('u1', 'first'),
      assistant('g1', 'msg_1', [{ type: 'text', text: 'ok' }], { stop: 'end_turn' }),
      user('u2', 'second'),
      assistant('g2', 'msg_2', [toolUse('t1', 'Bash', {})], { stop: 'tool_use' }),
      // 工具结果没回来，用户直接又说话 → 打断
      user('u3', [{ type: 'text', text: 'stop that' }]),
      assistant('g3', 'msg_3', [{ type: 'text', text: 'stopped' }], { stop: 'end_turn' }),
    ];
    const conv = buildConversation(entries, 'S');
    expect(validate(conv)).toEqual([]);
    expect(conv.turns).toHaveLength(3);
    const kinds = conv.turns.map((t) => (t.actions[0] as UserInputAction).payload.kind);
    expect(kinds).toEqual(['new_task', 'follow_up', 'interrupt']);
    expect(conv.turns.map((t) => t.stop_action_id)).toEqual(['g1', null, 'g3']);
    expect(counts(conv).unfinished_turns).toBe(1);
  });

  it('a mixed user line (tool_result + text) backfills the result first, then opens a new turn', () => {
    const entries = [
      user('u1', 'first'),
      assistant('g1', 'msg_1', [toolUse('t1', 'Bash', {})], { stop: 'tool_use' }),
      user('u2', [toolResult('t1', 'out'), { type: 'text', text: 'and now this' }]),
      assistant('g2', 'msg_2', [{ type: 'text', text: 'ok' }]),
    ];
    const conv = buildConversation(entries, 'S');
    expect(validate(conv)).toEqual([]);
    expect(conv.turns).toHaveLength(2);
    const t1 = conv.turns[0].actions[1 + 1] as ToolCallAction;
    expect(t1.result?.status).toBe('success');
    // 新 Turn 的 generation 消费 user_input，而不是刚回来的 tool_call
    expect(conv.turns[1].actions[1].inputs).toEqual(['u2']);
    expect((conv.turns[1].actions[0] as UserInputAction).payload.kind).toBe('interrupt');
  });

  it('a turn whose last action is a tool_call without result has no stop (still running / crashed)', () => {
    const entries = [user('u1', 'go'), assistant('g1', 'msg_1', [toolUse('t1', 'Bash', {})], { stop: 'tool_use' })];
    const conv = buildConversation(entries, 'S');
    expect(conv.turns[0].stop_action_id).toBeNull();
    expect((conv.turns[0].actions[2] as ToolCallAction).result).toBeNull();
    expect(validate(conv)).toEqual([]);
  });

  it('assistant before any user_input gets a synthetic user_input so rule 1 still holds', () => {
    const conv = buildConversation([assistant('g1', 'msg_1', [{ type: 'text', text: 'hi' }])], 'S');
    const ui = conv.turns[0].actions[0] as UserInputAction;
    expect(ui.id).toBe('S:missing-input-0');
    expect(ui.payload.synthetic).toBe(true);
    expect(conv.turns[0].actions[1].inputs).toEqual(['S:missing-input-0']);
    expect(validate(conv)).toEqual([]);
  });

  it('ignores stray tool_results for unknown tool_use ids and non user/assistant lines', () => {
    const conv = buildConversation([user('u1', 'go'), user('r', [toolResult('nope', 'x')]), noise('queue-operation')], 'S');
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].actions).toHaveLength(1);
  });
});

describe('validate', () => {
  it('reports the three rules and dangling inputs', () => {
    const conv = buildConversation([user('u1', 'go'), assistant('g1', 'msg_1', [toolUse('t1', 'Bash', {})], { stop: 'tool_use' })], 'S');
    const acts = conv.turns[0].actions;
    acts[1].inputs = ['ghost'];
    acts[2].inputs = ['u1'];
    conv.turns.push({ id: 'S:t1', seq_no: 1, actions: [], stop_action_id: null, started_at: null, ended_at: null });
    conv.turns.push({ id: 'S:t2', seq_no: 2, actions: [{ ...acts[1], id: 'g9', inputs: [] }], stop_action_id: null, started_at: null, ended_at: null });
    const rules = validate(conv).map((i) => i.rule);
    expect(rules).toEqual(['dangling_input', 'generation_inputs', 'tool_call_inputs', 'empty_turn', 'first_action_not_user_input', 'generation_inputs']);
  });
});

describe('assembleSession (subagents)', () => {
  it('links a subagent transcript to its parent tool_call and uses its own first user line as parent_agent input', () => {
    const main = [
      user('u1', 'delegate'),
      assistant('g1', 'msg_1', [toolUse('tA', 'Agent', { prompt: 'find things', description: 'd' })], { stop: 'tool_use' }),
      user('r1', [toolResult('tA', 'agent said: found')]),
      assistant('g2', 'msg_2', [{ type: 'text', text: 'summary' }]),
    ];
    const sub = [
      user('su1', 'find things', { isSidechain: true }),
      assistant('sg1', 'msg_s1', [toolUse('st1', 'Grep', { q: 'x' })], { stop: 'tool_use', model: 'claude-haiku-5-5' }),
      user('sr1', [toolResult('st1', 'hit')]),
      assistant('sg2', 'msg_s2', [{ type: 'text', text: 'found' }], { model: 'claude-haiku-5-5' }),
    ];
    const convs = assembleSession('S', main, [{ agentId: 'agent-abc', meta: { toolUseId: 'tA', agentType: 'Explore' }, entries: sub }]);
    expect(convs).toHaveLength(2);
    const [root, child] = convs;
    expect(root.root_conversation_id).toBe('S');
    expect(root.parent).toBeNull();
    const tA = root.turns[0].actions[2] as ToolCallAction;
    expect(tA.result?.spawned_conversation_id).toBe('agent-abc');
    expect(tA.result?.content?.inline_text).toBe('agent said: found');

    expect(child.id).toBe('agent-abc');
    expect(child.parent).toEqual({ conversation_id: 'S', action_id: 'tA' });
    expect(child.root_conversation_id).toBe('S');
    expect(child.agent_type).toBe('Explore');
    expect(child.subagent_type).toBe('Explore');
    expect(child.model).toBe('claude-haiku-5-5');
    expect(child.meta).toMatchObject({ toolUseId: 'tA', agentType: 'Explore', validation: { ok: true, issues: [] } });
    const first = child.turns[0].actions[0] as UserInputAction;
    expect(first.id).toBe('su1');
    expect(first.payload).toMatchObject({ source: 'parent_agent', kind: 'new_task' });
    expect(first.payload.content[0]).toMatchObject({ inline_text: 'find things' });
    expect(child.turns[0].actions).toHaveLength(4);
    expect(root.meta.validation).toEqual({ ok: true, issues: [] });
  });

  it('synthesizes the spawn user_input from the parent Agent args when the sub transcript has no leading user text', () => {
    const main = [user('u1', 'go'), assistant('g1', 'msg_1', [toolUse('tA', 'Agent', { prompt: 'do it' })], { stop: 'tool_use' })];
    const sub = [assistant('sg1', 'msg_s1', [{ type: 'text', text: 'did it' }])];
    const [root, child] = assembleSession('S', main, [{ agentId: 'agent-x', meta: { toolUseId: 'tA' }, entries: sub }]);
    const first = child.turns[0].actions[0] as UserInputAction;
    expect(first.id).toBe('agent-x:spawn');
    expect(first.payload.source).toBe('parent_agent');
    expect(first.payload.content[0]).toMatchObject({ inline_text: 'do it' });
    expect(child.turns[0].actions[1].inputs).toEqual(['agent-x:spawn']);
    expect(child.agent_type).toBe('claude');
    // 父 tool_call 还没有结果，也要挂上 spawned_conversation_id
    const tA = root.turns[0].actions[2] as ToolCallAction;
    expect(tA.result).toEqual({ status: null, content: null, latency_ms: null, spawned_conversation_id: 'agent-x' });
    expect(validate(child)).toEqual([]);
  });
});

describe('parseJsonl', () => {
  it('skips blank and truncated lines', () => {
    const text = '{"type":"user","uuid":"a"}\n\n{"type":"assistant","uuid":"b"}\n{"type":"user","uu';
    expect(parseJsonl(text).map((e) => e.uuid)).toEqual(['a', 'b']);
  });
});
