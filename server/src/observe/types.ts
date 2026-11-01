// 观察数据模型：Conversation / Turn / Action 三实体（projects/aie-observe/design.md §1）。
// 这是装配器的输出类型，也是 /api/observe 返回给面板的 JSON 形状。

export const OBSERVATION_SCHEMA = 'observation/3';

/** 文本值：内联 + 摘要；超长截断。装配层不落 blob。 */
export interface TextField {
  digest: string;
  length: number;
  inline_text: string;
}

export type ActionType = 'user_input' | 'generation' | 'tool_call';
export type UserInputKind = 'new_task' | 'follow_up' | 'interrupt';
export type UserInputSource = 'human' | 'parent_agent';

export interface ActionBase {
  id: string;
  seq_no: number;
  type: ActionType;
  /** 触发本动作的动作 id（三条规则见 validate()） */
  inputs: string[];
  /**
   * 源会话面板里的消息锚点（web.RevealMessage 的 anchor 格式）：
   * Claude u:<uuid> / a:<uuid>:<blockIdx> / t:<toolUseId>；Devin n:<nodeId> / t:<toolCallId>。
   * 面板点卡片 ↗ 时据此滚到源消息。没有稳定锚点时为 null。
   */
  ref: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface UserInputPayload {
  content: Array<{ type: 'text' } & (TextField | { digest: ''; length: 0 })>;
  kind: UserInputKind;
  source: UserInputSource;
  /** 没有任何 user_input 就出现 assistant 时合成的占位 */
  synthetic?: true;
}

export interface UserInputAction extends ActionBase {
  type: 'user_input';
  payload: UserInputPayload;
  result: null;
}

export interface Tokens {
  input: number | null;
  output: number | null;
  thinking: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** cache_write 按 TTL 拆分（usage.cache_creation.ephemeral_5m/1h_input_tokens）；写入单价 1.25× / 2×。没有拆分时为 null */
  cache_write_5m: number | null;
  cache_write_1h: number | null;
}

export interface GenerationPayload {
  model: string | null;
  request_id: string | null;
  effort: string | null;
  /** 有 wire 记录时的请求侧摘要（wire.ts） */
  wire?: WireRequestSummary;
}

export interface GenerationResult {
  output_text: TextField | null;
  thinking: TextField | null;
  stop_reason: string | null;
  tokens: Tokens;
  /** 有 wire 记录时的响应侧摘要（wire.ts） */
  wire?: WireResponseSummary;
  /** 本地日志自带的时延（Devin 的 metrics）；Claude 侧没有，要靠 wire */
  timing?: { ttft_ms: number | null; total_ms: number | null };
}

export interface GenerationAction extends ActionBase {
  type: 'generation';
  payload: GenerationPayload;
  result: GenerationResult;
}

export interface ToolCallPayload {
  name: string | null;
  args: TextField | null;
  /** Devin：ACP ToolCall 的 title / kind（execute / read / edit / search / fetch …） */
  title?: string | null;
  kind?: string | null;
}

export interface ToolCallResult {
  status: 'success' | 'error' | null;
  content: TextField | null;
  /** 结果时间 − 发出时间，含模型侧等待，是估算 */
  latency_ms: number | null;
  /** Agent 类工具派生的子 Conversation */
  spawned_conversation_id: string | null;
}

export interface ToolCallAction extends ActionBase {
  type: 'tool_call';
  payload: ToolCallPayload;
  result: ToolCallResult | null;
}

export type Action = UserInputAction | GenerationAction | ToolCallAction;

export interface Turn {
  id: string;
  seq_no: number;
  actions: Action[];
  /** 正常是最后一个 generation；被打断 / 崩溃 / 还在跑都是 null */
  stop_action_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface ConversationParent {
  conversation_id: string;
  action_id: string;
}

export interface ValidationIssue {
  rule:
    | 'empty_turn'
    | 'first_action_not_user_input'
    | 'dangling_input'
    | 'generation_inputs'
    | 'tool_call_inputs'
    | 'user_input_has_inputs';
  turn?: string;
  action?: string;
  got?: string | string[];
  missing?: string[];
}

export interface ConversationMeta {
  validation?: { ok: boolean; issues: ValidationIssue[] };
  wire?: { generations_with_wire: number; orphans: number };
  /** 子代理 .meta.json 原样（agentType / description / toolUseId …） */
  [k: string]: unknown;
}

export interface Conversation {
  schema: typeof OBSERVATION_SCHEMA;
  id: string;
  parent: ConversationParent | null;
  root_conversation_id: string;
  agent_type: string;
  subagent_type: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  turns: Turn[];
  /** 对不上任何 generation 的 wire 记录（只挂在根 Conversation） */
  wire_orphans: WireOrphan[];
  meta: ConversationMeta;
}

export interface ConversationCounts {
  turns: number;
  user_inputs: number;
  generations: number;
  tool_calls: number;
  unfinished_turns: number;
}

// ---- wire 层摘要（挂在 generation 上；原始记录格式见 wire.ts） ----

export interface CacheBreakpoint {
  at: string;
  ttl: string;
}

export interface WireRequestSummary {
  req_bytes: number | null;
  retry_count: number;
  params: {
    max_tokens: unknown;
    thinking: unknown;
    effort: unknown;
    context_management: unknown;
    stream: unknown;
  };
  betas: string[];
  system_blocks: Array<{ chars: number; cached: boolean }>;
  tools: { count: number; names: string[]; chars: number };
  messages: {
    count: number;
    layout: Array<{ role: unknown; blocks: Array<{ type: unknown; chars: number }> }>;
  };
  cache_breakpoints: CacheBreakpoint[];
}

export interface WireResponseSummary {
  request_id: string | null;
  /** 代理进程内 seq；没有 request_id 的记录（orphan）靠它定位原件 */
  seq: number | null;
  captured_at: string | null;
  status: number | null;
  upstream_error: string | null;
  client_disconnected: boolean;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  total_ms: number | null;
  usage: Record<string, unknown> | null;
  stop_reason: string | null;
  ratelimit: Record<string, string>;
  sse_events: number;
}

export interface WireOrphan {
  request: WireRequestSummary;
  response: WireResponseSummary;
  model: unknown;
  path: string | null;
  reason: string;
}
