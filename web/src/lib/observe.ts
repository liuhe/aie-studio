// Model: web.ObserveTab / page ObserveView — pure helpers for the observation
// panel. Types mirror server/src/observe/types.ts (the assembler's output,
// schema observation/3); keep the two in sync when the model changes.
import { conversationCost, type TurnCost } from './pricing';

export interface TextField {
  digest: string;
  length: number;
  inline_text: string;
}

export interface Tokens {
  input: number | null;
  output: number | null;
  thinking: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
}

export interface WireRequestSummary {
  req_bytes: number | null;
  retry_count: number;
  params: Record<string, unknown>;
  betas: string[];
  system_blocks: Array<{ chars: number; cached: boolean }>;
  tools: { count: number; names: string[]; chars: number };
  messages: { count: number; layout: unknown[] };
  cache_breakpoints: Array<{ at: string; ttl: string }>;
}

export interface WireResponseSummary {
  request_id: string | null;
  /** proxy-local seq; the only handle for records without a request_id */
  seq: number | null;
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

interface ActionBase {
  id: string;
  seq_no: number;
  inputs: string[];
  /** source-panel message anchor (web.RevealMessage); null when none */
  ref: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface UserInputAction extends ActionBase {
  type: 'user_input';
  payload: {
    content: Array<{ type: 'text'; inline_text?: string; length: number }>;
    kind: 'new_task' | 'follow_up' | 'interrupt';
    source: 'human' | 'parent_agent';
    synthetic?: true;
  };
  result: null;
}

export interface GenerationAction extends ActionBase {
  type: 'generation';
  payload: { model: string | null; request_id: string | null; effort: string | null; wire?: WireRequestSummary };
  result: {
    output_text: TextField | null;
    thinking: TextField | null;
    stop_reason: string | null;
    tokens: Tokens;
    wire?: WireResponseSummary;
    /** Devin metrics (ttft / total); Claude only gets these through wire */
    timing?: { ttft_ms: number | null; total_ms: number | null };
  };
}

export interface ToolCallAction extends ActionBase {
  type: 'tool_call';
  payload: { name: string | null; args: TextField | null; title?: string | null; kind?: string | null };
  result: {
    status: 'success' | 'error' | null;
    content: TextField | null;
    latency_ms: number | null;
    spawned_conversation_id: string | null;
  } | null;
}

export type ObsAction = UserInputAction | GenerationAction | ToolCallAction;

export interface ObsTurn {
  id: string;
  seq_no: number;
  actions: ObsAction[];
  stop_action_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface ObsConversation {
  schema: string;
  id: string;
  parent: { conversation_id: string; action_id: string } | null;
  root_conversation_id: string;
  agent_type: string;
  subagent_type: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  turns: ObsTurn[];
  wire_orphans: Array<{ reason: string; path: string | null; model: unknown; request: WireRequestSummary; response: WireResponseSummary }>;
  meta: {
    validation?: { ok: boolean; issues: Array<{ rule: string; action?: string; turn?: string }> };
    wire?: { generations_with_wire: number; orphans: number };
    [k: string]: unknown;
  };
}

export interface ObservationResponse {
  conversations: ObsConversation[];
  wire: { matched: number; orphans: number };
  etag: string;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface ConversationStats {
  turns: number;
  userInputs: number;
  generations: number;
  toolCalls: number;
  unfinishedTurns: number;
  tokens: { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number };
  /** cache_read / (cache_read + cache_write + input) over all generations; null when nothing was read or written */
  cacheHitRate: number | null;
  generationsWithWire: number;
  validationOk: boolean;
  durationMs: number | null;
  /** list-price estimate incl. spawned conversations (rule-353) */
  cost: TurnCost;
}

/** One point per Turn for the overview chart. */
export interface TurnPoint {
  id: string;
  seq: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  hitRate: number | null;
  generations: number;
  noStop: boolean;
}

export function turnSeries(conv: ObsConversation): TurnPoint[] {
  return conv.turns.map((t) => {
    const p: TurnPoint = { id: t.id, seq: t.seq_no, cacheRead: 0, cacheWrite: 0, input: 0, output: 0, hitRate: null, generations: 0, noStop: t.stop_action_id === null };
    for (const a of t.actions) {
      if (a.type !== 'generation') continue;
      p.generations++;
      const k = a.result.tokens;
      p.cacheRead += k.cache_read ?? 0;
      p.cacheWrite += k.cache_write ?? 0;
      p.input += k.input ?? 0;
      p.output += k.output ?? 0;
    }
    const denom = p.cacheRead + p.cacheWrite + p.input;
    p.hitRate = denom > 0 ? p.cacheRead / denom : null;
    return p;
  });
}

export function conversationStats(conv: ObsConversation, all: ObsConversation[] = []): ConversationStats {
  const s: ConversationStats = {
    turns: conv.turns.length,
    userInputs: 0,
    generations: 0,
    toolCalls: 0,
    unfinishedTurns: 0,
    tokens: { input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 },
    cacheHitRate: null,
    generationsWithWire: 0,
    validationOk: conv.meta.validation?.ok ?? true,
    durationMs: durationMs(conv.started_at, conv.ended_at),
    cost: conversationCost(conv, all),
  };
  for (const t of conv.turns) {
    if (t.stop_action_id === null) s.unfinishedTurns++;
    for (const a of t.actions) {
      if (a.type === 'user_input') s.userInputs++;
      else if (a.type === 'tool_call') s.toolCalls++;
      else {
        s.generations++;
        if (a.payload.wire) s.generationsWithWire++;
        const k = a.result.tokens;
        s.tokens.input += k.input ?? 0;
        s.tokens.output += k.output ?? 0;
        s.tokens.thinking += k.thinking ?? 0;
        s.tokens.cacheRead += k.cache_read ?? 0;
        s.tokens.cacheWrite += k.cache_write ?? 0;
      }
    }
  }
  const denom = s.tokens.cacheRead + s.tokens.cacheWrite + s.tokens.input;
  s.cacheHitRate = denom > 0 ? s.tokens.cacheRead / denom : null;
  return s;
}

export function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Group a Turn's actions into display rows: every action is its own row,
 * except tool_calls that share the same inputs (fan-out of one generation),
 * which sit side by side in one row.
 */
export function turnRows(turn: ObsTurn): ObsAction[][] {
  const rows: ObsAction[][] = [];
  for (const a of turn.actions) {
    const last = rows[rows.length - 1];
    if (
      a.type === 'tool_call' &&
      last &&
      last[0].type === 'tool_call' &&
      last[0].inputs.length === 1 &&
      a.inputs.length === 1 &&
      last[0].inputs[0] === a.inputs[0]
    ) {
      last.push(a);
    } else {
      rows.push([a]);
    }
  }
  return rows;
}

/** seq_no by action id, so a card can label its inputs as "← #3, #4". */
export function seqIndex(turn: ObsTurn): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of turn.actions) m.set(a.id, a.seq_no);
  return m;
}

/**
 * Generations whose cache_read dropped to 0 while the previous generation (in
 * conversation order, across turns) had read from cache — the prefix was
 * rebuilt, i.e. a cache invalidation worth highlighting.
 */
export function cacheDropIds(conv: ObsConversation): Set<string> {
  const out = new Set<string>();
  let prev: number | null = null;
  for (const t of conv.turns) {
    for (const a of t.actions) {
      if (a.type !== 'generation') continue;
      const cur = a.result.tokens.cache_read;
      if (prev !== null && prev > 0 && cur === 0) out.add(a.id);
      if (cur !== null) prev = cur;
    }
  }
  return out;
}

/** Child conversations keyed by the parent tool_call action id. */
export function childrenByAction(all: ObsConversation[], parentId: string): Map<string, ObsConversation> {
  const m = new Map<string, ObsConversation>();
  for (const c of all) if (c.parent?.conversation_id === parentId) m.set(c.parent.action_id, c);
  return m;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function userInputText(a: UserInputAction): string {
  return a.payload.content.map((c) => c.inline_text ?? '').join('\n');
}

/** First line of the first user_input, trimmed, for the Turn header. */
export function turnSummary(turn: ObsTurn, max = 90): string {
  const first = turn.actions[0];
  if (!first || first.type !== 'user_input') return '';
  // Drop injected <system-reminder> blocks (hooks, CLAUDE.md echoes) so the
  // header shows what the human actually typed; fall back to the raw text when
  // the input is nothing but injections.
  const raw = userInputText(first);
  const stripped = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const lines = (stripped || raw.trim()).split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Compact one-line view of tool args: the most telling string field, else the raw JSON. */
export function argsSummary(args: TextField | null, max = 100): string {
  if (!args) return '';
  const raw = args.inline_text;
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description']) {
        if (typeof d[k] === 'string' && d[k].trim()) return truncate(d[k].replace(/\s+/g, ' ').trim(), max);
      }
      const firstStr = Object.values(d).find((v) => typeof v === 'string' && (v as string).trim());
      if (typeof firstStr === 'string') return truncate(firstStr.replace(/\s+/g, ' ').trim(), max);
    }
  } catch {
    // truncated / non-JSON args: show as-is
  }
  return truncate(raw.replace(/\s+/g, ' ').trim(), max);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function fmtPct(x: number | null | undefined): string {
  return x == null ? '–' : `${Math.round(x * 100)}%`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export type TokenKey = 'output' | 'cacheWrite' | 'input' | 'cacheRead';
/**
 * Token kinds ordered by unit price, most expensive first (output ≫ cache
 * write > input ≫ cache read). Bars stack / read in this order so the costly
 * part sits at the baseline and the near-free cache read on top.
 */
export const TOKEN_KEYS: Array<{ key: TokenKey; label: string; short: string }> = [
  { key: 'output', label: 'output', short: 'out' },
  { key: 'cacheWrite', label: 'cache write', short: 'w' },
  { key: 'input', label: 'input', short: 'in' },
  { key: 'cacheRead', label: 'cache read', short: 'r' },
];

/** Segment widths in TOKEN_KEYS order as fractions summing to 1. */
export function tokenSegments(t: Tokens): Array<{ key: TokenKey; value: number; frac: number }> {
  const parts = [
    { key: 'output' as const, value: t.output ?? 0 },
    { key: 'cacheWrite' as const, value: t.cache_write ?? 0 },
    { key: 'input' as const, value: t.input ?? 0 },
    { key: 'cacheRead' as const, value: t.cache_read ?? 0 },
  ];
  const total = parts.reduce((n, p) => n + p.value, 0);
  return parts.map((p) => ({ ...p, frac: total > 0 ? p.value / total : 0 }));
}

/** Most recent wire ratelimit headers (subscription quota meter), or null without wire. */
export function latestRatelimit(conv: ObsConversation): Record<string, string> | null {
  for (let i = conv.turns.length - 1; i >= 0; i--) {
    const acts = conv.turns[i].actions;
    for (let j = acts.length - 1; j >= 0; j--) {
      const a = acts[j];
      if (a.type === 'generation' && a.result.wire && Object.keys(a.result.wire.ratelimit).length) return a.result.wire.ratelimit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire record (server.ServeWireRecord): the raw capture, mirrors
// server/src/observe/wire.ts WireRecord (schema wire/1).
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** seconds since the request left the proxy */
  t: number;
  event: string | null;
  data: unknown;
}

export interface WireRecord {
  schema: string;
  seq: number;
  session_id: string;
  request_id: string | null;
  captured_at: string;
  ttfb_ms: number | null;
  total_ms: number | null;
  method: string;
  path: string;
  req_headers: Record<string, string>;
  req_bytes: number;
  req_body: unknown;
  status: number | null;
  resp_headers: Record<string, string>;
  upstream_error: string | null;
  client_disconnected: boolean;
  sse_events: SseEvent[] | null;
  resp_body: unknown;
}

/** The key server.ServeWireRecord accepts for a generation / orphan: request_id first, seq-<n> as fallback. */
export function wireKey(w: { request_id: string | null; seq: number | null } | null | undefined): string | null {
  if (!w) return null;
  if (w.request_id) return w.request_id;
  if (w.seq != null) return `seq-${w.seq}`;
  return null;
}

/** Hover text for every abbreviation on the wire badges and wire rows (rule-358). */
export const WIRE_GLOSSARY = {
  ttfb: 'Time to first byte: from the proxy sending the request to the first byte of the HTTP response (headers). Queueing + prompt prefill before anything streams.',
  ttft: 'Time to first text token: until the first text_delta SSE event. Thinking happens before it, so ttft ≥ ttfb.',
  total: 'Total wall time of the request: until the upstream closed the response stream (message_stop).',
  tools: 'Number of tool definitions sent in the request body (tools[]). Each definition costs prompt tokens on every request unless cached.',
  bp: 'Cache breakpoints: blocks carrying cache_control in tools / system / messages. The prefix up to each breakpoint is cached for its TTL (5m or 1h).',
  messages: 'Length of the request body messages[] array (the whole conversation as sent, not just the new turn).',
  system: 'system[] blocks in the request body: the system prompt split into blocks; "cached" counts blocks carrying a cache_control breakpoint.',
  sse: 'Server-sent events in the response stream: message_start, content_block_start/delta/stop, ping, message_delta, message_stop.',
  retry: 'X-Stainless-Retry-Count: the SDK re-sent this request after a failure.',
  params: 'Generation parameters from the request body: max_tokens, thinking, effort, context_management, stream.',
  betas: 'anthropic-beta request header: feature flags the client opted into.',
  usage: 'usage from message_start merged with message_delta: token counts the API billed for this response.',
  ratelimit: 'anthropic-ratelimit-unified-* response headers: subscription quota meters (5h / 7d windows, utilization 0–1).',
  req_bytes: 'Request body size in bytes as sent to the API.',
  request_id: 'request-id response header. The same id appears in the transcript line, which is how wire records are matched to generations.',
  status: 'HTTP status of the upstream response.',
} as const;

export type WireTerm = keyof typeof WIRE_GLOSSARY;

/** One content block rebuilt from the SSE stream (what the model actually sent back, in order). */
export interface SseBlock {
  index: number;
  type: string;
  /** tool_use name */
  name: string | null;
  /** assembled text / thinking / partial json */
  text: string;
  deltas: number;
  /** seconds of first / last event for this block */
  t_start: number | null;
  t_end: number | null;
}

type Dict = Record<string, any>;
const asDict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});

/** Rebuild content blocks from content_block_start / delta / stop events. */
export function sseBlocks(events: SseEvent[] | null | undefined): SseBlock[] {
  const out: SseBlock[] = [];
  const byIndex = new Map<number, SseBlock>();
  for (const ev of events ?? []) {
    const d = asDict(ev.data);
    const idx = typeof d.index === 'number' ? d.index : null;
    if (d.type === 'content_block_start' && idx != null) {
      const cb = asDict(d.content_block);
      const b: SseBlock = {
        index: idx,
        type: String(cb.type ?? '?'),
        name: typeof cb.name === 'string' ? cb.name : null,
        text: typeof cb.text === 'string' ? cb.text : typeof cb.thinking === 'string' ? cb.thinking : '',
        deltas: 0,
        t_start: ev.t ?? null,
        t_end: ev.t ?? null,
      };
      byIndex.set(idx, b);
      out.push(b);
    } else if (d.type === 'content_block_delta' && idx != null) {
      const b = byIndex.get(idx);
      if (!b) continue;
      const delta = asDict(d.delta);
      if (typeof delta.text === 'string') b.text += delta.text;
      else if (typeof delta.thinking === 'string') b.text += delta.thinking;
      else if (typeof delta.partial_json === 'string') b.text += delta.partial_json;
      b.deltas++;
      b.t_end = ev.t ?? b.t_end;
    } else if (d.type === 'content_block_stop' && idx != null) {
      const b = byIndex.get(idx);
      if (b) b.t_end = ev.t ?? b.t_end;
    }
  }
  return out;
}

/** One-line summary of an SSE event for the events table. */
export function sseEventSummary(ev: SseEvent, max = 80): string {
  const d = asDict(ev.data);
  switch (d.type) {
    case 'message_start': {
      const m = asDict(d.message);
      const u = asDict(m.usage);
      return `${m.model ?? ''} · in ${fmtTokens(u.input_tokens)} · cache r ${fmtTokens(u.cache_read_input_tokens)} · w ${fmtTokens(u.cache_creation_input_tokens)}`;
    }
    case 'content_block_start': {
      const cb = asDict(d.content_block);
      return `#${d.index} ${cb.type ?? '?'}${cb.name ? ` ${cb.name}` : ''}`;
    }
    case 'content_block_delta': {
      const delta = asDict(d.delta);
      const txt = typeof delta.text === 'string' ? delta.text : typeof delta.thinking === 'string' ? delta.thinking : typeof delta.partial_json === 'string' ? delta.partial_json : '';
      return `#${d.index} ${delta.type ?? '?'}${txt ? ` ${JSON.stringify(truncate(txt, max))}` : delta.signature ? ' (signature)' : ''}`;
    }
    case 'content_block_stop':
      return `#${d.index}`;
    case 'message_delta': {
      const u = asDict(d.usage);
      return `stop ${asDict(d.delta).stop_reason ?? '–'} · out ${fmtTokens(u.output_tokens)}`;
    }
    case 'message_stop':
    case 'ping':
      return '';
    case 'error':
      return truncate(JSON.stringify(d.error ?? d), max);
    default:
      return truncate(JSON.stringify(ev.data), max);
  }
}

/** Blocks of one request message / system entry, normalised to an array. */
export function contentBlocks(content: unknown): Dict[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' ? (b as Dict) : { type: typeof b, text: String(b) }));
  return [];
}

/** Text to show for a request block: text / thinking / tool_use input / tool_result content. */
export function blockText(b: Dict): string {
  if (typeof b.text === 'string') return b.text;
  if (typeof b.thinking === 'string') return b.thinking;
  if (b.type === 'tool_use') return JSON.stringify(b.input ?? {}, null, 2);
  if (b.type === 'tool_result') {
    const c = b.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (typeof asDict(x).text === 'string' ? asDict(x).text : JSON.stringify(x))).join('\n');
    return c == null ? '' : JSON.stringify(c, null, 2);
  }
  if (b.type === 'image') return `(image ${asDict(b.source).media_type ?? ''})`;
  return JSON.stringify(b, null, 2);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtSec(t: number | null | undefined): string {
  return t == null ? '–' : `${t.toFixed(3)}s`;
}
