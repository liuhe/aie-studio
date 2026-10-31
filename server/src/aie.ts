import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getProject } from './store.js';
import { getUserId } from './auth.js';

export type SkillMeta = {
  name: string;
  description: string;
  source: string;
};

export type AgentMeta = {
  name: string;
  description: string;
  tools: string;
  source: string;
};

export type AieTestCase = {
  slug: string;
  name: string;
  description: string;
  created: string;
  criteriaCount: number;
  source: string;
};

export type AieTestVerdict = 'passed' | 'failed' | 'skipped';

export type AieTestReportSummary = {
  file: string;
  timestamp: string;
  caseSlug: string;
  caseName: string;
  verdict: AieTestVerdict;
  severity: string | null;
  fixRound: number | null;
  durationMs: number | null;
  commitSha: string | null;
};

// Parsed shape of an aie test case frontmatter. Only the fields the tab needs
// are typed; everything else is kept as-is in `extra`.
export type CaseFrontmatter = {
  name?: string;
  description?: string;
  created?: string;
  prompt?: string;
  criteria: string[];
  extra: Record<string, string | string[]>;
};

export type AieProjectMeta = {
  name: string;
  overviewSummary: string;
  hasTasks: boolean;
  hasLog: boolean;
  hasDesign: boolean;
};

// Minimal YAML frontmatter extractor. Only handles the flat `key: value` shape
// used by Claude Code skills/agents — no nested structures, no multiline
// scalars. Returns {} if no frontmatter fence is present.
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const body = text.slice(3, end).replace(/^\r?\n/, '');
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function scanSkills(projectPath: string): Promise<SkillMeta[]> {
  const dir = path.join(projectPath, '.claude', 'skills');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: SkillMeta[] = [];
  for (const ent of entries) {
    // Two layouts: <name>/SKILL.md or <name>.md
    let src: string | null = null;
    if (ent.isDirectory()) {
      const p = path.join(dir, ent.name, 'SKILL.md');
      if (await readTextSafe(p)) src = p;
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      src = path.join(dir, ent.name);
    }
    if (!src) continue;
    const text = await readTextSafe(src);
    if (text == null) continue;
    const fm = parseFrontmatter(text);
    const name = fm.name || ent.name.replace(/\.md$/, '');
    out.push({
      name,
      description: fm.description || '',
      source: path.relative(projectPath, src),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function scanAgents(projectPath: string): Promise<AgentMeta[]> {
  const dir = path.join(projectPath, '.claude', 'agents');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: AgentMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const src = path.join(dir, f);
    const text = await readTextSafe(src);
    if (text == null) continue;
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name || f.replace(/\.md$/, ''),
      description: fm.description || '',
      tools: fm.tools || '',
      source: path.relative(projectPath, src),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function scanAieProjects(projectPath: string): Promise<AieProjectMeta[]> {
  const dir = path.join(projectPath, 'projects');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: AieProjectMeta[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const base = path.join(dir, ent.name);
    const overview = await readTextSafe(path.join(base, 'overview.md'));
    if (overview == null) continue; // overview.md is required per aie convention
    // First non-heading, non-empty paragraph as summary.
    const summary = firstParagraph(overview);
    const [hasTasks, hasLog, hasDesign] = await Promise.all([
      fileExists(path.join(base, 'tasks.md')),
      fileExists(path.join(base, 'log.md')),
      fileExists(path.join(base, 'design.md')),
    ]);
    out.push({ name: ent.name, overviewSummary: summary, hasTasks, hasLog, hasDesign });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function firstParagraph(md: string): string {
  const lines = md.split('\n');
  const buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buf.length) break;
      continue;
    }
    if (line.startsWith('#')) continue;
    buf.push(line);
  }
  return buf.join(' ').slice(0, 500);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Frontmatter parser for .claude/aie-tests/*.md. Handles the YAML subset the
// aie-test-add skill emits: flat scalars, `key: |` block scalars, and
// `key:\n  - item` lists. No nested maps, no flow syntax, no anchors.
export function parseCaseFrontmatter(text: string): CaseFrontmatter | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const body = text.slice(3, end).replace(/^\r?\n/, '');
  const lines = body.split('\n');
  const out: CaseFrontmatter = { criteria: [], extra: {} };
  const set = (k: string, v: string | string[]) => {
    if (k === 'criteria') out.criteria = Array.isArray(v) ? v : v ? [v] : [];
    else if (k === 'name' || k === 'description' || k === 'created' || k === 'prompt') {
      out[k] = Array.isArray(v) ? v.join('\n') : v;
    } else out.extra[k] = v;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let rest = m[2].trim();
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      // Block scalar: collect indented lines.
      const buf: string[] = [];
      let indent = -1;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { buf.push(''); i++; continue; }
        const lead = l.match(/^(\s*)/)![1].length;
        if (lead === 0) break;
        if (indent < 0) indent = lead;
        buf.push(l.slice(Math.min(indent, lead)));
        i++;
      }
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      const joined = rest.startsWith('>') ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n');
      set(key, joined);
      continue;
    }
    if (rest === '' || rest === '[]') {
      // Possibly a list on following lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const lm = lines[j].match(/^\s+-\s*(.*)$/);
        if (!lm) break;
        items.push(unquote(lm[1].trim()));
        j++;
      }
      if (items.length || rest === '[]') {
        set(key, items);
        i = items.length ? j : i + 1;
        continue;
      }
      set(key, '');
      i++;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      set(key, inner ? inner.split(',').map((x) => unquote(x.trim())) : []);
      i++;
      continue;
    }
    set(key, unquote(rest));
    i++;
  }
  return out;
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

export const CASE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const CASE_SLUG_MAX = 64;
export const REPORT_FILE_RE = /^\d{8}-\d{6}__[a-z0-9-]+\.json$/;

export function isValidCaseSlug(slug: string): boolean {
  return CASE_SLUG_RE.test(slug) && slug.length <= CASE_SLUG_MAX;
}

function testsDir(projectPath: string): string {
  return path.join(projectPath, '.claude', 'aie-tests');
}
function reportsDir(projectPath: string): string {
  return path.join(projectPath, '.aie', 'test-reports');
}
function casePath(projectPath: string, slug: string): string {
  return path.join(testsDir(projectPath), `${slug}.md`);
}

// Returns a human-readable reason when the case text is not acceptable, else null.
export function validateCaseText(text: string): string | null {
  const fm = parseCaseFrontmatter(text);
  if (!fm) return 'missing frontmatter (--- fence)';
  if (!fm.name?.trim()) return 'frontmatter missing required field: name';
  if (!fm.prompt?.trim()) return 'frontmatter missing required field: prompt';
  if (!fm.criteria.some((c) => c.trim())) return 'frontmatter missing required field: criteria (non-empty list)';
  return null;
}

export async function scanTestCases(projectPath: string): Promise<AieTestCase[]> {
  const dir = testsDir(projectPath);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: AieTestCase[] = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const slug = f.slice(0, -3);
    if (!isValidCaseSlug(slug)) continue;
    const text = await readTextSafe(path.join(dir, f));
    if (text == null) continue;
    const fm = parseCaseFrontmatter(text);
    out.push({
      slug,
      name: fm?.name || slug,
      description: fm?.description || '',
      created: fm?.created || '',
      criteriaCount: fm?.criteria.length ?? 0,
      source: path.posix.join('.claude', 'aie-tests', f),
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export async function readTestCase(projectPath: string, slug: string): Promise<string | null> {
  return readTextSafe(casePath(projectPath, slug));
}

export type WriteCaseResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

export async function writeTestCase(
  projectPath: string,
  slug: string,
  text: string,
  opts: { create?: boolean } = {},
): Promise<WriteCaseResult> {
  if (!isValidCaseSlug(slug)) return { ok: false, status: 400, error: 'invalid slug' };
  const reason = validateCaseText(text);
  if (reason) return { ok: false, status: 400, error: reason };
  const p = casePath(projectPath, slug);
  if (opts.create && (await fileExists(p))) return { ok: false, status: 409, error: 'case already exists' };
  await fs.mkdir(testsDir(projectPath), { recursive: true });
  await fs.writeFile(p, text, 'utf8');
  return { ok: true };
}

export async function deleteTestCase(projectPath: string, slug: string): Promise<boolean> {
  try {
    await fs.unlink(casePath(projectPath, slug));
    return true;
  } catch (e: any) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

export function summarizeReport(file: string, raw: any): AieTestReportSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = file.match(/^(\d{8}-\d{6})__([a-z0-9-]+)\.json$/);
  if (!m) return null;
  const skipped = raw.skipped === true;
  const passed = raw.judge_verdict?.passed;
  const verdict: AieTestVerdict = skipped ? 'skipped' : passed === true ? 'passed' : 'failed';
  return {
    file,
    timestamp: typeof raw.timestamp === 'string' && raw.timestamp ? raw.timestamp : m[1],
    caseSlug: typeof raw.case_slug === 'string' && raw.case_slug ? raw.case_slug : m[2],
    caseName: typeof raw.case_name === 'string' ? raw.case_name : '',
    verdict,
    severity: typeof raw.judge_verdict?.severity === 'string' ? raw.judge_verdict.severity : null,
    fixRound: typeof raw.fix_round === 'number' ? raw.fix_round : null,
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
    commitSha: typeof raw.target_commit_sha === 'string' && raw.target_commit_sha ? raw.target_commit_sha : null,
  };
}

export async function scanTestReports(projectPath: string): Promise<AieTestReportSummary[]> {
  const dir = reportsDir(projectPath);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: AieTestReportSummary[] = [];
  for (const f of files) {
    if (!REPORT_FILE_RE.test(f)) continue;
    const text = await readTextSafe(path.join(dir, f));
    if (text == null) continue;
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      continue; // malformed report: skip silently
    }
    const s = summarizeReport(f, raw);
    if (s) out.push(s);
  }
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.caseSlug.localeCompare(b.caseSlug));
  return out;
}

export async function readTestReport(projectPath: string, file: string): Promise<unknown | null> {
  if (!REPORT_FILE_RE.test(file)) return null;
  const text = await readTextSafe(path.join(reportsDir(projectPath), file));
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function registerAieRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/projects/:id/aie/skills', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { skills: await scanSkills(project.path) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/aie/agents', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { agents: await scanAgents(project.path) };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/aie/projects', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { projects: await scanAieProjects(project.path) };
  });

  // ─── AIE Test (cases + reports) ──────────────────────────────
  async function guard(req: any, reply: any) {
    const uid = getUserId(req);
    if (!uid) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    const project = await getProject(uid, req.params.id);
    if (!project) {
      reply.code(404).send({ error: 'project not found' });
      return null;
    }
    return project;
  }

  app.get<{ Params: { id: string } }>('/api/projects/:id/aie/tests', async (req, reply) => {
    const project = await guard(req, reply);
    if (!project) return;
    return { cases: await scanTestCases(project.path) };
  });

  app.get<{ Params: { id: string; slug: string } }>('/api/projects/:id/aie/tests/:slug', async (req, reply) => {
    const project = await guard(req, reply);
    if (!project) return;
    const { slug } = req.params;
    if (!isValidCaseSlug(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const text = await readTestCase(project.path, slug);
    if (text == null) return reply.code(404).send({ error: 'case not found' });
    return { slug, text };
  });

  app.put<{ Params: { id: string; slug: string }; Body: { text?: string; create?: boolean } }>(
    '/api/projects/:id/aie/tests/:slug',
    async (req, reply) => {
      const project = await guard(req, reply);
      if (!project) return;
      const text = req.body?.text;
      if (typeof text !== 'string') return reply.code(400).send({ error: 'text required' });
      const r = await writeTestCase(project.path, req.params.slug, text, { create: !!req.body?.create });
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; slug: string } }>('/api/projects/:id/aie/tests/:slug', async (req, reply) => {
    const project = await guard(req, reply);
    if (!project) return;
    const { slug } = req.params;
    if (!isValidCaseSlug(slug)) return reply.code(400).send({ error: 'invalid slug' });
    const ok = await deleteTestCase(project.path, slug);
    if (!ok) return reply.code(404).send({ error: 'case not found' });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/aie/test-reports', async (req, reply) => {
    const project = await guard(req, reply);
    if (!project) return;
    return { reports: await scanTestReports(project.path) };
  });

  app.get<{ Params: { id: string; file: string } }>('/api/projects/:id/aie/test-reports/:file', async (req, reply) => {
    const project = await guard(req, reply);
    if (!project) return;
    const { file } = req.params;
    if (!REPORT_FILE_RE.test(file)) return reply.code(400).send({ error: 'invalid report file' });
    const report = await readTestReport(project.path, file);
    if (report == null) return reply.code(404).send({ error: 'report not found' });
    return report;
  });
}
