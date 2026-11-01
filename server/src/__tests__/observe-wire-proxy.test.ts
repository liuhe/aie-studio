import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SseParser, _resetWireRegistry, registerWireSession, startWireProxy, wireBaseUrl, type WireProxyHandle } from '../observe/wire-proxy.js';
import { readWireRecords, wireDir } from '../observe/wire.js';

// Fake upstream: streams SSE for /v1/messages, 401 JSON for anything else,
// and remembers the headers it received (model: server.ObserveWireSession).
let upstream: http.Server;
let upstreamPort = 0;
let seen: http.IncomingHttpHeaders[] = [];
let proxy: WireProxyHandle;
let cwd: string;
let n = 0;

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'wire-cwd-'));
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      n++;
      if (req.url?.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': `req_${n}`, 'anthropic-ratelimit-unified-5h-utilization': '0.3' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":100}}}\n\n');
        setTimeout(() => {
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"héllo"}}\n\n');
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n');
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }, 30);
      } else {
        res.writeHead(401, { 'content-type': 'application/json', 'request-id': `req_${n}` });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'nope' } }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as any).port;
  proxy = await startWireProxy({ port: 0, upstream: { protocol: 'http:', host: '127.0.0.1', port: upstreamPort } });
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  await fs.rm(cwd, { recursive: true, force: true });
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 2000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('SseParser', () => {
  it('splits events on blank lines, parses JSON data, keeps non-JSON raw', () => {
    const p = new SseParser();
    p.feed('event: ping\ndata: {"type":"ping"}\n\nevent: x\ndata: not json\n\ndata: {"partial', 0.5);
    expect(p.events).toEqual([
      { t: 0.5, event: 'ping', data: { type: 'ping' } },
      { t: 0.5, event: 'x', data: 'not json' },
    ]);
    p.feed('":1}\n\n', 0.75);
    expect(p.events[2]).toEqual({ t: 0.75, event: null, data: { partial: 1 } });
  });
});

describe('wire proxy', () => {
  it('reports its base url while running', () => {
    expect(wireBaseUrl()).toBe(proxy.baseUrl);
  });

  it('streams SSE through, strips accept-encoding, redacts credentials, and records the exchange', async () => {
    _resetWireRegistry();
    seen = [];
    registerWireSession('sess-A', cwd);
    const t0 = Date.now();
    const r = await fetch(`${proxy.baseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
        'accept-encoding': 'gzip',
        'x-claude-code-session-id': 'sess-A',
        'anthropic-beta': 'a,b',
      },
      body: JSON.stringify({ model: 'claude-fable-5-1', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('request-id')).toBe('req_1');
    const text = await r.text();
    expect(text).toContain('héllo');
    expect(text.endsWith('data: {"type":"message_stop"}\n\n')).toBe(true);

    // upstream saw the credential but no accept-encoding; host rewritten
    expect(seen[0].authorization).toBe('Bearer secret-token');
    expect(seen[0]['accept-encoding']).toBeUndefined();
    expect(seen[0].host).toBe('127.0.0.1');

    const recs = await waitFor(async () => {
      const rs = await readWireRecords(wireDir(cwd, 'sess-A'));
      return rs.length ? rs : null;
    });
    expect(recs).toHaveLength(1);
    const rec = recs[0];
    expect(rec.schema).toBe('wire/1');
    expect(rec.session_id).toBe('sess-A');
    expect(rec.request_id).toBe('req_1');
    expect(rec.status).toBe(200);
    expect(rec.method).toBe('POST');
    expect(rec.path).toBe('/v1/messages?beta=true');
    expect(rec.req_headers.authorization).toBe('<redacted>');
    expect(rec.req_headers['anthropic-beta']).toBe('a,b');
    expect(rec.req_headers['accept-encoding']).toBeUndefined();
    expect((rec.req_body as any).model).toBe('claude-fable-5-1');
    expect(rec.req_bytes).toBeGreaterThan(50);
    expect(rec.resp_headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.3');
    expect(rec.sse_events?.map((e) => e.event)).toEqual(['message_start', 'content_block_delta', 'message_delta', 'message_stop']);
    expect((rec.sse_events![1].data as any).delta.text).toBe('héllo');
    expect(rec.sse_events![1].t).toBeGreaterThanOrEqual(rec.sse_events![0].t);
    expect(rec.ttfb_ms).toBeGreaterThanOrEqual(0);
    expect(rec.total_ms).toBeGreaterThanOrEqual(rec.ttfb_ms!);
    expect(rec.total_ms).toBeLessThan(Date.now() - t0 + 1);
    expect(rec.client_disconnected).toBe(false);
    expect(rec.upstream_error).toBeNull();
    expect(rec.resp_body).toBeNull();
  });

  it('buffers records for an unregistered session and flushes them on registration', async () => {
    _resetWireRegistry();
    const r = await fetch(`${proxy.baseUrl}/v1/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'sess-B' },
      body: '{"x":1}',
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ type: 'error' });
    await new Promise((res) => setTimeout(res, 50));
    expect(await readWireRecords(wireDir(cwd, 'sess-B'))).toEqual([]);

    registerWireSession('sess-B', cwd);
    const recs = await waitFor(async () => {
      const rs = await readWireRecords(wireDir(cwd, 'sess-B'));
      return rs.length ? rs : null;
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ status: 401, request_id: 'req_2', sse_events: null });
    expect((recs[0].resp_body as any).error.type).toBe('authentication_error');
  });

  it('answers 502 with upstream_error when the upstream is unreachable', async () => {
    const dead = await startWireProxy({ port: 0, upstream: { protocol: 'http:', host: '127.0.0.1', port: 1 } });
    try {
      _resetWireRegistry();
      registerWireSession('sess-C', cwd);
      const r = await fetch(`${dead.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-claude-code-session-id': 'sess-C' }, body: '{}' });
      expect(r.status).toBe(502);
      expect((await r.json()).error.type).toBe('proxy_error');
      const recs = await waitFor(async () => {
        const rs = await readWireRecords(wireDir(cwd, 'sess-C'));
        return rs.length ? rs : null;
      });
      expect(recs[0].status).toBe(502);
      expect(recs[0].upstream_error).toMatch(/ECONNREFUSED|connect/i);
      expect(recs[0].request_id).toBeNull();
    } finally {
      await dead.close();
      // the first proxy is still the running one for wireBaseUrl()
    }
  });

  it('serves a health endpoint without touching the upstream', async () => {
    const r = await fetch(`${proxy.baseUrl}/_aie/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
});
