// Model: server.AssembleObservation (kind=devin) — assemble a Devin CLI session
// from its own sessions.db into the same Conversation / Turn / Action shape.
// Facts about the store: projects/aie-observe/design.md §2.6.
//
// Pure part: buildDevinConversation / assembleDevinSession take rows already
// read from the DB. readDevinSession does the SQL. assembleDevinObservation
// glues them for the route.

import type { DatabaseSync } from 'node:sqlite';
import { openDevinDb } from '../devin-db.js';
import type { Action, Conversation, ConversationMeta, ConversationParent, GenerationAction, ToolCallAction, Turn, UserInputAction, UserInputKind, UserInputSource } from './types.js';
import { OBSERVATION_SCHEMA } from './types.js';
import { TERMINAL_STOP_REASONS, textField, validate } from './assemble.js';
import type { AssembledSession } from './index.js';

export interface DevinSessionRow {
  id: string;
  working_directory: string;
  model: string;
  agent_mode: string;
  title: string | null;
  created_at: number; // unix seconds
  last_activity_at: number; // unix seconds
  main_chain_id: number | null;
  backend_type: string | null;
  metadata: string | null;
}

export interface DevinNode {
  node_id: number;
  parent_node_id: number | null;
  /** parsed chat_message */
  msg: any;
}

export interface DevinToolState {
  call: any | null;
  update: any | null;
}

export interface DevinSessionData {
  session: DevinSessionRow;
  nodes: Map<number, DevinNode>;
  toolState: Map<string, DevinToolState>;
}

const MAX_SUBAGENT_DEPTH = 3;

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

export function readDevinSession(sessionId: string, db: DatabaseSync): DevinSessionData | null {
  const session = db
    .prepare('SELECT id, working_directory, model, agent_mode, title, created_at, last_activity_at, main_chain_id, backend_type, metadata FROM sessions WHERE id = ? LIMIT 1')
    .get(sessionId) as DevinSessionRow | undefined;
  if (!session) return null;
  const nodes = new Map<number, DevinNode>();
  const rows = db.prepare('SELECT node_id, parent_node_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY node_id').all(sessionId) as Array<{ node_id: number; parent_node_id: number | null; chat_message: string }>;
  for (const r of rows) {
    let msg: any;
    try {
      msg = JSON.parse(r.chat_message);
    } catch {
      continue;
    }
    nodes.set(r.node_id, { node_id: r.node_id, parent_node_id: r.parent_node_id, msg });
  }
  const toolState = new Map<string, DevinToolState>();
  const ts = db.prepare('SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?').all(sessionId) as Array<{ tool_call_id: string; tool_call_json: string | null; tool_call_update_json: string | null }>;
  for (const t of ts) {
    const parse = (x: string | null) => {
      if (!x) return null;
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    };
    toolState.set(t.tool_call_id, { call: parse(t.tool_call_json), update: parse(t.tool_call_update_json) });
  }
  return { session, nodes, toolState };
}

/** Cheap change signature for the ETag: activity time, chain head, node count. */
export function devinSessionSignature(sessionId: string, db: DatabaseSync): { cwd: string; etag: string } | null {
  const row = db
    .prepare('SELECT working_directory, last_activity_at, main_chain_id, (SELECT COUNT(*) FROM message_nodes WHERE session_id = s.id) AS n, (SELECT COUNT(*) FROM tool_call_state WHERE session_id = s.id) AS t FROM sessions s WHERE id = ? LIMIT 1')
    .get(sessionId) as { working_directory: string; last_activity_at: number; main_chain_id: number | null; n: number; t: number } | undefined;
  if (!row) return null;
  return { cwd: row.working_directory, etag: `"devin-${row.last_activity_at}-${row.main_chain_id ?? 'x'}-${row.n}-${row.t}"` };
}

// ---------------------------------------------------------------------------
// chain walking
// ---------------------------------------------------------------------------

/** Nodes from the root down to `head` (ascending). Cycles / missing parents stop the walk. */
export function chainTo(nodes: Map<number, DevinNode>, head: number | null): DevinNode[] {
  const out: DevinNode[] = [];
  const seen = new Set<number>();
  let cur = head;
  while (cur != null && !seen.has(cur)) {
    const n = nodes.get(cur);
    if (!n) break;
    seen.add(cur);
    out.push(n);
    cur = n.parent_node_id;
  }
  return out.reverse();
}

/** main_chain_id, falling back to the highest node id (what devin.ts's transcript reader uses). */
export function mainChainHead(data: DevinSessionData): number | null {
  if (data.session.main_chain_id != null && data.nodes.has(data.session.main_chain_id)) return data.session.main_chain_id;
  let max: number | null = null;
  for (const id of data.nodes.keys()) if (max === null || id > max) max = id;
  return max;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function ext(msg: any, key: string): any {
  return msg?.metadata?.extensions?.[key];
}

function toolStatus(msg: any, state: DevinToolState | undefined): 'success' | 'error' | null {
  const meta = ext(msg, 'chisel/tool_result_meta');
  if (meta && typeof meta.success === 'boolean') return meta.success ? 'success' : 'error';
  if (ext(msg, 'chisel/tool_failure')) return 'error';
  const st = state?.update?.status;
  if (st === 'failed') return 'error';
  if (st === 'completed') return 'success';
  return null;
}

function stopReasonOf(msg: any): string | null {
  const fr = msg?.metadata?.finish_reason;
  if (fr === 'stop') return 'end_turn';
  if (fr === 'tool_calls') return 'tool_use';
  if (typeof fr === 'string' && fr) return fr;
  // Older rows have no finish_reason: infer from the shape.
  return Array.isArray(msg?.tool_calls) && msg.tool_calls.length ? 'tool_use' : 'end_turn';
}

function argsText(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args));
    } catch {
      return args;
    }
  }
  return JSON.stringify(args ?? {});
}

export interface DevinBuildOptions {
  parent?: ConversationParent | null;
  subagentType?: string | null;
  model?: string | null;
  meta?: ConversationMeta;
}

export interface SubagentLink {
  toolCallId: string;
  chainHead: number;
  agentId: string | null;
  profile: string | null;
  model: string | null;
}

/**
 * One chain (root → head) → one Conversation. Returns the subagent links found
 * on the way so the caller can build child conversations from the same forest.
 */
export function buildDevinConversation(
  chain: DevinNode[],
  convId: string,
  session: DevinSessionRow,
  toolState: Map<string, DevinToolState>,
  opts: DevinBuildOptions = {},
): { conv: Conversation; subagents: SubagentLink[] } {
  const parent = opts.parent ?? null;
  const turns: Turn[] = [];
  const actionsById = new Map<string, Action>();
  let cur = null as Turn | null;
  let convModel: string | null = opts.model ?? null;
  let pendingUserInputId: string | null = null;
  let pendingToolCallIds: string[] = [];
  let spawnPending = parent !== null;
  const subagents: SubagentLink[] = [];
  const compactions: Array<{ node_id: number; at: string | null }> = [];
  let injectedUserMessages = 0;
  let orphanToolResults = 0;

  const addAction = (a: Action) => {
    a.seq_no = cur!.actions.length;
    cur!.actions.push(a);
    actionsById.set(a.id, a);
    const t = a.ended_at ?? a.started_at;
    if (t) cur!.ended_at = t;
  };
  const newTurn = (first: Action) => {
    cur = { id: `${convId}:t${turns.length}`, seq_no: turns.length, actions: [], stop_action_id: null, started_at: first.started_at, ended_at: null };
    turns.push(cur);
    addAction(first);
  };
  const previousTurnUnfinished = (): boolean => {
    if (!cur || !cur.actions.length) return false;
    const last = cur.actions[cur.actions.length - 1];
    if (last.type === 'generation') return !TERMINAL_STOP_REASONS.has(last.result.stop_reason ?? '');
    return last.type === 'tool_call';
  };

  for (const node of chain) {
    const msg = node.msg;
    const role = msg?.role;
    const createdAt: string | null = msg?.metadata?.created_at ?? null;

    if (role === 'system') {
      if (ext(msg, 'devin-rs/summary')) compactions.push({ node_id: node.node_id, at: createdAt });
      continue;
    }

    if (role === 'user') {
      if (msg?.metadata?.is_user_input !== true) {
        injectedUserMessages++;
        continue;
      }
      const uid: string = msg.message_id ?? `${convId}:n${node.node_id}`;
      const kind: UserInputKind = !turns.length ? 'new_task' : previousTurnUnfinished() ? 'interrupt' : 'follow_up';
      const source: UserInputSource = spawnPending && !turns.length ? 'parent_agent' : 'human';
      spawnPending = false;
      const text = typeof msg.content === 'string' ? msg.content : '';
      const ui: UserInputAction = {
        id: uid,
        seq_no: 0,
        type: 'user_input',
        inputs: [],
        payload: { content: text ? [{ type: 'text', ...textField(text)! }] : [], kind, source },
        result: null,
        ref: `n:${node.node_id}`,
        started_at: createdAt,
        ended_at: createdAt,
      };
      newTurn(ui);
      pendingUserInputId = uid;
      pendingToolCallIds = [];
      continue;
    }

    if (role === 'assistant') {
      const m = msg.metadata ?? {};
      const metrics = m.metrics ?? {};
      const model: string | null = m.generation_model ?? opts.model ?? session.model ?? null;
      if (!convModel) convModel = model;
      const genId: string = msg.message_id ?? `${convId}:n${node.node_id}`;
      let inputs: string[];
      if (pendingToolCallIds.length) {
        inputs = pendingToolCallIds;
        pendingToolCallIds = [];
      } else if (pendingUserInputId) {
        inputs = [pendingUserInputId];
        pendingUserInputId = null;
      } else {
        inputs = [];
      }
      const gen: GenerationAction = {
        id: genId,
        seq_no: 0,
        type: 'generation',
        inputs,
        payload: { model, request_id: m.request_id ?? null, effort: null },
        result: {
          output_text: textField(typeof msg.content === 'string' ? msg.content : ''),
          thinking: textField(typeof msg.thinking?.thinking === 'string' ? msg.thinking.thinking : ''),
          stop_reason: stopReasonOf(msg),
          tokens: {
            input: metrics.input_tokens ?? null,
            output: metrics.output_tokens ?? null,
            thinking: null,
            cache_read: metrics.cache_read_tokens ?? null,
            cache_write: metrics.cache_creation_tokens ?? null,
            cache_write_5m: null,
            cache_write_1h: null,
          },
          timing: { ttft_ms: metrics.ttft_ms ?? null, total_ms: metrics.total_time_ms ?? null },
        },
        ref: `n:${node.node_id}`,
        started_at: m.started_generation_at ?? createdAt,
        ended_at: createdAt,
      };
      if (!cur) {
        // Chain starts mid-conversation (compaction) or a stray assistant: synthetic placeholder keeps rule 1.
        const ui: UserInputAction = {
          id: `${convId}:missing-input-${turns.length}`,
          seq_no: 0,
          type: 'user_input',
          inputs: [],
          payload: { content: [], kind: 'new_task', source: 'human', synthetic: true },
          result: null,
          ref: null,
          started_at: gen.started_at,
          ended_at: gen.started_at,
        };
        newTurn(ui);
        gen.inputs = [ui.id];
      }
      addAction(gen);
      const content: Record<string, any> = ext(msg, 'chisel/tool_call_content') ?? {};
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        if (!tc || typeof tc.id !== 'string') continue;
        const c = content[tc.id] ?? toolState.get(tc.id)?.call ?? {};
        const a: ToolCallAction = {
          id: tc.id,
          seq_no: 0,
          type: 'tool_call',
          inputs: [genId],
          payload: { name: tc.name ?? null, args: textField(argsText(tc.arguments)), title: c.title ?? null, kind: c.kind ?? tc.kind ?? null },
          result: null,
          ref: `t:${tc.id}`,
          started_at: createdAt,
          ended_at: null,
        };
        addAction(a);
      }
      continue;
    }

    if (role === 'tool') {
      const tid: string | undefined = msg.tool_call_id;
      const tc = tid ? actionsById.get(tid) : undefined;
      if (!tc || tc.type !== 'tool_call') {
        orphanToolResults++;
        continue;
      }
      const timing = ext(msg, 'chisel/tool_call_timing') ?? {};
      if (timing.started_at) tc.started_at = timing.started_at;
      const endedAt: string | null = timing.finished_at ?? createdAt;
      let latency: number | null = typeof timing.duration_ms === 'number' ? timing.duration_ms : null;
      if (latency === null && tc.started_at && endedAt) {
        const d = Date.parse(endedAt) - Date.parse(tc.started_at);
        if (!Number.isNaN(d) && d >= 0) latency = d;
      }
      tc.result = {
        status: toolStatus(msg, toolState.get(tid!)),
        content: textField(typeof msg.content === 'string' ? msg.content : ''),
        latency_ms: latency,
        spawned_conversation_id: tc.result?.spawned_conversation_id ?? null,
      };
      tc.ended_at = endedAt;
      if (cur) cur.ended_at = endedAt;
      pendingToolCallIds.push(tid!);
      const chainHead = ext(msg, 'subagent/chain_node_id');
      if (typeof chainHead === 'number') {
        subagents.push({
          toolCallId: tid!,
          chainHead,
          agentId: ext(msg, 'subagent/agent_id') ?? null,
          profile: ext(msg, 'subagent/profile_name') ?? null,
          model: ext(msg, 'subagent/model') ?? null,
        });
      }
      continue;
    }
  }

  for (const t of turns) {
    if (!t.actions.length) continue;
    const last = t.actions[t.actions.length - 1];
    if (last.type === 'generation' && TERMINAL_STOP_REASONS.has(last.result.stop_reason ?? '')) t.stop_action_id = last.id;
    t.started_at = t.actions[0].started_at;
    let ended: string | null = null;
    for (const a of t.actions) {
      const e = a.ended_at ?? a.started_at;
      if (e && (!ended || Date.parse(e) > Date.parse(ended))) ended = e;
    }
    t.ended_at = ended;
  }

  const conv: Conversation = {
    schema: OBSERVATION_SCHEMA,
    id: convId,
    parent,
    root_conversation_id: parent?.conversation_id ?? convId,
    agent_type: 'devin',
    subagent_type: opts.subagentType ?? null,
    model: convModel ?? session.model ?? null,
    started_at: turns[0]?.started_at ?? null,
    ended_at: turns.length ? turns[turns.length - 1].ended_at : null,
    turns,
    wire_orphans: [],
    meta: {
      ...(opts.meta ?? {}),
      devin: {
        chain_nodes: chain.length,
        compactions,
        injected_user_messages: injectedUserMessages,
        orphan_tool_results: orphanToolResults,
      },
    },
  };
  return { conv, subagents };
}

/** Root conversation from the main chain + one child per subagent chain found in the forest. */
export function assembleDevinSession(data: DevinSessionData): Conversation[] {
  const { session, nodes, toolState } = data;
  let sessionMeta: Record<string, unknown> = {};
  try {
    sessionMeta = session.metadata ? JSON.parse(session.metadata) : {};
  } catch {
    // ignore
  }
  const head = mainChainHead(data);
  const root = buildDevinConversation(chainTo(nodes, head), session.id, session, toolState, {
    model: session.model,
    meta: {
      title: session.title,
      agent_mode: session.agent_mode,
      backend: session.backend_type,
      created_at: new Date(session.created_at * 1000).toISOString(),
      last_activity_at: new Date(session.last_activity_at * 1000).toISOString(),
      nodes_total: nodes.size,
      main_chain_id: head,
      cost: sessionMeta,
    },
  });
  if (!root.conv.started_at) root.conv.started_at = new Date(session.created_at * 1000).toISOString();
  const convs: Conversation[] = [root.conv];
  const seenHeads = new Set<number>();

  const expand = (links: SubagentLink[], parentConv: Conversation, depth: number) => {
    if (depth > MAX_SUBAGENT_DEPTH) return;
    for (const link of links) {
      if (seenHeads.has(link.chainHead)) continue;
      seenHeads.add(link.chainHead);
      const childId = `${session.id}:agent-${link.agentId ?? link.chainHead}`;
      const child = buildDevinConversation(chainTo(nodes, link.chainHead), childId, session, toolState, {
        parent: { conversation_id: parentConv.id, action_id: link.toolCallId },
        subagentType: link.profile ?? 'subagent',
        model: link.model ?? session.model,
        meta: { agent_id: link.agentId, chain_node_id: link.chainHead },
      });
      child.conv.root_conversation_id = session.id;
      for (const t of parentConv.turns) {
        for (const a of t.actions) {
          if (a.type === 'tool_call' && a.id === link.toolCallId) {
            a.result ??= { status: null, content: null, latency_ms: null, spawned_conversation_id: null };
            a.result.spawned_conversation_id = childId;
          }
        }
      }
      convs.push(child.conv);
      expand(child.subagents, child.conv, depth + 1);
    }
  };
  expand(root.subagents, root.conv, 1);

  for (const c of convs) {
    const issues = validate(c);
    c.meta.validation = { ok: issues.length === 0, issues };
  }
  return convs;
}

/** Route entry: null when the session is unknown or belongs to another working directory. */
export function assembleDevinObservation(sessionId: string, cwd: string, dbPath?: string): AssembledSession | null {
  const db = openDevinDb(dbPath);
  if (!db) return null;
  try {
    const data = readDevinSession(sessionId, db);
    if (!data || data.session.working_directory !== cwd) return null;
    return { conversations: assembleDevinSession(data), wire: { matched: 0, orphans: 0 } };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}
