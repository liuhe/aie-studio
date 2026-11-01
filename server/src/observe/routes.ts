// Model: server.AssembleObservation — GET /api/projects/:id/observe/:kind/:sid
// 按需装配一个会话的观察数据并返回；按文件 mtime 做 ETag 与内存缓存；只读、不 spawn。

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getProject } from '../store.js';
import { getUserId } from '../auth.js';
import { assembleClaudeSession, type AssembledSession } from './index.js';
import { subagentsDir, transcriptPath } from './transcript.js';
import { findWireRecord, wireDir, type WireRecord } from './wire.js';
import { assembleDevinObservation, devinSessionSignature } from './devin-adapter.js';
import { openDevinDb } from '../devin-db.js';

export interface ObservationResponse extends AssembledSession {
  etag: string;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WIRE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 目录下所有文件（不递归）的 mtime 最大值与数量；目录不存在 → 0 / 0 */
async function dirSignature(dir: string): Promise<{ mtime: number; count: number }> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let mtime = 0;
  let count = 0;
  for (const n of names) {
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (!st || !st.isFile()) continue;
    count++;
    if (st.mtimeMs > mtime) mtime = st.mtimeMs;
  }
  return { mtime, count };
}

/**
 * 装配输入的签名：主 jsonl mtime+size、subagents 目录、wire 目录。
 * 主 transcript 不存在返回 null（→ 404）。
 */
export async function observationEtag(cwd: string, sessionId: string, home = os.homedir()): Promise<string | null> {
  const main = await fs.stat(transcriptPath(cwd, sessionId, home)).catch(() => null);
  if (!main || !main.isFile()) return null;
  const sub = await dirSignature(subagentsDir(cwd, sessionId, home));
  const wire = await dirSignature(wireDir(cwd, sessionId));
  return `"${Math.round(main.mtimeMs)}-${main.size}-${Math.round(sub.mtime)}-${sub.count}-${Math.round(wire.mtime)}-${wire.count}"`;
}

const cache = new Map<string, ObservationResponse>();

/** 读缓存或重新装配。返回 null 表示主 transcript 不存在。 */
export async function getObservation(cwd: string, sessionId: string, home = os.homedir()): Promise<ObservationResponse | null> {
  const etag = await observationEtag(cwd, sessionId, home);
  if (etag === null) return null;
  const key = `${home}\u0000${cwd}\u0000${sessionId}`;
  const hit = cache.get(key);
  if (hit && hit.etag === etag) return hit;
  const assembled = await assembleClaudeSession(cwd, sessionId, home);
  const res: ObservationResponse = { ...assembled, etag };
  cache.set(key, res);
  return res;
}

const devinCache = new Map<string, ObservationResponse>();

/**
 * Devin: the ETag is a DB query (last_activity_at, chain head, node / tool
 * counts) rather than file mtimes — sessions.db is one file for every session.
 * Returns null (unknown session / other cwd), 'unchanged' (ETag hit) or the
 * assembled response.
 */
export function getDevinObservation(cwd: string, sessionId: string, ifNoneMatch?: string, dbPath?: string): ObservationResponse | 'unchanged' | null {
  const db = openDevinDb(dbPath);
  if (!db) return null;
  let sig: { cwd: string; etag: string } | null;
  try {
    sig = devinSessionSignature(sessionId, db);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  if (!sig || sig.cwd !== cwd) return null;
  if (ifNoneMatch && ifNoneMatch === sig.etag) return 'unchanged';
  const key = `${cwd}\u0000${sessionId}`;
  const hit = devinCache.get(key);
  if (hit && hit.etag === sig.etag) return hit;
  const assembled = assembleDevinObservation(sessionId, cwd, dbPath);
  if (!assembled) return null;
  const res: ObservationResponse = { ...assembled, etag: sig.etag };
  devinCache.set(key, res);
  return res;
}

/** server.ServeWireRecord：一条完整的 wire 原件；null = 没有 */
export function getWireRecord(cwd: string, sessionId: string, key: string): Promise<WireRecord | null> {
  return findWireRecord(wireDir(cwd, sessionId), key);
}

export function registerObserveRoutes(app: FastifyInstance) {
  // Model: server.ServeWireRecord — 原件按需读，不进装配缓存
  app.get<{ Params: { id: string; kind: string; sid: string; key: string } }>(
    '/api/projects/:id/observe/:kind/:sid/wire/:key',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const { kind, sid, key } = req.params;
      if (!SESSION_ID_RE.test(sid)) return reply.code(400).send({ error: 'invalid session id' });
      if (!WIRE_KEY_RE.test(key)) return reply.code(400).send({ error: 'invalid wire key' });
      if (kind !== 'session') return reply.code(404).send({ error: 'no wire layer for this session kind' });
      const rec = await getWireRecord(project.path, sid, key);
      if (!rec) return reply.code(404).send({ error: 'wire record not found' });
      return reply.header('Cache-Control', 'private, max-age=3600').send(rec);
    },
  );


  app.get<{ Params: { id: string; kind: string; sid: string } }>(
    '/api/projects/:id/observe/:kind/:sid',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });

      const { kind, sid } = req.params;
      if (!SESSION_ID_RE.test(sid)) return reply.code(400).send({ error: 'invalid session id' });
      if (kind === 'devin') {
        const res = getDevinObservation(project.path, sid, req.headers['if-none-match']);
        if (res === null) return reply.code(404).send({ error: 'devin session not found' });
        if (res === 'unchanged') return reply.code(304).header('ETag', req.headers['if-none-match'] as string).send();
        return reply.header('ETag', res.etag).header('Cache-Control', 'no-cache').send(res);
      }
      if (kind !== 'session') return reply.code(400).send({ error: `unknown kind: ${kind}` });

      // 先只算签名：命中 If-None-Match 就不装配
      const etag = await observationEtag(project.path, sid);
      if (etag === null) return reply.code(404).send({ error: 'session transcript not found' });
      if (req.headers['if-none-match'] === etag) return reply.code(304).header('ETag', etag).send();

      const res = await getObservation(project.path, sid);
      if (!res) return reply.code(404).send({ error: 'session transcript not found' });
      return reply.header('ETag', res.etag).header('Cache-Control', 'no-cache').send(res);
    },
  );
}
