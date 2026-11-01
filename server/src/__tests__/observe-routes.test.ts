import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getObservation, getWireRecord, observationEtag } from '../observe/routes.js';
import { encodeCwd } from '../observe/transcript.js';

// Fake HOME with one project transcript; cwd is the project path whose encoded
// form names the transcript directory (model: server.AssembleObservation).
let home: string;
let cwd: string;
const sid = 'sess-1';
const line = (o: unknown) => JSON.stringify(o) + '\n';

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'observe-home-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'observe-cwd-'));
  const dir = path.join(home, '.claude', 'projects', encodeCwd(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${sid}.jsonl`),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-31T10:00:00.000Z', message: { role: 'user', content: 'hi' } }) +
      line({ type: 'assistant', uuid: 'g1', timestamp: '2026-10-31T10:00:01.000Z', requestId: 'req_1', message: { id: 'm1', model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: { input_tokens: 1 }, content: [{ type: 'text', text: 'hello' }] } }),
  );
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

describe('observationEtag', () => {
  it('is null when the main transcript is missing', async () => {
    expect(await observationEtag(cwd, 'nope', home)).toBeNull();
  });
  it('changes when the transcript grows or a wire record appears', async () => {
    const a = await observationEtag(cwd, sid, home);
    expect(a).toMatch(/^".+"$/);
    const file = path.join(home, '.claude', 'projects', encodeCwd(cwd), `${sid}.jsonl`);
    await fs.appendFile(file, line({ type: 'user', uuid: 'u2', timestamp: '2026-10-31T10:00:05.000Z', message: { role: 'user', content: 'more' } }));
    const b = await observationEtag(cwd, sid, home);
    expect(b).not.toBe(a);
    const wdir = path.join(cwd, '.aie', 'observations', 'wire', sid);
    await fs.mkdir(wdir, { recursive: true });
    await fs.writeFile(path.join(wdir, '0001.json'), JSON.stringify({ schema: 'wire/1', request_id: 'req_1', status: 200, req_body: {}, resp_headers: {}, sse_events: [] }));
    const c = await observationEtag(cwd, sid, home);
    expect(c).not.toBe(b);
  });
});

describe('getObservation', () => {
  it('assembles, attaches wire, and reuses the cached result while the etag is unchanged', async () => {
    const r1 = await getObservation(cwd, sid, home);
    expect(r1).not.toBeNull();
    expect(r1!.conversations).toHaveLength(1);
    expect(r1!.conversations[0].turns).toHaveLength(2);
    expect(r1!.wire).toEqual({ matched: 1, orphans: 0 });
    expect(r1!.etag).toBe(await observationEtag(cwd, sid, home));
    const r2 = await getObservation(cwd, sid, home);
    expect(r2).toBe(r1);
    expect(await getObservation(cwd, 'nope', home)).toBeNull();
  });
});

describe('getWireRecord (server.ServeWireRecord)', () => {
  it('finds a record by request_id, takes the last one on duplicates, and by seq-<n> for orphans', async () => {
    const wdir = path.join(cwd, '.aie', 'observations', 'wire', sid);
    await fs.mkdir(wdir, { recursive: true });
    await fs.writeFile(path.join(wdir, '0002.json'), JSON.stringify({ schema: 'wire/1', seq: 2, request_id: 'req_1', status: 200, req_body: { model: 'later' }, resp_headers: {}, sse_events: [] }));
    await fs.writeFile(path.join(wdir, '0003.json'), JSON.stringify({ schema: 'wire/1', seq: 3, request_id: null, status: null, upstream_error: 'ECONNREFUSED', req_body: {}, resp_headers: {}, sse_events: null }));
    const byRid = await getWireRecord(cwd, sid, 'req_1');
    expect(byRid?.seq).toBe(2);
    expect((byRid?.req_body as { model: string }).model).toBe('later');
    expect((await getWireRecord(cwd, sid, 'seq-3'))?.upstream_error).toBe('ECONNREFUSED');
    expect(await getWireRecord(cwd, sid, 'req_nope')).toBeNull();
    expect(await getWireRecord(cwd, sid, 'seq-99')).toBeNull();
    expect(await getWireRecord(cwd, 'no-such-session', 'req_1')).toBeNull();
  });
});
