import { describe, expect, it } from 'vitest';
import { assembleDevinSession, buildDevinConversation, chainTo, mainChainHead, type DevinNode, type DevinSessionData, type DevinSessionRow } from '../observe/devin-adapter.js';
import type { GenerationAction, ToolCallAction, UserInputAction } from '../observe/types.js';

// Hand-written message_nodes forest (facts: design.md §2.6). Node ids are the
// forest's; the main chain is 30 → … → 20.
const session: DevinSessionRow = {
  id: 'thread-x', working_directory: '/w', model: 'claude-fable-5-1-medium', agent_mode: 'bypass', title: 't',
  created_at: 1793400000, last_activity_at: 1793400100, main_chain_id: 30, backend_type: 'windsurf', metadata: '{"total_acu_cost":0.5}',
};
const T = (s: number) => new Date(1793400000000 + s * 1000).toISOString();
const sys = (id: number, parent: number | null, ext?: any): DevinNode => ({ node_id: id, parent_node_id: parent, msg: { role: 'system', content: 'sys', metadata: { created_at: T(id), extensions: ext } } });
const user = (id: number, parent: number, text: string, input = true): DevinNode => ({ node_id: id, parent_node_id: parent, msg: { message_id: `u${id}`, role: 'user', content: text, metadata: { is_user_input: input ? true : null, created_at: T(id) } } });
const asst = (id: number, parent: number, o: { text?: string; tools?: Array<{ id: string; name: string; args?: any; kind?: string; title?: string }>; finish?: string | null; metrics?: any; thinking?: string }): DevinNode => ({
  node_id: id, parent_node_id: parent,
  msg: {
    message_id: `a${id}`, role: 'assistant', content: o.text ?? '',
    tool_calls: (o.tools ?? []).map((t) => ({ id: t.id, name: t.name, arguments: t.args ?? {} })),
    thinking: o.thinking ? { thinking: o.thinking, signature: 'x' } : undefined,
    metadata: {
      request_id: `rq${id}`, finish_reason: o.finish === undefined ? (o.tools?.length ? 'tool_calls' : 'stop') : o.finish,
      metrics: o.metrics ?? { ttft_ms: 500, total_time_ms: 2000, input_tokens: 10, output_tokens: 20, cache_read_tokens: 1000, cache_creation_tokens: 50 },
      generation_model: 'claude-fable-5-1-medium', started_generation_at: T(id - 0.5), created_at: T(id),
      extensions: { 'chisel/tool_call_content': Object.fromEntries((o.tools ?? []).map((t) => [t.id, { title: t.title ?? t.name, kind: t.kind ?? 'other' }])) },
    },
  },
});
const tool = (id: number, parent: number, callId: string, content: string, o: { success?: boolean; ms?: number; ext?: any } = {}): DevinNode => ({
  node_id: id, parent_node_id: parent,
  msg: {
    message_id: `t${id}`, role: 'tool', tool_call_id: callId, content,
    metadata: { created_at: T(id), extensions: { 'chisel/tool_result_meta': { success: o.success ?? true, kind: 'other' }, 'chisel/tool_call_timing': { started_at: T(id - 0.8), finished_at: T(id - 0.1), duration_ms: o.ms ?? 700 }, ...(o.ext ?? {}) } },
  },
});

function data(nodes: DevinNode[], over: Partial<DevinSessionRow> = {}): DevinSessionData {
  return { session: { ...session, ...over }, nodes: new Map(nodes.map((n) => [n.node_id, n])), toolState: new Map() };
}

describe('chainTo / mainChainHead', () => {
  it('walks parent links from the head and ignores nodes off the chain', () => {
    const d = data([sys(1, null), user(2, 1, 'old'), sys(20, null), user(21, 20, 'new'), asst(30, 21, { text: 'hi' })]);
    expect(chainTo(d.nodes, mainChainHead(d)).map((n) => n.node_id)).toEqual([20, 21, 30]);
    expect(mainChainHead(data([sys(1, null), user(2, 1, 'x')], { main_chain_id: null }))).toBe(2);
  });
});

describe('buildDevinConversation', () => {
  it('maps user_input / generation / tool_call with Devin metrics, timing, kind, title and exact tool latency', () => {
    const chain = [
      sys(20, null),
      user(21, 20, 'do it'),
      asst(22, 21, { tools: [{ id: 'c1', name: 'exec', args: { command: 'ls' }, kind: 'execute', title: 'Ran ls' }, { id: 'c2', name: 'read', args: '{"path":"/a"}', kind: 'read' }], thinking: 'plan' }),
      tool(23, 22, 'c1', 'out1', { ms: 120 }),
      tool(24, 23, 'c2', 'out2', { success: false }),
      asst(25, 24, { text: 'done' }),
    ];
    const { conv } = buildDevinConversation(chain, 'thread-x', session, new Map());
    expect(conv.meta.validation).toBeUndefined();
    expect(conv.agent_type).toBe('devin');
    expect(conv.model).toBe('claude-fable-5-1-medium');
    expect(conv.turns).toHaveLength(1);
    const acts = conv.turns[0].actions;
    expect(acts.map((a) => a.type)).toEqual(['user_input', 'generation', 'tool_call', 'tool_call', 'generation']);
    expect(conv.turns[0].stop_action_id).toBe('a25');
    const g = acts[1] as GenerationAction;
    expect(g.inputs).toEqual(['u21']);
    expect(g.payload).toEqual({ model: 'claude-fable-5-1-medium', request_id: 'rq22', effort: null });
    expect(g.result.stop_reason).toBe('tool_use');
    expect(g.result.tokens).toEqual({ input: 10, output: 20, thinking: null, cache_read: 1000, cache_write: 50, cache_write_5m: null, cache_write_1h: null });
    expect([acts[0].ref, g.ref, acts[2].ref]).toEqual(['n:21', 'n:22', 't:c1']);
    expect(g.result.timing).toEqual({ ttft_ms: 500, total_ms: 2000 });
    expect(g.result.thinking?.inline_text).toBe('plan');
    expect(g.started_at).toBe(T(21.5));
    const c1 = acts[2] as ToolCallAction;
    expect(c1.payload).toEqual({ name: 'exec', args: expect.objectContaining({ inline_text: '{"command":"ls"}' }), title: 'Ran ls', kind: 'execute' });
    expect(c1.result).toEqual({ status: 'success', content: expect.objectContaining({ inline_text: 'out1' }), latency_ms: 120, spawned_conversation_id: null });
    expect(c1.started_at).toBe(T(22.2));
    expect(c1.ended_at).toBe(T(22.9));
    const c2 = acts[3] as ToolCallAction;
    expect(c2.payload.args?.inline_text).toBe('{"path":"/a"}');
    expect(c2.result?.status).toBe('error');
    expect((acts[4] as GenerationAction).inputs).toEqual(['c1', 'c2']);
    expect((acts[4] as GenerationAction).result.stop_reason).toBe('end_turn');
  });

  it('skips injected user messages, system nodes and orphan tool results; marks compaction summaries', () => {
    const chain = [
      sys(20, null),
      sys(21, 20, { 'devin-rs/summary': { source: 'x' } }),
      user(22, 21, 'rules', false),
      tool(23, 22, 'ghost', 'stale result'),
      asst(24, 23, { text: 'continuing' }),
      user(25, 24, 'next'),
      asst(26, 25, { text: 'ok' }),
    ];
    const { conv } = buildDevinConversation(chain, 'thread-x', session, new Map());
    expect(conv.turns).toHaveLength(2);
    const first = conv.turns[0].actions[0] as UserInputAction;
    expect(first.payload.synthetic).toBe(true);
    expect(conv.turns[0].actions[1].inputs).toEqual([first.id]);
    expect((conv.turns[1].actions[0] as UserInputAction).payload.kind).toBe('follow_up');
    expect(conv.meta.devin).toMatchObject({ chain_nodes: 7, injected_user_messages: 1, orphan_tool_results: 1, compactions: [{ node_id: 21 }] });
  });

  it('infers stop for rows without finish_reason and marks an interrupt when a turn is cut', () => {
    const chain = [
      sys(20, null),
      user(21, 20, 'a'),
      asst(22, 21, { tools: [{ id: 'c1', name: 'exec' }], finish: null }),
      user(23, 22, 'stop that'),
      asst(24, 23, { text: 'ok', finish: null }),
    ];
    const { conv } = buildDevinConversation(chain, 'thread-x', session, new Map());
    expect((conv.turns[0].actions[1] as GenerationAction).result.stop_reason).toBe('tool_use');
    expect(conv.turns[0].stop_action_id).toBeNull();
    expect((conv.turns[1].actions[0] as UserInputAction).payload.kind).toBe('interrupt');
    expect(conv.turns[1].stop_action_id).toBe('a24');
  });

  it('falls back to tool_call_state for status when the tool node carries no result meta', () => {
    const t = tool(23, 22, 'c1', 'x');
    delete t.msg.metadata.extensions['chisel/tool_result_meta'];
    const chain = [sys(20, null), user(21, 20, 'a'), asst(22, 21, { tools: [{ id: 'c1', name: 'exec' }] }), t, asst(24, 23, { text: 'ok' })];
    const state = new Map([['c1', { call: null, update: { status: 'failed' } }]]);
    const { conv } = buildDevinConversation(chain, 'thread-x', session, state);
    expect((conv.turns[0].actions[2] as ToolCallAction).result?.status).toBe('error');
  });
});

describe('assembleDevinSession', () => {
  it('builds the root from the main chain and children from subagent/chain_node_id, linking both ways', () => {
    const nodes = [
      // subagent chain (its own root in the forest)
      sys(40, null),
      user(41, 40, 'task text'),
      asst(42, 41, { tools: [{ id: 's1', name: 'read' }] }),
      tool(43, 42, 's1', 'file'),
      asst(44, 43, { text: 'report' }),
      // main chain
      sys(20, null),
      user(21, 20, 'delegate'),
      asst(22, 21, { tools: [{ id: 'c1', name: 'run_subagent', args: { task: 'task text' } }] }),
      tool(23, 22, 'c1', 'Subagent done', { ext: { 'subagent/agent_id': 'ab12', 'subagent/chain_node_id': 44, 'subagent/profile_name': 'General', 'subagent/model': 'Claude Opus 4.6' } }),
      asst(30, 23, { text: 'summary' }),
    ];
    const convs = assembleDevinSession(data(nodes));
    expect(convs.map((c) => c.id)).toEqual(['thread-x', 'thread-x:agent-ab12']);
    const [root, child] = convs;
    expect(root.meta).toMatchObject({ title: 't', agent_mode: 'bypass', nodes_total: 10, main_chain_id: 30, cost: { total_acu_cost: 0.5 }, validation: { ok: true } });
    const tc = root.turns[0].actions[2] as ToolCallAction;
    expect(tc.result?.spawned_conversation_id).toBe('thread-x:agent-ab12');
    expect(child.parent).toEqual({ conversation_id: 'thread-x', action_id: 'c1' });
    expect(child.root_conversation_id).toBe('thread-x');
    expect(child.subagent_type).toBe('General');
    expect(child.model).toBe('Claude Opus 4.6');
    expect(child.meta).toMatchObject({ agent_id: 'ab12', chain_node_id: 44, validation: { ok: true } });
    const first = child.turns[0].actions[0] as UserInputAction;
    expect(first.payload).toMatchObject({ source: 'parent_agent', kind: 'new_task' });
    expect(first.payload.content[0]).toMatchObject({ inline_text: 'task text' });
    expect(child.turns[0].actions).toHaveLength(4);
  });
});
