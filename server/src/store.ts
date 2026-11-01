import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ensureUser } from './users.js';

export type Project = {
  id: string;
  name: string;
  path: string;
  // Archived projects keep all their data but are hidden from the project
  // picker (model: entity Project.archived / web.ArchiveProject). Absent = false.
  archived?: boolean;
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

// Review (model: entity Batch / Comment). A Batch collects Comments until the
// user sends the whole batch to a session as one prompt. A Comment may quote
// text from a session message; `anchor` is a panel-defined message anchor.
// TabRef: which tab a comment was written in (model: Comment.tab) —
// session/devin key = resumeId, file key = path, other kinds key = type.
export type TabRef = { type: string; key: string };
export type Comment = {
  id: string;
  text: string;
  createdAt: number;
  quote?: string;
  tab?: TabRef;
  anchor?: string;
};
export type Batch = {
  id: string;
  name: string;
  status: 'draft' | 'sent';
  comments: Comment[];
  createdAt: number;
  sentAt?: number;
};
export const MAX_QUOTE_LENGTH = 2000;

export type ProjectWorkspace = {
  tabs: Tab[];
  groups: Group[];
  batches: Batch[];
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
  // devin CLI version dir under ~/.local/share/devin/cli/_versions to spawn.
  // '' = auto (current symlink → newest installed → PATH). See devin-versions.ts.
  devinVersion?: string;
  // Client-only toggles, stored verbatim (server never reads them).
  showStderr?: boolean;
  // One-click rich copy of a reply (web.RichCopy). Default off.
  richCopy?: boolean;
  // Right-hand Review panel (web.ReviewPanel). Default off.
  review?: boolean;
};

const DEFAULT_SETTINGS: Settings = {
  sendKey: 'cmd-enter',
  theme: 'dark',
  fontScale: 'normal',
  model: '',
  effort: '',
  devinModel: '',
  devinMode: '',
  devinVersion: '',
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

// Model: server.UpdateProject — whitelisted fields only; null when the
// project does not exist. Never touches the workspace.
export async function updateProject(
  uid: string,
  id: string,
  patch: { archived?: boolean },
): Promise<Project | null> {
  const projects = await listProjects(uid);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const next: Project = { ...projects[idx] };
  if (typeof patch.archived === 'boolean') {
    if (patch.archived) next.archived = true;
    else delete next.archived;
  }
  projects[idx] = next;
  await writeJson(projectsFile(uid), projects);
  return next;
}

// Model: server.ReorderProjects — `ids` must be a permutation of every
// project id the user has; the array order *is* the display order.
export async function reorderProjects(uid: string, ids: unknown): Promise<Project[]> {
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new Error('ids must be a string array');
  const projects = await listProjects(uid);
  const byId = new Map(projects.map((p) => [p.id, p]));
  if (ids.length !== projects.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    throw new Error('ids must list every project exactly once');
  }
  const next = (ids as string[]).map((id) => byId.get(id)!);
  await writeJson(projectsFile(uid), next);
  return next;
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

// Model: server.PutWorkspace — keep only well-formed batches / comments.
// Batch ids are unique per project; Comment ids are unique across all of the
// project's batches. Optional Comment fields that don't validate are dropped
// without dropping the Comment.
export function normalizeBatches(raw: unknown): Batch[] {
  const out: Batch[] = [];
  const seenBatches = new Set<string>();
  const seenComments = new Set<string>();
  for (const b of Array.isArray(raw) ? raw : []) {
    const { id, name, status } = (b ?? {}) as any;
    if (!nonEmptyString(id) || typeof name !== 'string' || seenBatches.has(id)) continue;
    if (status !== 'draft' && status !== 'sent') continue;
    seenBatches.add(id);
    const comments: Comment[] = [];
    for (const c of Array.isArray((b as any).comments) ? (b as any).comments : []) {
      const cid = c?.id;
      if (!nonEmptyString(cid) || typeof c.text !== 'string' || seenComments.has(cid)) continue;
      seenComments.add(cid);
      const comment: Comment = {
        id: cid,
        text: c.text,
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
      };
      if (typeof c.quote === 'string' && c.quote) comment.quote = c.quote.slice(0, MAX_QUOTE_LENGTH);
      if (nonEmptyString(c.tab?.type) && nonEmptyString(c.tab?.key)) {
        comment.tab = { type: c.tab.type, key: c.tab.key };
        if (nonEmptyString(c.anchor)) comment.anchor = c.anchor;
      }
      comments.push(comment);
    }
    const batch: Batch = {
      id,
      name,
      status,
      comments,
      createdAt: typeof (b as any).createdAt === 'number' ? (b as any).createdAt : Date.now(),
    };
    if (status === 'sent' && typeof (b as any).sentAt === 'number') batch.sentAt = (b as any).sentAt;
    out.push(batch);
  }
  return out;
}

export function normalizeProjectWorkspace(pw: unknown): ProjectWorkspace {
  const raw = (pw ?? {}) as { tabs?: unknown; groups?: unknown; batches?: unknown };
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
  return { tabs, groups, batches: normalizeBatches(raw.batches) };
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
