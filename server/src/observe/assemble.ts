// 三实体装配：transcript 条目 → Conversation { turns: [Turn { actions: [Action] }] }。
// 纯函数，不碰文件系统；行为对齐 ai-excellence/ai-observation/assemble.py（参考实现）。
// 规则见 projects/aie-observe/design.md §1 / §2.5。

import { createHash } from 'node:crypto';
import type {
  Action,
  Conversation,
  ConversationCounts,
  ConversationMeta,
  ConversationParent,
  GenerationAction,
  TextField,
  ToolCallAction,
  Turn,
  UserInputAction,
  UserInputKind,
  UserInputSource,
  ValidationIssue,
} from './types.js';
import { OBSERVATION_SCHEMA } from './types.js';
import {
  classifyUserContent,
  extractAssistantOutput,
  mergeStreamedAssistant,
  relevantEntries,
  toolResultText,
  type SubagentTranscript,
  type TranscriptEntry,
} from './transcript.js';

/** generation 以这些 stop_reason 结束时，Turn 才算有 stop */
export const TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'refusal', 'stop_sequence', 'pause_turn']);

const INLINE_LIMIT = 8000;

export function textField(text: string | null | undefined): TextField | null {
  if (!text) return null;
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  if (text.length <= INLINE_LIMIT) return { digest, length: text.length, inline_text: text };
  return { digest, length: text.length, inline_text: text.slice(0, INLINE_LIMIT) + '...[truncated]' };
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function laterIso(a: string | null, b: string | null): string | null {
  const ta = parseTs(a);
  const tb = parseTs(b);
  if (ta == null) return b;
  if (tb == null) return a;
  return tb > ta ? b : a;
}

export interface BuildOptions {
  /** 子对话：指回父 Conversation 的 tool_call */
  parent?: ConversationParent | null;
  /** 子对话：父 tool_call 的任务文本；子 transcript 自带首条 user 消息时不用 */
  spawnText?: string | null;
  subagentType?: string | null;
  meta?: ConversationMeta;
}

/**
 * 从 transcript 条目装配一个 Conversation。
 * 装配规则：含 text 的 user 行开新 Turn；assistant 行成 generation（inputs = 已回结果且未消费的
 * tool_call，否则 = 未消费的 user_input），其 tool_use 块各成 tool_call；tool_result 回填 tool_call.result。
 */
export function buildConversation(entries: TranscriptEntry[], convId: string, opts: BuildOptions = {}): Conversation {
  const relevant = mergeStreamedAssistant(relevantEntries(entries));
  const parent = opts.parent ?? null;

  const turns: Turn[] = [];
  const actionsById = new Map<string, Action>();
  let cur = null as Turn | null; // 在闭包里赋值，别让 TS 把它窄化成 null
  let convModel: string | null = null;
  let pendingUserInputId: string | null = null;
  let pendingToolCallIds: string[] = [];

  const addAction = (a: Action) => {
    a.seq_no = cur!.actions.length;
    cur!.actions.push(a);
    actionsById.set(a.id, a);
    const t = a.ended_at ?? a.started_at;
    if (t) cur!.ended_at = t;
  };

  const newTurn = (first: Action) => {
    cur = {
      id: `${convId}:t${turns.length}`,
      seq_no: turns.length,
      actions: [],
      stop_action_id: null,
      started_at: first.started_at,
      ended_at: null,
    };
    turns.push(cur);
    addAction(first);
  };

  /** 上一 Turn 是否停在等结果的 generation / tool_call 上（此时新 user_input 即打断） */
  const previousTurnUnfinished = (): boolean => {
    if (!cur || !cur.actions.length) return false;
    const last = cur.actions[cur.actions.length - 1];
    if (last.type === 'generation') return !TERMINAL_STOP_REASONS.has(last.result.stop_reason ?? '');
    return last.type === 'tool_call';
  };

  const makeUserInput = (
    id: string,
    text: string,
    ts: string | null,
    source: UserInputSource,
    kind: UserInputKind,
  ): UserInputAction => ({
    id,
    seq_no: 0,
    type: 'user_input',
    inputs: [],
    payload: {
      content: text ? [{ type: 'text', ...(textField(text) as TextField) }] : [],
      kind,
      source,
    },
    result: null,
    ref: null,
    started_at: ts,
    ended_at: ts,
  });

  // 子对话：首个动作是父代理给的任务。子 transcript 通常自带这条 user 消息（字符串 content），
  // 直接用它并标 source=parent_agent；没有时才合成一条。
  let spawnPending = parent !== null;
  if (spawnPending) {
    const first = relevant[0];
    const firstIsUserText =
      !!first &&
      first.type === 'user' &&
      ['user_input', 'mixed'].includes(classifyUserContent(first.message?.content).kind);
    if (!firstIsUserText) {
      const ui = makeUserInput(`${convId}:spawn`, opts.spawnText ?? '', first?.timestamp ?? null, 'parent_agent', 'new_task');
      newTurn(ui);
      pendingUserInputId = ui.id;
      spawnPending = false;
    }
  }

  for (const entry of relevant) {
    const ts = entry.timestamp ?? null;

    if (entry.type === 'user') {
      const { kind, texts, toolResults } = classifyUserContent(entry.message?.content);

      if (kind === 'tool_results' || kind === 'mixed') {
        for (const tr of toolResults) {
          const tid = tr.tool_use_id;
          if (!tid) continue;
          const tc = actionsById.get(tid);
          if (!tc || tc.type !== 'tool_call') continue;
          let latency: number | null = null;
          const t0 = parseTs(tc.started_at);
          const t1 = parseTs(ts);
          if (t0 != null && t1 != null && t1 > t0) latency = t1 - t0;
          tc.result = {
            status: tr.is_error ? 'error' : 'success',
            content: textField(toolResultText(tr.content)),
            latency_ms: latency,
            spawned_conversation_id: tc.result?.spawned_conversation_id ?? null,
          };
          tc.ended_at = ts;
          if (cur) cur.ended_at = ts;
          pendingToolCallIds.push(tid);
        }
      }

      if (kind === 'user_input' || kind === 'mixed') {
        const uid = entry.uuid ?? entry.promptId;
        if (uid) {
          const uiKind: UserInputKind = !turns.length ? 'new_task' : previousTurnUnfinished() ? 'interrupt' : 'follow_up';
          const source: UserInputSource = spawnPending && !turns.length ? 'parent_agent' : 'human';
          spawnPending = false;
          const ui = makeUserInput(uid, texts.join('\n'), ts, source, uiKind);
          ui.ref = `u:${uid}`;
          newTurn(ui);
          pendingUserInputId = uid;
          pendingToolCallIds = [];
        }
      }
      continue;
    }

    if (entry.type === 'assistant') {
      const msg = entry.message ?? {};
      if (!convModel && msg.model) convModel = msg.model;
      const { text, thinking, toolUses } = extractAssistantOutput(msg.content);
      const usage = msg.usage ?? {};
      const cc = (usage as { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }).cache_creation;
      const genId = entry.uuid ?? `${convId}:gen${actionsById.size}`;

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
        payload: {
          model: msg.model ?? null,
          request_id: entry.requestId ?? null,
          effort: entry.effort ?? null,
        },
        result: {
          output_text: textField(text),
          thinking: textField(thinking),
          stop_reason: msg.stop_reason ?? null,
          tokens: {
            input: usage.input_tokens ?? null,
            output: usage.output_tokens ?? null,
            thinking: usage.output_tokens_details?.thinking_tokens ?? null,
            cache_read: usage.cache_read_input_tokens ?? null,
            cache_write: usage.cache_creation_input_tokens ?? null,
            cache_write_5m: cc?.ephemeral_5m_input_tokens ?? null,
            cache_write_1h: cc?.ephemeral_1h_input_tokens ?? null,
          },
        },
        // 文本块的锚点；纯工具调用的生成退到第一个工具行
        ref: entry._text_anchor ? `a:${entry._text_anchor.uuid}:${entry._text_anchor.blockIdx}` : toolUses[0] ? `t:${toolUses[0].id}` : null,
        started_at: ts,
        ended_at: entry._ended_at ?? ts,
      };

      if (!cur) {
        // 没有任何 user_input 就出现 assistant：合成一个空 user_input 占位
        const ui = makeUserInput(`${convId}:missing-input-${turns.length}`, '', ts, 'human', 'new_task');
        ui.payload.synthetic = true;
        newTurn(ui);
        gen.inputs = [ui.id];
      }
      addAction(gen);

      for (const tu of toolUses) {
        const tc: ToolCallAction = {
          id: tu.id,
          seq_no: 0,
          type: 'tool_call',
          inputs: [genId],
          payload: { name: tu.name ?? null, args: textField(JSON.stringify(tu.input ?? {})) },
          result: null,
          ref: `t:${tu.id}`,
          started_at: ts,
          ended_at: null,
        };
        addAction(tc);
      }
    }
  }

  // 收尾：stop 判定 + Turn 时间
  for (const t of turns) {
    if (!t.actions.length) continue;
    const last = t.actions[t.actions.length - 1];
    if (last.type === 'generation' && TERMINAL_STOP_REASONS.has(last.result.stop_reason ?? '')) {
      t.stop_action_id = last.id;
    }
    t.started_at = t.actions[0].started_at;
    let ended: string | null = null;
    for (const a of t.actions) ended = laterIso(ended, a.ended_at ?? a.started_at);
    t.ended_at = ended;
  }

  return {
    schema: OBSERVATION_SCHEMA,
    id: convId,
    parent,
    root_conversation_id: parent?.conversation_id ?? convId,
    agent_type: opts.subagentType ?? 'claude',
    subagent_type: opts.subagentType ?? null,
    model: convModel,
    started_at: turns[0]?.started_at ?? null,
    ended_at: turns.length ? turns[turns.length - 1].ended_at : null,
    turns,
    wire_orphans: [],
    meta: { ...(opts.meta ?? {}) },
  };
}

export function* iterActions(conv: Conversation): Generator<[Turn, Action]> {
  for (const t of conv.turns) for (const a of t.actions) yield [t, a];
}

/** 三条规则 + 悬空 inputs 检查。返回违例列表，不抛。 */
export function validate(conv: Conversation): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map<string, Action>();
  for (const [, a] of iterActions(conv)) byId.set(a.id, a);

  for (const t of conv.turns) {
    if (!t.actions.length) {
      issues.push({ turn: t.id, rule: 'empty_turn' });
      continue;
    }
    if (t.actions[0].type !== 'user_input') {
      issues.push({ turn: t.id, rule: 'first_action_not_user_input', got: t.actions[0].type });
    }
    for (const a of t.actions) {
      const missing = a.inputs.filter((i) => !byId.has(i));
      if (missing.length) issues.push({ action: a.id, rule: 'dangling_input', missing });
      const kinds = a.inputs.filter((i) => byId.has(i)).map((i) => byId.get(i)!.type);
      if (a.type === 'generation') {
        const ok =
          (kinds.length === 1 && kinds[0] === 'user_input') ||
          (kinds.length > 0 && kinds.every((k) => k === 'tool_call'));
        if (!ok) issues.push({ action: a.id, rule: 'generation_inputs', got: kinds });
      } else if (a.type === 'tool_call') {
        if (!(kinds.length === 1 && kinds[0] === 'generation')) {
          issues.push({ action: a.id, rule: 'tool_call_inputs', got: kinds });
        }
      } else if (a.inputs.length) {
        issues.push({ action: a.id, rule: 'user_input_has_inputs' });
      }
    }
  }
  return issues;
}

export function counts(conv: Conversation): ConversationCounts {
  const n: ConversationCounts = { turns: conv.turns.length, user_inputs: 0, generations: 0, tool_calls: 0, unfinished_turns: 0 };
  for (const t of conv.turns) {
    if (t.stop_action_id === null) n.unfinished_turns++;
    for (const a of t.actions) {
      if (a.type === 'user_input') n.user_inputs++;
      else if (a.type === 'generation') n.generations++;
      else n.tool_calls++;
    }
  }
  return n;
}

/** 父 Agent 类 tool_call 的 args → 子对话首个 user_input 的文本（优先 prompt / task / description 字段） */
export function spawnTextFromArgs(args: TextField | null): string {
  const txt = args?.inline_text ?? '';
  try {
    const d = JSON.parse(txt);
    if (d && typeof d === 'object') {
      for (const k of ['prompt', 'task', 'description']) {
        if (typeof d[k] === 'string' && d[k].trim()) return d[k];
      }
    }
  } catch {
    // 非 JSON 原样返回
  }
  return txt;
}

/**
 * 装配一个 session：根 Conversation + 每个子代理一个 Conversation。
 * 子对话 parent 指回父 tool_call，父 tool_call.result.spawned_conversation_id 指向子对话。
 * 校验结果写入每个 conv 的 meta.validation。wire 并入由 wire.ts 的 attachWire 负责。
 */
export function assembleSession(sessionId: string, main: TranscriptEntry[], subagents: SubagentTranscript[] = []): Conversation[] {
  const root = buildConversation(main, sessionId);
  const convs = [root];

  const toolCalls = new Map<string, ToolCallAction>();
  for (const [, a] of iterActions(root)) if (a.type === 'tool_call') toolCalls.set(a.id, a);

  for (const sub of subagents) {
    const toolUseId = typeof sub.meta.toolUseId === 'string' ? sub.meta.toolUseId : null;
    const parentTc = toolUseId ? toolCalls.get(toolUseId) : undefined;
    const child = buildConversation(sub.entries, sub.agentId, {
      parent: toolUseId ? { conversation_id: sessionId, action_id: toolUseId } : null,
      spawnText: parentTc ? spawnTextFromArgs(parentTc.payload.args) : null,
      subagentType: typeof sub.meta.agentType === 'string' ? sub.meta.agentType : null,
      meta: { ...sub.meta },
    });
    child.root_conversation_id = sessionId;
    if (parentTc) {
      parentTc.result ??= { status: null, content: null, latency_ms: null, spawned_conversation_id: null };
      parentTc.result.spawned_conversation_id = sub.agentId;
    }
    convs.push(child);
  }

  for (const c of convs) {
    const issues = validate(c);
    c.meta.validation = { ok: issues.length === 0, issues };
  }
  return convs;
}
