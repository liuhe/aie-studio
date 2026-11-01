// wire 层：线上报文记录（wire/1 格式，由本仓库的代理落盘；ai-excellence 的 wire-proxy.py 写的是同一格式）
// 按 response 头 request-id == transcript 的 requestId 并到 generation 上；对不上的进根 Conversation.wire_orphans。

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CacheBreakpoint, Conversation, WireOrphan, WireRequestSummary, WireResponseSummary } from './types.js';
import { iterActions } from './assemble.js';

export const WIRE_SCHEMA = 'wire/1';

export interface SseEvent {
  /** 距请求发出的秒数 */
  t: number;
  event: string | null;
  data: unknown;
}

/** 代理落盘的一次请求 / 响应。字段名与 wire-proxy.py 一致。 */
export interface WireRecord {
  schema: typeof WIRE_SCHEMA;
  seq: number;
  session_id: string;
  /** 响应头 request-id；上游没回就是 null */
  request_id: string | null;
  captured_at: string;
  t_start: number;
  t_first_byte: number | null;
  t_end: number | null;
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

type Dict = Record<string, any>;
const asDict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});

function header(h: Record<string, string> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return h[k];
  return undefined;
}

/** 请求体里所有 cache_control 断点的位置与 TTL（渲染顺序 tools → system → messages） */
export function cacheBreakpoints(body: Dict): CacheBreakpoint[] {
  const bps: CacheBreakpoint[] = [];
  const ttlOf = (cc: Dict) => String(cc.ttl ?? '5m');
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t && typeof t === 'object' && t.cache_control) bps.push({ at: `tools[${t.name}]`, ttl: ttlOf(t.cache_control) });
  }
  if (Array.isArray(body.system)) {
    body.system.forEach((b: unknown, i: number) => {
      const d = asDict(b);
      if (d.cache_control) bps.push({ at: `system[${i}]`, ttl: ttlOf(d.cache_control) });
    });
  }
  (Array.isArray(body.messages) ? body.messages : []).forEach((m: unknown, i: number) => {
    const c = asDict(m).content;
    if (!Array.isArray(c)) return;
    c.forEach((b: unknown, j: number) => {
      const d = asDict(b);
      if (d.cache_control) bps.push({ at: `messages[${i}].${j}`, ttl: ttlOf(d.cache_control) });
    });
  });
  return bps;
}

/** 请求侧摘要 → generation.payload.wire */
export function wireRequestSummary(rec: WireRecord): WireRequestSummary {
  const body = asDict(rec.req_body);
  const qh = rec.req_headers ?? {};
  const sys = body.system;
  const system_blocks: WireRequestSummary['system_blocks'] = Array.isArray(sys)
    ? sys.filter((b: unknown) => b && typeof b === 'object').map((b: Dict) => ({
        chars: typeof b.text === 'string' ? b.text.length : 0,
        cached: !!b.cache_control,
      }))
    : typeof sys === 'string'
      ? [{ chars: sys.length, cached: false }]
      : [];
  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  const msgs: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const layout = msgs.map((m) => {
    const d = asDict(m);
    const c = d.content;
    if (Array.isArray(c)) {
      return {
        role: d.role,
        blocks: c
          .filter((b: unknown) => b && typeof b === 'object')
          .map((b: Dict) => ({ type: b.type, chars: typeof b.text === 'string' ? b.text.length : 0 })),
      };
    }
    return { role: d.role, blocks: [{ type: 'str', chars: typeof c === 'string' ? c.length : 0 }] };
  });
  return {
    req_bytes: rec.req_bytes ?? null,
    retry_count: Number(header(qh, 'X-Stainless-Retry-Count') ?? 0) || 0,
    params: {
      max_tokens: body.max_tokens,
      thinking: body.thinking,
      effort: asDict(body.output_config).effort,
      context_management: body.context_management,
      stream: body.stream,
    },
    betas: (header(qh, 'anthropic-beta') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    system_blocks,
    tools: {
      count: tools.length,
      names: tools.filter((t) => t && typeof t === 'object').map((t) => (t as Dict).name),
      chars: tools.length ? JSON.stringify(tools).length : 0,
    },
    messages: { count: msgs.length, layout },
    cache_breakpoints: cacheBreakpoints(body),
  };
}

/** 响应侧摘要 → generation.result.wire */
export function wireResponseSummary(rec: WireRecord): WireResponseSummary {
  const rh = rec.resp_headers ?? {};
  let usage: Record<string, unknown> | null = null;
  let stopReason: string | null = null;
  let ttft: number | null = null;
  let n = 0;
  for (const ev of rec.sse_events ?? []) {
    n++;
    const d = asDict(ev.data);
    if (d.type === 'message_start') {
      usage = asDict(d.message).usage ?? null;
    } else if (d.type === 'message_delta') {
      if (d.usage) usage = { ...(usage ?? {}), ...d.usage };
      stopReason = asDict(d.delta).stop_reason ?? stopReason;
    } else if (d.type === 'content_block_delta' && ttft === null) {
      if (asDict(d.delta).type === 'text_delta') ttft = Math.round((ev.t ?? 0) * 1000);
    }
  }
  if (usage === null) {
    const body = asDict(rec.resp_body);
    if (body.usage) usage = body.usage;
    if (typeof body.stop_reason === 'string') stopReason = body.stop_reason;
  }
  const ratelimit: Record<string, string> = {};
  for (const [k, v] of Object.entries(rh)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('anthropic-ratelimit-unified-') && (lk.endsWith('utilization') || lk.endsWith('status'))) {
      ratelimit[lk.slice('anthropic-ratelimit-unified-'.length)] = v;
    }
  }
  return {
    request_id: rec.request_id ?? null,
    seq: typeof rec.seq === 'number' ? rec.seq : null,
    captured_at: rec.captured_at ?? null,
    status: rec.status ?? null,
    upstream_error: rec.upstream_error ?? null,
    client_disconnected: !!rec.client_disconnected,
    ttfb_ms: rec.ttfb_ms ?? null,
    ttft_ms: ttft,
    total_ms: rec.total_ms ?? null,
    usage,
    stop_reason: stopReason,
    ratelimit,
    sse_events: n,
  };
}

export interface AttachResult {
  matched: number;
  orphans: number;
}

/**
 * 把本 session 的 wire 记录并到各 conv 的 generation（子对话共用 session 头，所以一起找）。
 * 同一 request_id 多条记录时取最后一条。对不上的进根 conv 的 wire_orphans，并写 root.meta.wire。
 */
export function attachWire(convs: Conversation[], records: WireRecord[]): AttachResult {
  if (!records.length || !convs.length) return { matched: 0, orphans: 0 };
  const byRid = new Map<string, WireRecord>();
  for (const r of records) if (r.request_id) byRid.set(r.request_id, r);

  const used = new Set<string>();
  let matched = 0;
  for (const c of convs) {
    for (const [, a] of iterActions(c)) {
      if (a.type !== 'generation') continue;
      const rid = a.payload.request_id;
      if (!rid) continue;
      const rec = byRid.get(rid);
      if (!rec) continue;
      a.payload.wire = wireRequestSummary(rec);
      a.result.wire = wireResponseSummary(rec);
      used.add(rid);
      matched++;
    }
  }

  const orphans: WireOrphan[] = [];
  for (const r of records) {
    if (r.request_id && used.has(r.request_id)) continue;
    orphans.push({
      request: wireRequestSummary(r),
      response: wireResponseSummary(r),
      model: asDict(r.req_body).model,
      path: r.path ?? null,
      reason: r.upstream_error ? 'upstream_error' : r.status !== 200 ? `http_${r.status}` : 'no_matching_generation',
    });
  }
  const root = convs.find((c) => c.parent === null) ?? convs[0];
  root.wire_orphans = orphans;
  root.meta.wire = { generations_with_wire: matched, orphans: orphans.length };
  return { matched, orphans: orphans.length };
}

/** `<cwd>/.aie/observations/wire/<session_id>/` */
export function wireDir(cwd: string, sessionId: string): string {
  return path.join(cwd, '.aie', 'observations', 'wire', sessionId);
}

/** 读目录下全部 *.json（按文件名排序 = 时间顺序）；坏文件跳过；目录不存在返回 []。 */
export async function readWireRecords(dir: string): Promise<WireRecord[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: WireRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const rec = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (rec && typeof rec === 'object') out.push(rec as WireRecord);
    } catch {
      // 跳过
    }
  }
  return out;
}

/**
 * 按 key 找一条原件（server.ServeWireRecord）：key 是响应头 request_id，或 `seq-<n>`。
 * 同 request_id 多条取最后一条（与 attachWire 一致）；找不到返回 null。
 */
export async function findWireRecord(dir: string, key: string): Promise<WireRecord | null> {
  const records = await readWireRecords(dir);
  const m = /^seq-(\d+)$/.exec(key);
  let hit: WireRecord | null = null;
  for (const r of records) {
    if (m ? r.seq === Number(m[1]) : r.request_id === key) hit = r;
  }
  return hit;
}

/** Number of records on disk for a session (server.ListSessions ⚡ mark); 0 when the directory is missing. */
export async function countWireRecords(dir: string): Promise<number> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.json')).length;
}
