// Model: server.ObserveWireSession — local forwarding proxy for Claude Code's
// API traffic. Passes every request through to api.anthropic.com unchanged
// (credential headers included), and records request / response as a Wire
// Record (schema wire/1, see wire.ts) under
// <cwd>/.aie/observations/wire/<session_id>/. The assembler joins records to
// generations by the response's request-id header.
//
// cwd for a session id comes from session.ts (registerWireSession) — the
// proxy itself only sees the X-Claude-Code-Session-Id header. Records that
// arrive before the registration are buffered in memory and flushed later.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { WIRE_SCHEMA, wireDir, type SseEvent, type WireRecord } from './wire.js';

export interface WireUpstream {
  protocol: 'https:' | 'http:';
  host: string;
  port: number;
}

export interface WireProxyOptions {
  /** 0 = ephemeral (tests) */
  port: number;
  host?: string;
  upstream?: WireUpstream;
}

export interface WireProxyHandle {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

const DEFAULT_UPSTREAM: WireUpstream = { protocol: 'https:', host: 'api.anthropic.com', port: 443 };
// Not forwarded. accept-encoding is dropped so the upstream answers in
// plaintext (otherwise the recorded SSE would be gzip bytes).
const HOP = new Set(['accept-encoding', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'content-length']);
const SECRET = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);
const UNKNOWN_SESSION = '_unknown';
const BUFFER_MAX_PER_SESSION = 200;
const BUFFER_TTL_MS = 15 * 60_000;
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// session id → cwd registry (fed by session.ts)
// ---------------------------------------------------------------------------

const sessionCwd = new Map<string, string>();
const buffered = new Map<string, { at: number; records: WireRecord[] }>();
let running: WireProxyHandle | null = null;
let seq = 0;

export function registerWireSession(sessionId: string, cwd: string): void {
  sessionCwd.set(sessionId, cwd);
  const pending = buffered.get(sessionId);
  if (pending) {
    buffered.delete(sessionId);
    for (const rec of pending.records) void writeRecord(cwd, rec);
  }
}

/** Base URL to put in ANTHROPIC_BASE_URL, or null while the proxy is not running. */
export function wireBaseUrl(): string | null {
  return running?.baseUrl ?? null;
}

/** Exposed for tests. */
export function _resetWireRegistry(): void {
  sessionCwd.clear();
  buffered.clear();
}

async function writeRecord(cwd: string, rec: WireRecord): Promise<string> {
  const dir = wireDir(cwd, rec.session_id);
  await fs.mkdir(dir, { recursive: true });
  const stamp = rec.captured_at.replace(/[-:]/g, '');
  const file = path.join(dir, `${stamp}-${String(rec.seq).padStart(4, '0')}.json`);
  await fs.writeFile(file, JSON.stringify(rec, null, 1), 'utf8');
  return file;
}

function persist(rec: WireRecord): void {
  const cwd = sessionCwd.get(rec.session_id);
  if (cwd) {
    void writeRecord(cwd, rec).catch(() => {});
    return;
  }
  const now = Date.now();
  for (const [sid, b] of buffered) if (now - b.at > BUFFER_TTL_MS) buffered.delete(sid);
  const b = buffered.get(rec.session_id) ?? { at: now, records: [] };
  b.at = now;
  b.records.push(rec);
  if (b.records.length > BUFFER_MAX_PER_SESSION) b.records.shift();
  buffered.set(rec.session_id, b);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

export class SseParser {
  private buf = '';
  readonly events: SseEvent[] = [];
  feed(text: string, tRel: number): void {
    this.buf += text;
    for (;;) {
      const i = this.buf.indexOf('\n\n');
      if (i < 0) return;
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      const raw = dataLines.join('\n');
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // keep raw
      }
      this.events.push({ t: Math.round(tRel * 1000) / 1000, event, data });
    }
  }
}

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------

function redact(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET.has(k.toLowerCase()) ? '<redacted>' : v;
  return out;
}

function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function replyJson(res: http.ServerResponse, status: number, body: unknown): void {
  try {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), connection: 'close' });
    res.end(text);
  } catch {
    // client already gone
  }
}

function makeHandler(upstream: WireUpstream, startedAt: number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if ((req.url ?? '').startsWith('/_aie/health')) {
      replyJson(res, 200, { ok: true, upstream: `${upstream.protocol}//${upstream.host}:${upstream.port}`, requests: seq, uptime_s: Math.round((Date.now() - startedAt) / 1000), sessions: sessionCwd.size });
      return;
    }
    const t0 = Date.now();
    const mySeq = ++seq;
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      replyJson(res, 400, { type: 'error', error: { type: 'proxy_error', message: String(e) } });
      return;
    }
    const incoming = flatHeaders(req.headers);
    const fwd: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) if (!HOP.has(k.toLowerCase())) fwd[k] = v;
    fwd.host = upstream.host;
    if (body.length) fwd['content-length'] = String(body.length);
    const sessionId = incoming['x-claude-code-session-id'] || UNKNOWN_SESSION;

    const rec: WireRecord = {
      schema: WIRE_SCHEMA,
      seq: mySeq,
      session_id: sessionId,
      request_id: null,
      captured_at: iso(t0),
      t_start: t0 / 1000,
      t_first_byte: null,
      t_end: null,
      ttfb_ms: null,
      total_ms: null,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      req_headers: redact(fwd),
      req_bytes: body.length,
      req_body: null,
      status: null,
      resp_headers: {},
      upstream_error: null,
      client_disconnected: false,
      sse_events: null,
      resp_body: null,
    };
    if (body.length) {
      const text = body.toString('utf8');
      try {
        rec.req_body = JSON.parse(text);
      } catch {
        rec.req_body = text;
      }
    }

    const finish = () => {
      const tEnd = Date.now();
      rec.t_end = tEnd / 1000;
      rec.total_ms = tEnd - t0;
      if (rec.t_first_byte != null) rec.ttfb_ms = Math.round(rec.t_first_byte * 1000 - t0);
      persist(rec);
    };

    res.on('close', () => {
      if (!res.writableFinished) rec.client_disconnected = true;
    });

    const transport = upstream.protocol === 'https:' ? https : http;
    const up = transport.request(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers: fwd, timeout: UPSTREAM_TIMEOUT_MS },
      (ures) => {
        rec.status = ures.statusCode ?? null;
        rec.resp_headers = flatHeaders(ures.headers);
        const rid = ures.headers['request-id'];
        rec.request_id = Array.isArray(rid) ? rid[0] : rid ?? null;
        const ctype = String(ures.headers['content-type'] ?? '').toLowerCase();
        const sse = ctype.includes('text/event-stream') ? new SseParser() : null;
        const decoder = new StringDecoder('utf8');
        const rawParts: string[] = [];

        const outHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(flatHeaders(ures.headers))) if (!HOP.has(k.toLowerCase())) outHeaders[k] = v;
        outHeaders.connection = 'close';
        try {
          res.writeHead(ures.statusCode ?? 502, outHeaders);
        } catch {
          rec.client_disconnected = true;
        }

        ures.on('data', (chunk: Buffer) => {
          const now = Date.now();
          if (rec.t_first_byte == null) rec.t_first_byte = now / 1000;
          const text = decoder.write(chunk);
          if (sse) sse.feed(text, (now - t0) / 1000);
          else rawParts.push(text);
          if (!rec.client_disconnected) {
            try {
              res.write(chunk);
            } catch {
              rec.client_disconnected = true;
            }
          }
        });
        ures.on('end', () => {
          const tail = decoder.end();
          if (tail) {
            if (sse) sse.feed(tail, (Date.now() - t0) / 1000);
            else rawParts.push(tail);
          }
          if (sse) rec.sse_events = sse.events;
          else {
            const raw = rawParts.join('');
            try {
              rec.resp_body = raw ? JSON.parse(raw) : null;
            } catch {
              rec.resp_body = raw;
            }
          }
          try {
            res.end();
          } catch {
            // ignore
          }
          finish();
        });
        ures.on('error', (e) => {
          rec.upstream_error = `${e.name}: ${e.message}`;
          try {
            res.end();
          } catch {
            // ignore
          }
          finish();
        });
      },
    );
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (e) => {
      if (rec.status !== null) return; // error after headers: handled by ures 'error'
      rec.upstream_error = `${e.name}: ${e.message}`;
      rec.status = 502;
      replyJson(res, 502, { type: 'error', error: { type: 'proxy_error', message: rec.upstream_error } });
      finish();
    });
    up.end(body);
  };
}

/** Start the proxy. Resolves once listening; rejects if the port is taken. */
export function startWireProxy(opts: WireProxyOptions): Promise<WireProxyHandle> {
  const upstream = opts.upstream ?? DEFAULT_UPSTREAM;
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(makeHandler(upstream, Date.now()));
  // Long SSE responses: never let node kill the socket on its own.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      const handle: WireProxyHandle = {
        port,
        baseUrl: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
            if (running === handle) running = null;
          }),
      };
      running = handle;
      resolve(handle);
    });
  });
}
