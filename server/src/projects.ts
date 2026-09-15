import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  listProjects,
  addProject,
  deleteProject,
  getProject,
  getWorkspace,
  putWorkspace,
  putProjectWorkspace,
  getSettings,
  putSettings,
  type Workspace,
  type ProjectWorkspace,
  type Settings,
} from './store.js';
import { getUserId } from './auth.js';

function encodeCwd(cwd: string): string {
  // Claude Code stores sessions under ~/.claude/projects/<cwd with / replaced by ->
  return cwd.replace(/\//g, '-');
}

export function registerProjectRoutes(app: FastifyInstance) {
  app.get('/api/projects', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return listProjects(uid);
  });

  app.post<{ Body: { path: string; name?: string } }>('/api/projects', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body?.path) return reply.code(400).send({ error: 'path required' });
    try {
      const p = await addProject(uid, req.body);
      return p;
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    await deleteProject(uid, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(project.path));
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      return { sessions: [] };
    }
    const items = await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map(async (f) => {
          const full = path.join(dir, f);
          const st = await fs.stat(full);
          const uuid = f.replace(/\.jsonl$/, '');
          // Scan the head of the file for the first user text message (skipping
          // housekeeping records like permission-mode / file-history-snapshot).
          let preview = '';
          try {
            const fd = await fs.open(full, 'r');
            const buf = Buffer.alloc(Math.min(st.size, 65536));
            const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
            await fd.close();
            const head = buf.toString('utf8', 0, bytesRead);
            for (const line of head.split('\n')) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.type !== 'user') continue;
                const content = obj?.message?.content;
                if (typeof content === 'string') { preview = content; break; }
                if (Array.isArray(content)) {
                  const t = content.find((c: any) => c.type === 'text')?.text;
                  if (t) { preview = t; break; }
                }
              } catch {}
            }
          } catch {}
          return {
            uuid,
            mtime: st.mtimeMs,
            size: st.size,
            preview: preview.slice(0, 120),
          };
        }),
    );
    items.sort((a, b) => b.mtime - a.mtime);
    return { sessions: items };
  });

  app.get<{
    Params: { id: string; uuid: string };
    Querystring: { limit?: string; before?: string };
  }>(
    '/api/projects/:id/sessions/:uuid/transcript',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const file = path.join(
        os.homedir(),
        '.claude',
        'projects',
        encodeCwd(project.path),
        `${req.params.uuid}.jsonl`,
      );
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (e: any) {
        if (e.code === 'ENOENT') return reply.code(404).send({ error: 'transcript not found' });
        throw e;
      }
      const all: any[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' || obj.type === 'assistant') all.push(obj);
        } catch {}
      }
      const total = all.length;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 20));
      const endIdx =
        req.query.before !== undefined
          ? Math.max(0, Math.min(total, Number(req.query.before)))
          : total;
      const startIdx = Math.max(0, endIdx - limit);
      return {
        events: all.slice(startIdx, endIdx),
        startIndex: startIdx,
        endIndex: endIdx,
        total,
      };
    },
  );

  app.get('/api/workspace', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return getWorkspace(uid);
  });

  app.put<{ Body: Workspace }>('/api/workspace', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body || typeof req.body !== 'object') {
      return reply.code(400).send({ error: 'invalid body' });
    }
    return putWorkspace(uid, req.body);
  });

  // Per-project workspace update — merges only this project's slot so a
  // client PUT for project X can't overwrite project Y's tab list. See the
  // corresponding client-side saveProjectTabs in App.tsx.
  app.put<{ Params: { pid: string }; Body: ProjectWorkspace }>(
    '/api/workspace/projects/:pid',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const body = req.body as any;
      if (!body || typeof body !== 'object' || !Array.isArray(body.tabs)) {
        return reply.code(400).send({ error: 'invalid body' });
      }
      if (body.groups !== undefined && !Array.isArray(body.groups)) {
        return reply.code(400).send({ error: 'invalid body' });
      }
      return putProjectWorkspace(uid, req.params.pid, body);
    },
  );

  app.get('/api/settings', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return getSettings(uid);
  });

  app.put<{ Body: Settings }>('/api/settings', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    if (!req.body || typeof req.body !== 'object') {
      return reply.code(400).send({ error: 'invalid body' });
    }
    return putSettings(uid, req.body);
  });
}
