import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { getProject } from './store.js';
import { getUserId } from './auth.js';
import type { FastifyRequest } from 'fastify';

// mime-types is a web-server table: `.ts` is an MPEG transport stream, `.rs`
// is an XML dialect, and most source extensions are simply unknown. Editor
// semantics win here so the viewer renders code as text and the browser
// never tries to play a TypeScript file.
const SOURCE_MIME: Record<string, string> = {
  ts: 'text/typescript', mts: 'text/typescript', cts: 'text/typescript', tsx: 'text/tsx',
  jsx: 'text/jsx', mjs: 'text/javascript', cjs: 'text/javascript',
  py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust',
  java: 'text/x-java', kt: 'text/x-kotlin', kts: 'text/x-kotlin', swift: 'text/x-swift',
  c: 'text/x-c', h: 'text/x-c', cc: 'text/x-c++', cpp: 'text/x-c++', hh: 'text/x-c++', hpp: 'text/x-c++',
  cs: 'text/x-csharp', php: 'text/x-php', lua: 'text/x-lua', vim: 'text/x-vim',
  sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript', fish: 'text/x-shellscript',
  vue: 'text/x-vue', svelte: 'text/x-svelte',
  jsonc: 'application/json', json5: 'application/json',
  env: 'text/plain', lock: 'text/plain',
};
const TEXT_BASENAMES = new Set([
  'makefile', 'license', 'codeowners', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc',
]);

export function lookupMime(file: string): string {
  const base = path.basename(file).toLowerCase();
  if (TEXT_BASENAMES.has(base) || base.startsWith('dockerfile') || base.startsWith('.env')) {
    return 'text/plain';
  }
  const ext = path.extname(base).slice(1);
  if (ext && SOURCE_MIME[ext]) return SOURCE_MIME[ext];
  return mime.lookup(file) || 'application/octet-stream';
}

// Model: server.ListDir rule-217 — every relative path is pinned under the
// project root; `../` escapes are a 400, never a filesystem access.
export function resolveRel(root: string, rel: string): string {
  const abs = path.resolve(root, (rel || '').replace(/^\/+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error('path escapes project root'), { code: 400 });
  }
  return abs;
}

async function resolveInProject(req: FastifyRequest, projectId: string, rel: string) {
  const uid = getUserId(req);
  if (!uid) throw Object.assign(new Error('unauthorized'), { code: 401 });
  const project = await getProject(uid, projectId);
  if (!project) throw Object.assign(new Error('project not found'), { code: 404 });
  const abs = resolveRel(project.path, rel);
  return { project, abs };
}

function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

// Model: server.MoveEntry rule-407 / rule-409 — the pure path half of a move
// (rename = move within the same parent). Existence checks happen in the
// route because they need the filesystem.
export function planMove(root: string, fromRel: string, toRel: string) {
  const fromAbs = resolveRel(root, fromRel);
  const toAbs = resolveRel(root, toRel);
  if (fromAbs === root) throw Object.assign(new Error('cannot move the project root'), { code: 400 });
  if (toAbs === root) throw Object.assign(new Error('destination cannot be the project root'), { code: 400 });
  if (toAbs === fromAbs) throw Object.assign(new Error('source and destination are the same'), { code: 400 });
  if (toAbs.startsWith(fromAbs + path.sep)) {
    throw Object.assign(new Error('cannot move a directory into itself'), { code: 400 });
  }
  return { fromAbs, toAbs, fromRel: toRelPosix(root, fromAbs), toRel: toRelPosix(root, toAbs) };
}

// Model: server.MakeDir rule-414 — pure path half; existence checks in the route.
export function planMkdir(root: string, rel: string) {
  const abs = resolveRel(root, rel);
  if (abs === root) throw Object.assign(new Error('cannot create the project root'), { code: 400 });
  return { abs, rel: toRelPosix(root, abs) };
}

// ReadFile refuses >20MB; the JSON envelope around a 20MB string needs a bit
// of headroom (escapes), and Fastify's default cap is only 1MB.
const WRITE_BODY_LIMIT = 24 * 1024 * 1024;

export function registerFsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/list',
    async (req, reply) => {
      const projectId = req.query.project;
      if (!projectId) return reply.code(400).send({ error: 'project required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, req.query.path ?? ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) return reply.code(400).send({ error: 'not a directory' });
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const items = entries
        .filter((e) => !e.name.startsWith('.'))
        // rule-218: files carry their mime so the FileTree can offer
        // "Edit" for text files without a stat round-trip per row.
        .map((e) => ({
          name: e.name,
          path: path.join(req.query.path ?? '', e.name),
          isDir: e.isDirectory(),
          mime: e.isDirectory() ? undefined : lookupMime(e.name),
        }))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { path: req.query.path ?? '', items };
    },
  );

  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/file',
    async (req, reply) => {
      const projectId = req.query.project;
      const rel = req.query.path;
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (stat.size > 20 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (>20MB)' });
      }
      const type = lookupMime(abs);
      reply.header('Content-Type', type);
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(abs));
    },
  );

  // Raw file serving with the project + path encoded in the URL path itself,
  // not the query string. This is what lets HTML files load their relative
  // resources: opening /raw/<pid>/dir/page.html in a new window resolves a
  // `<link href="./style.css">` to /raw/<pid>/dir/style.css naturally — the
  // /api/fs/file?path=... shape can't do that because relative URL resolution
  // strips the query.
  app.get<{ Params: { projectId: string; '*': string } }>(
    '/raw/:projectId/*',
    async (req, reply) => {
      const projectId = req.params.projectId;
      const rel = req.params['*'] ?? '';
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (stat.size > 50 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (>50MB)' });
      }
      const type = lookupMime(abs);
      reply.header('Content-Type', type);
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'no-store');
      return reply.send(createReadStream(abs));
    },
  );

  // Model: server.MoveEntry (auc-126).
  app.post<{ Body: { project?: string; from?: string; to?: string } }>(
    '/api/fs/move',
    async (req, reply) => {
      const { project: projectId, from, to } = req.body ?? {};
      if (!projectId || !from || !to) {
        return reply.code(400).send({ error: 'project, from and to required' });
      }
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: ReturnType<typeof planMove>;
      try {
        plan = planMove(root, from, to);
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      // rule-408: source must exist, destination must not, and its parent
      // must be an existing directory. lstat so a dangling symlink at the
      // destination still counts as "exists".
      if (!(await fs.lstat(plan.fromAbs).catch(() => null))) {
        return reply.code(404).send({ error: 'source not found' });
      }
      const parentStat = await fs.stat(path.dirname(plan.toAbs)).catch(() => null);
      if (!parentStat?.isDirectory()) {
        return reply.code(400).send({ error: 'destination directory does not exist' });
      }
      if (await fs.lstat(plan.toAbs).catch(() => null)) {
        return reply.code(409).send({ error: 'destination already exists' });
      }
      await fs.rename(plan.fromAbs, plan.toAbs);
      return { from: plan.fromRel, to: plan.toRel };
    },
  );

  // Model: server.WriteFile (auc-128). Whole-file write-back for the editor
  // tab, with an optimistic-concurrency check on mtime.
  app.put<{ Body: { project?: string; path?: string; content?: string; baseMtimeMs?: number } }>(
    '/api/fs/file',
    { bodyLimit: WRITE_BODY_LIMIT },
    async (req, reply) => {
      const { project: projectId, path: rel, content, baseMtimeMs } = req.body ?? {};
      if (!projectId || !rel || typeof content !== 'string') {
        return reply.code(400).send({ error: 'project, path and content required' });
      }
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const before = await fs.stat(abs).catch(() => null);
      if (!before) return reply.code(404).send({ error: 'file not found' });
      if (!before.isFile()) return reply.code(400).send({ error: 'not a file' });
      if (typeof baseMtimeMs === 'number' && before.mtimeMs !== baseMtimeMs) {
        return reply.code(409).send({ error: 'file changed on disk', mtimeMs: before.mtimeMs });
      }
      await fs.writeFile(abs, content, 'utf8');
      const after = await fs.stat(abs);
      return { path: rel, size: after.size, mtimeMs: after.mtimeMs };
    },
  );

  // Model: server.MakeDir (auc-127).
  app.post<{ Body: { project?: string; path?: string } }>(
    '/api/fs/mkdir',
    async (req, reply) => {
      const { project: projectId, path: rel } = req.body ?? {};
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let root: string;
      try {
        ({ project: { path: root } } = await resolveInProject(req, projectId, ''));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      let plan: ReturnType<typeof planMkdir>;
      try {
        plan = planMkdir(root, rel);
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      // rule-415: one level only — the parent must already be a directory.
      const parentStat = await fs.stat(path.dirname(plan.abs)).catch(() => null);
      if (!parentStat?.isDirectory()) {
        return reply.code(400).send({ error: 'parent directory does not exist' });
      }
      if (await fs.lstat(plan.abs).catch(() => null)) {
        return reply.code(409).send({ error: 'already exists' });
      }
      await fs.mkdir(plan.abs);
      return { path: plan.rel };
    },
  );

  app.get<{ Querystring: { project?: string; path?: string } }>(
    '/api/fs/stat',
    async (req, reply) => {
      const projectId = req.query.project;
      const rel = req.query.path;
      if (!projectId || !rel) return reply.code(400).send({ error: 'project and path required' });
      let abs: string;
      try {
        ({ abs } = await resolveInProject(req, projectId, rel));
      } catch (e: any) {
        return reply.code(e.code ?? 400).send({ error: e.message });
      }
      const stat = await fs.stat(abs);
      const type = stat.isDirectory() ? 'dir' : lookupMime(abs);
      return { path: rel, size: stat.size, isDir: stat.isDirectory(), mime: type, mtimeMs: stat.mtimeMs };
    },
  );
}
