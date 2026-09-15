import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureUser } from './users.js';

export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
};

// groupId: owning Group within the project. Absent on legacy tabs, which
// means "the project's implicit default Group" — no migration needed.
export type Tab =
  | { id: string; type: 'file'; path: string; groupId?: string }
  | { id: string; type: 'session'; resumeId?: string; title?: string; groupId?: string }
  | { id: string; type: 'devin'; resumeId?: string; title?: string; groupId?: string };

// User-created tab group (cmux-style workspace inside a project). The default
// Group (id DEFAULT_GROUP_ID) is implicit — never stored in groups[].
export type Group = { id: string; name: string };
export const DEFAULT_GROUP_ID = 'default';

// Pinboard row (model: entity Pin). A bookmark references a session by id +
// a panel-defined message anchor, never a tab.
// TabRef: which tab a note was written in (model: Pin.tab) — session/devin
// key = resumeId, file key = path, other kinds key = type.
export type TabRef = { type: string; key: string };
export type Pin =
  | { id: string; kind: 'note'; text: string; createdAt: number; tab?: TabRef }
  | {
      id: string;
      kind: 'bookmark';
      text: string;
      createdAt: number;
      sessionKind: string;
      sessionId: string;
      anchor: string;
    };

export type ProjectWorkspace = {
  tabs: Tab[];
  groups: Group[];
  pins: Pin[];
};

export type Workspace = {
  projects: Record<string, ProjectWorkspace>;
};

export type Settings = {
  sendKey: 'enter' | 'cmd-enter' | 'shift-enter';
  theme: 'dark' | 'light' | 'dim';
  fontScale: 'small' | 'normal' | 'large' | 'xlarge' | 'huge' | 'xhuge';
  // claude CLI --model arg. '' = no override (claude CLI default).
  // Aliases: 'opus' | 'sonnet' | 'haiku'. Also accepts full model IDs.
  model: string;
  // claude CLI --effort arg. '' = no override (claude picks per-model default).
  effort: string;
  // Devin ACP model id. '' = let Devin pick its default.
  devinModel?: string;
  // Devin ACP mode id (bypass / accept-edits / ask / plan) applied to new
  // sessions via session/set_mode. '' = Devin's default (Code = accept-edits).
  devinMode?: string;
  // Client-only toggles, stored verbatim (server never reads them).
  showStderr?: boolean;
  // Desktop-only rich-copy editor (web.RichCopyEditor). Default off.
  richCopy?: boolean;
  // Right-hand Pinboard (web.PinList). Default off.
  pinboard?: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  sendKey: 'cmd-enter',
  theme: 'dark',
  fontScale: 'normal',
  model: '',
  effort: '',
  devinModel: '',
  devinMode: '',
};

const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const USERS_DIR = path.join(CONFIG_DIR, 'users');

function userDir(uid: string): string { return path.join(USERS_DIR, uid); }
function projectsFile(uid: string): string { return path.join(userDir(uid), 'projects.json'); }
function workspaceFile(uid: string): string { return path.join(userDir(uid), 'workspace.json'); }
function settingsFile(uid: string): string { return path.join(userDir(uid), 'settings.json'); }

// Legacy single-user file locations — used only for the one-shot migration
// into the per-user tree on first start after the multi-user upgrade.
const LEGACY_PROJECTS = path.join(CONFIG_DIR, 'projects.json');
const LEGACY_WORKSPACE = path.join(CONFIG_DIR, 'workspace.json');
const LEGACY_SETTINGS = path.join(CONFIG_DIR, 'settings.json');

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

// Serialize writes per destination path. Two concurrent writes to the same
// `file` used to share `file + '.tmp'`: both `writeFile` calls opened the tmp
// with O_TRUNC on independent fds and interleaved their writes, producing a
// "shorter payload + tail of longer payload" concatenation that then got
// renamed onto the real file. Reproduced in the wild when per-project PUT
// races the whole-workspace PUT from unload flush across browser windows.
const writeLocks = new Map<string, Promise<void>>();

async function writeJson(file: string, data: unknown) {
  const prev = writeLocks.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  const guarded = next.catch(() => {});
  writeLocks.set(file, guarded);
  try {
    await next;
  } finally {
    if (writeLocks.get(file) === guarded) writeLocks.delete(file);
  }
}

export async function listProjects(uid: string): Promise<Project[]> {
  return readJson<Project[]>(projectsFile(uid), []);
}

export async function addProject(uid: string, input: { path: string; name?: string }): Promise<Project> {
  const abs = path.resolve(input.path.replace(/^~/, os.homedir()));
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) throw new Error('path is not a directory');
  const projects = await listProjects(uid);
  const existing = projects.find((p) => p.path === abs);
  if (existing) return existing;
  const project: Project = {
    id: randomUUID(),
    name: input.name?.trim() || path.basename(abs),
    path: abs,
    createdAt: Date.now(),
  };
  projects.push(project);
  await writeJson(projectsFile(uid), projects);
  return project;
}

export async function deleteProject(uid: string, id: string): Promise<void> {
  const projects = await listProjects(uid);
  const next = projects.filter((p) => p.id !== id);
  await writeJson(projectsFile(uid), next);
  const ws = await getWorkspace(uid);
  if (ws.projects[id]) {
    delete ws.projects[id];
    await writeJson(workspaceFile(uid), ws);
  }
}

export async function getProject(uid: string, id: string): Promise<Project | null> {
  const projects = await listProjects(uid);
  return projects.find((p) => p.id === id) ?? null;
}

// Canonical per-project slot shape. Only `tabs` and `groups` survive; legacy
// activeTabId is dropped (per-browser in localStorage now). groups[] keeps
// only well-formed { id, name } entries and never the implicit default Group.
function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Model: server.PutWorkspace — keep only well-formed pins, dedupe ids; a
// bookmark without sessionKind / sessionId / anchor can never be jumped to,
// so it's dropped rather than kept as junk.
export function normalizePins(raw: unknown): Pin[] {
  const out: Pin[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(raw) ? raw : []) {
    const id = (p as any)?.id;
    const kind = (p as any)?.kind;
    const text = (p as any)?.text;
    if (!nonEmptyString(id) || typeof text !== 'string' || seen.has(id)) continue;
    const createdAt = typeof (p as any).createdAt === 'number' ? (p as any).createdAt : Date.now();
    if (kind === 'note') {
      seen.add(id);
      const t = (p as any).tab;
      const tab: TabRef | undefined = nonEmptyString(t?.type) && nonEmptyString(t?.key) ? { type: t.type, key: t.key } : undefined;
      out.push(tab ? { id, kind, text, createdAt, tab } : { id, kind, text, createdAt });
    } else if (kind === 'bookmark') {
      const { sessionKind, sessionId, anchor } = p as any;
      if (!nonEmptyString(sessionKind) || !nonEmptyString(sessionId) || !nonEmptyString(anchor)) continue;
      seen.add(id);
      out.push({ id, kind, text, createdAt, sessionKind, sessionId, anchor });
    }
  }
  return out;
}

export function normalizeProjectWorkspace(pw: unknown): ProjectWorkspace {
  const raw = (pw ?? {}) as { tabs?: unknown; groups?: unknown; pins?: unknown };
  const tabs = Array.isArray(raw.tabs) ? (raw.tabs as Tab[]) : [];
  const seen = new Set<string>();
  const groups: Group[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    const id = (g as any)?.id;
    const name = (g as any)?.name;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue;
    if (id === DEFAULT_GROUP_ID || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name });
  }
  return { tabs, groups, pins: normalizePins(raw.pins) };
}

export async function getWorkspace(uid: string): Promise<Workspace> {
  // Strip any legacy active fields lurking in the file — schema dropped them
  // (they're now per-browser in localStorage).
  const raw = await readJson<any>(workspaceFile(uid), { projects: {} });
  const projects: Record<string, ProjectWorkspace> = {};
  for (const [id, pw] of Object.entries(raw?.projects ?? {})) {
    projects[id] = normalizeProjectWorkspace(pw);
  }
  return { projects };
}

export async function putWorkspace(uid: string, ws: Workspace): Promise<Workspace> {
  const clean: Workspace = {
    projects: Object.fromEntries(
      Object.entries(ws.projects ?? {}).map(([id, pw]) => [id, normalizeProjectWorkspace(pw)]),
    ),
  };
  await writeJson(workspaceFile(uid), clean);
  return clean;
}

// Per-project workspace update. Merges just one project's slot into the
// existing workspace file, so concurrent writes from multiple browser windows
// on different projects can't clobber each other's tab lists.
export async function putProjectWorkspace(
  uid: string,
  projectId: string,
  pw: ProjectWorkspace,
): Promise<ProjectWorkspace> {
  const existing = await getWorkspace(uid);
  const clean = normalizeProjectWorkspace(pw);
  existing.projects[projectId] = clean;
  await writeJson(workspaceFile(uid), existing);
  return clean;
}

// Rewrite every existing workspace.json through putWorkspace so the on-disk
// shape matches the current schema. Lazy migration via getWorkspace strips
// legacy `activeProjectId` / `activeTabId` only when a write happens, so users
// who haven't touched the app since the schema change still have stale fields
// in their file. Called once at server startup.
export async function sanitizeAllWorkspaces(): Promise<{ rewritten: number }> {
  let rewritten = 0;
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(USERS_DIR, { withFileTypes: true });
  } catch {
    return { rewritten };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = workspaceFile(e.name);
    let raw: string;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch { continue; }
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch { continue; }
    const hasLegacyTop = 'activeProjectId' in (parsed ?? {});
    const hasLegacyNested = Object.values(parsed?.projects ?? {})
      .some((p) => p && typeof p === 'object' && 'activeTabId' in (p as any));
    if (!hasLegacyTop && !hasLegacyNested) continue;
    await putWorkspace(e.name, parsed);
    rewritten++;
  }
  return { rewritten };
}

export async function getSettings(uid: string): Promise<Settings> {
  const stored = await readJson<Partial<Settings>>(settingsFile(uid), {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function putSettings(uid: string, s: Settings): Promise<Settings> {
  const merged = { ...DEFAULT_SETTINGS, ...s };
  await writeJson(settingsFile(uid), merged);
  return merged;
}

// One-shot migration: if pre-multi-user files exist at the legacy paths and
// no users have been provisioned yet, create a default user named "eric"
// (password from REMOTE_IDE_PASSWORD env, falling back to a placeholder that
// forces a manual passwd reset) and move the existing state under that user.
// Idempotent — safe to call on every startup.
export async function migrateLegacyIfNeeded(): Promise<void> {
  const usersJson = path.join(CONFIG_DIR, 'users.json');
  const hasUsers = await fs.access(usersJson).then(() => true, () => false);
  const hasLegacy = await fs.access(LEGACY_PROJECTS).then(() => true, () => false);
  if (hasUsers || !hasLegacy) return;

  const password = process.env.REMOTE_IDE_PASSWORD;
  if (!password || password.length < 6) {
    // Refuse to migrate with a weak / missing password — the user would be
    // locked out of the migrated data. Surface the problem instead.
    throw new Error(
      'Legacy single-user state exists but REMOTE_IDE_PASSWORD is missing or <6 chars. ' +
      'Set it in .env then restart, or remove the legacy files manually.',
    );
  }

  const user = await ensureUser('eric', password);
  await fs.mkdir(userDir(user.id), { recursive: true });

  for (const [src, dst] of [
    [LEGACY_PROJECTS, projectsFile(user.id)],
    [LEGACY_WORKSPACE, workspaceFile(user.id)],
    [LEGACY_SETTINGS, settingsFile(user.id)],
  ] as const) {
    const exists = await fs.access(src).then(() => true, () => false);
    if (!exists) continue;
    const dstExists = await fs.access(dst).then(() => true, () => false);
    if (dstExists) continue; // user already populated, don't overwrite
    await fs.rename(src, dst);
  }
  // eslint-disable-next-line no-console
  console.log(`[remote-ide] migrated legacy single-user state → users/${user.id} (name=eric)`);
}
