import { describe, expect, it } from 'vitest';
import { assembleSession } from '../observe/assemble.js';
import { attachWire, cacheBreakpoints, wireRequestSummary, wireResponseSummary, type WireRecord } from '../observe/wire.js';
import type { TranscriptEntry } from '../observe/transcript.js';
import type { GenerationAction } from '../observe/types.js';

const entries: TranscriptEntry[] = [
  { type: 'user', uuid: 'u1', timestamp: '2026-10-31T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
  {
    type: 'assistant',
    uuid: 'g1',
    timestamp: '2026-10-31T10:00:03.000Z',
    requestId: 'req_A',
    message: { id: 'm1', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: { input_tokens: 2 }, content: [{ type: 'text', text: 'hello' }] },
  },
];

function record(over: Partial<WireRecord>): WireRecord {
  return {
    schema: 'wire/1',
    seq: 1,
    session_id: 'S',
    request_id: 'req_A',
    captured_at: '2026-10-31T10:00:00.500Z',
    t_start: 1,
    t_first_byte: 1.2,
    t_end: 1.5,
    ttfb_ms: 200,
    total_ms: 500,
    method: 'POST',
    path: '/v1/messages?beta=true',
    req_headers: { 'anthropic-beta': 'a-beta, b-beta', 'X-Stainless-Retry-Count': '1', Authorization: '<redacted>' },
    req_bytes: 1234,
    req_body: {
      model: 'claude-fable-5-1',
      max_tokens: 64000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'sys-a' }, { type: 'text', text: 'sys-bb', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [{ name: 'Bash', description: 'x', input_schema: {} }, { name: 'Read', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'yo' },
      ],
    },
    status: 200,
    resp_headers: {
      'request-id': 'req_A',
      'Content-Type': 'text/event-stream',
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-reset': '1792854000',
    },
    upstream_error: null,
    client_disconnected: false,
    sse_events: [
      { t: 0.2, event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 100 } } } },
      { t: 0.21, event: 'content_block_start', data: { type: 'content_block_start' } },
      { t: 0.3, event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } } },
      { t: 0.35, event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'llo' } } },
      { t: 0.49, event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { t: 0.5, event: 'message_stop', data: { type: 'message_stop' } },
    ],
    resp_body: null,
    ...over,
  };
}

describe('countWireRecords', () => {
  it('counts *.json files and returns 0 for a missing directory', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { countWireRecords } = await import('../observe/wire.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wire-count-'));
    await fs.writeFile(path.join(dir, 'a.json'), '{}');
    await fs.writeFile(path.join(dir, 'b.json'), '{}');
    await fs.writeFile(path.join(dir, 'notes.txt'), '');
    expect(await countWireRecords(dir)).toBe(2);
    expect(await countWireRecords(path.join(dir, 'missing'))).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('wireRequestSummary', () => {
  it('summarizes params, betas, system blocks, tools, message layout and cache breakpoints', () => {
    const s = wireRequestSummary(record({}));
    expect(s.req_bytes).toBe(1234);
    expect(s.retry_count).toBe(1);
    expect(s.params).toEqual({ max_tokens: 64000, thinking: { type: 'adaptive' }, effort: 'high', context_management: undefined, stream: true });
    expect(s.betas).toEqual(['a-beta', 'b-beta']);
    expect(s.system_blocks).toEqual([{ chars: 5, cached: false }, { chars: 6, cached: true }]);
    expect(s.tools.count).toBe(2);
    expect(s.tools.names).toEqual(['Bash', 'Read']);
    expect(s.messages.count).toBe(2);
    expect(s.messages.layout[0]).toEqual({ role: 'user', blocks: [{ type: 'text', chars: 2 }] });
    expect(s.messages.layout[1]).toEqual({ role: 'assistant', blocks: [{ type: 'str', chars: 2 }] });
    expect(s.cache_breakpoints).toEqual([
      { at: 'tools[Read]', ttl: '5m' },
      { at: 'system[1]', ttl: '1h' },
      { at: 'messages[0].0', ttl: '5m' },
    ]);
  });

  it('handles a string system prompt and a non-object body', () => {
    expect(wireRequestSummary(record({ req_body: { system: 'abc' } })).system_blocks).toEqual([{ chars: 3, cached: false }]);
    expect(cacheBreakpoints({})).toEqual([]);
    expect(wireRequestSummary(record({ req_body: 'garbage' })).tools.count).toBe(0);
  });
});

describe('wireResponseSummary', () => {
  it('derives usage, stop_reason, ttft and ratelimit from the SSE stream and headers', () => {
    const s = wireResponseSummary(record({}));
    expect(s).toMatchObject({ request_id: 'req_A', status: 200, ttfb_ms: 200, ttft_ms: 300, total_ms: 500, stop_reason: 'end_turn', sse_events: 6 });
    expect(s.usage).toEqual({ input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5 });
    expect(s.ratelimit).toEqual({ '5h-utilization': '0.25', status: 'allowed' });
  });

  it('falls back to the JSON body for non-streaming responses', () => {
    const s = wireResponseSummary(record({ sse_events: null, resp_body: { usage: { input_tokens: 9 }, stop_reason: 'max_tokens' } }));
    expect(s.usage).toEqual({ input_tokens: 9 });
    expect(s.stop_reason).toBe('max_tokens');
    expect(s.ttft_ms).toBeNull();
    expect(s.sse_events).toBe(0);
  });
});

describe('attachWire', () => {
  it('joins a record to its generation by request_id and reports orphans with a reason', () => {
    const convs = assembleSession('S', entries);
    const res = attachWire(convs, [
      record({}),
      record({ seq: 2, request_id: 'req_B', status: 529, upstream_error: null }),
      record({ seq: 3, request_id: null, status: 502, upstream_error: 'ConnectionRefused' }),
      record({ seq: 4, request_id: 'req_C', status: 200, path: '/v1/messages/count_tokens' }),
    ]);
    expect(res).toEqual({ matched: 1, orphans: 3 });
    const gen = convs[0].turns[0].actions[1] as GenerationAction;
    expect(gen.payload.wire?.tools.count).toBe(2);
    expect(gen.result.wire?.ttfb_ms).toBe(200);
    expect(convs[0].wire_orphans.map((o) => o.reason)).toEqual(['http_529', 'upstream_error', 'no_matching_generation']);
    expect(convs[0].wire_orphans[0].model).toBe('claude-fable-5-1');
    expect(convs[0].meta.wire).toEqual({ generations_with_wire: 1, orphans: 3 });
  });

  it('keeps the latest record when the same request_id was captured twice', () => {
    const convs = assembleSession('S', entries);
    attachWire(convs, [record({ seq: 1, ttfb_ms: 100 }), record({ seq: 2, ttfb_ms: 999 })]);
    const gen = convs[0].turns[0].actions[1] as GenerationAction;
    expect(gen.result.wire?.ttfb_ms).toBe(999);
    expect(convs[0].wire_orphans).toEqual([]);
  });

  it('is a no-op without records', () => {
    const convs = assembleSession('S', entries);
    expect(attachWire(convs, [])).toEqual({ matched: 0, orphans: 0 });
    expect(convs[0].meta.wire).toBeUndefined();
  });
});
