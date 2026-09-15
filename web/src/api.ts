import type { Project, Workspace, ProjectWorkspace, ResumableSession, ResumableDevinSession, Settings } from './types';

export type AuthStatus = {
  required: boolean;
  authenticated: boolean;
  configured?: boolean;
  username?: string;
};

export async function getAuthStatus(): Promise<AuthStatus> {
  const r = await fetch('/api/auth/status', { credentials: 'include' });
  return r.json();
}

export async function login(username: string, password: string): Promise<boolean> {
  const r = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return r.ok;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
}

export async function listProjects(): Promise<Project[]> {
  const r = await fetch('/api/projects');
  return r.json();
}

export async function addProject(input: { path: string; name?: string }): Promise<Project> {
  const r = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error((await r.json()).error || 'failed');
  return r.json();
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`/api/projects/${id}`, { method: 'DELETE' });
}

export async function getWorkspace(): Promise<Workspace> {
  const r = await fetch('/api/workspace');
  return r.json();
}

export async function putWorkspace(ws: Workspace): Promise<Workspace> {
  const r = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ws),
  });
  return r.json();
}

export async function putProjectWorkspace(
  projectId: string,
  pw: ProjectWorkspace,
): Promise<ProjectWorkspace> {
  const r = await fetch(`/api/workspace/projects/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pw),
  });
  return r.json();
}

export async function listResumableSessions(projectId: string): Promise<ResumableSession[]> {
  const r = await fetch(`/api/projects/${projectId}/sessions`);
  const j = await r.json();
  return j.sessions ?? [];
}

export async function listDevinSessions(projectId: string): Promise<ResumableDevinSession[]> {
  const r = await fetch(`/api/projects/${projectId}/devin-sessions`);
  const j = await r.json();
  return j.sessions ?? [];
}

// Fetch a single Devin session's metadata (title, updatedAt) from the
// server, which reads Devin's own sessions.db. Returns null on 404.
export async function getDevinSession(
  projectId: string,
  slug: string,
): Promise<ResumableDevinSession | null> {
  const r = await fetch(
    `/api/projects/${projectId}/devin-sessions/${encodeURIComponent(slug)}`,
  );
  if (!r.ok) return null;
  return r.json();
}

export type AieSkill = { name: string; description: string; source: string };
export type AieAgent = { name: string; description: string; tools: string; source: string };
export type AieProjectMeta = {
  name: string;
  overviewSummary: string;
  hasTasks: boolean;
  hasLog: boolean;
  hasDesign: boolean;
};

export async function listAieSkills(projectId: string): Promise<AieSkill[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/skills`);
  const j = await r.json();
  return j.skills ?? [];
}

export async function listAieAgents(projectId: string): Promise<AieAgent[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/agents`);
  const j = await r.json();
  return j.agents ?? [];
}

export async function listAieProjects(projectId: string): Promise<AieProjectMeta[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/projects`);
  const j = await r.json();
  return j.projects ?? [];
}

export async function getSettings(): Promise<Settings> {
  const r = await fetch('/api/settings');
  return r.json();
}

export async function putSettings(s: Settings): Promise<Settings> {
  const r = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s),
  });
  return r.json();
}

export type ClaudeModel = {
  id: string;
  name: string;
  short_name?: string;
  description?: string;
  section: 'main' | 'overflow' | 'alias' | string;
  min_claude_code_version?: string;
  thinking: { type: 'effort' | 'none' | string; options: string[]; default: string | null };
};

export type ClaudeModelsResponse = {
  aliases: ClaudeModel[];
  models: ClaudeModel[];
  cliVersion: string | null;
  catalogVersion: number | null;
  catalogFetchedAt: number | null;
  fetchError: string | null;
  cliError: string | null;
};

export async function listClaudeModels(): Promise<ClaudeModelsResponse> {
  const r = await fetch('/api/models');
  return r.json();
}

export type DevinQuota = { remainingPercent: number; resetAt: string | null };
export type DevinUsage =
  | {
      ok: true;
      planName: string | null;
      planEnd: string | null;
      daily: DevinQuota | null;
      weekly: DevinQuota | null;
      overageBalance: number | null;
      acu: { consumed: number; limit: number | null } | null;
      fetchedAt: string;
    }
  | { ok: false; error: string };

export async function getDevinUsage(refresh = false): Promise<DevinUsage> {
  const r = await fetch(`/api/devin/usage${refresh ? '?refresh=1' : ''}`);
  if (!r.ok && r.status !== 502) return { ok: false, error: `HTTP ${r.status}` };
  return r.json();
}

// ─── AIE Test tab ────────────────────────────────────────────
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
// Full report JSON as written by /aie-test (schema: .claude/skills/aie-test/SKILL.md §4.5).
export type AieTestReport = {
  case_slug: string;
  case_name: string;
  target?: string;
  target_root?: string;
  target_commit_sha?: string | null;
  timestamp: string;
  duration_ms?: number;
  prompt?: string;
  response?: string;
  criteria?: string[] | string;
  forbidden_reads?: string[] | null;
  judge_hints?: string | null;
  judge_verdict?: { passed: boolean; reasoning: string; severity: string } | null;
  skipped?: boolean;
  skip_reason?: string | null;
  fix_round?: number | null;
};

async function throwIfNotOk(r: Response): Promise<void> {
  if (r.ok) return;
  let msg = `${r.status}`;
  try {
    const j = await r.json();
    if (j?.error) msg = j.error;
  } catch {
    /* ignore */
  }
  throw new Error(msg);
}

export async function listAieTestCases(projectId: string): Promise<AieTestCase[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/tests`);
  await throwIfNotOk(r);
  const j = await r.json();
  return j.cases ?? [];
}

export async function readAieTestCase(projectId: string, slug: string): Promise<string> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/tests/${encodeURIComponent(slug)}`);
  await throwIfNotOk(r);
  const j = await r.json();
  return j.text ?? '';
}

export async function writeAieTestCase(
  projectId: string,
  slug: string,
  text: string,
  opts: { create?: boolean } = {},
): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/tests/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, create: !!opts.create }),
  });
  await throwIfNotOk(r);
}

export async function deleteAieTestCase(projectId: string, slug: string): Promise<void> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/tests/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  });
  await throwIfNotOk(r);
}

export async function listAieTestReports(projectId: string): Promise<AieTestReportSummary[]> {
  const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/aie/test-reports`);
  await throwIfNotOk(r);
  const j = await r.json();
  return j.reports ?? [];
}

export async function readAieTestReport(projectId: string, file: string): Promise<AieTestReport> {
  const r = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/aie/test-reports/${encodeURIComponent(file)}`,
  );
  await throwIfNotOk(r);
  return r.json();
}
