import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './components/FileTree';
import { GroupList } from './components/GroupList';
import { ReviewPanel } from './components/ReviewPanel';
import type { NewComment } from './components/CommentComposer';
import * as review from './lib/review';
import { ProjectPicker } from './components/ProjectPicker';
import { ProjectManager } from './components/ProjectManager';
import { TabBar } from './components/TabBar';
import { Settings as SettingsModal } from './components/Settings';
import { DevinUsage } from './components/DevinUsage';
import { SessionPicker, type PickerItem } from './components/SessionPicker';
import { Login } from './components/Login';
import { DebugPanel } from './components/DebugPanel';
import { logDebug } from './lib/debugLog';
import { getTabKind, listTabKinds, type SessionPanelApi } from './registry';
import {
  listProjects,
  addProject,
  updateProject,
  reorderProjects,
  deleteProject,
  getWorkspace,
  putProjectWorkspace,
  listResumableSessions,
  listDevinSessions,
  getSettings,
  putSettings,
  getAuthStatus,
  logout,
} from './api';
import type { Project, Tab, Group, Batch, Comment, TabRef, Workspace, ProjectWorkspace, Settings } from './types';
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, tabGroupId, tabRef, sameTabRef } from './types';
import { isStandalone } from './usePwaInstall';

const DEFAULT_SETTINGS: Settings = { sendKey: 'cmd-enter', theme: 'dark', fontScale: 'normal', model: '', devinModel: '', devinMode: '', showStderr: false, richCopy: false, review: false };

// Stable empty value so panels without comments don't re-render (model: web.HighlightQuotes).
const NO_COMMENT_MARKS: readonly review.CommentMark[] = [];

function randomId() { return Math.random().toString(36).slice(2, 10); }

// PWA (installed to home screen) and browser tabs use separate localStorage
// key namespaces so they have independent "last active project" memories.
// Rationale: on Android the two surfaces share the same origin partition,
// which would otherwise bleed browser activity into the PWA and vice versa;
// on iOS the platform already partitions storage per PWA install, so this
// only changes Android behavior in practice but keeps the code symmetric.
const IS_PWA = isStandalone();
const LS_PREFIX = IS_PWA ? 'remote-ide:pwa:' : 'remote-ide:browser:';
// Per-project active-tab pointer. Kept local so different windows can focus
// different tabs within the same project. The tabs list itself stays on the
// server (shared across windows).
const ACTIVE_LS_KEY = `${LS_PREFIX}active`;
const DL_MODE_LS_KEY = `${LS_PREFIX}downloadMode`;
// Which list the left sidebar shows: the file tree or the tab-group list.
const SIDEBAR_VIEW_LS_KEY = `${LS_PREFIX}sidebarView`;
// Desktop sidebar width (model: web.ResizeSidebar). null = CSS default (260px).
const SIDEBAR_WIDTH_LS_KEY = `${LS_PREFIX}sidebarWidth`;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 600;
// Desktop Review column (model: web.ResizeReviewPanel / web.ToggleReviewPanel).
const REVIEW_WIDTH_LS_KEY = `${LS_PREFIX}reviewWidth`;
const REVIEW_COLLAPSED_LS_KEY = `${LS_PREFIX}reviewCollapsed`;
const REVIEW_MIN_WIDTH = 200;
const REVIEW_MAX_WIDTH = 600;
const REVIEW_COLLAPSED_WIDTH = 32;
// Which draft Batch new comments go to, per project (model:
// web.SetCurrentBatch). Per-device, like the active tab.
const REVIEW_CURRENT_BATCH_LS_KEY = `${LS_PREFIX}reviewCurrentBatch`;
type SidebarView = 'files' | 'groups';
// Active project id. In browser mode the URL hash is authoritative and this
// is only written (never read on init). In PWA mode the URL hash is ignored
// on init — iOS "Add to Home Screen" often bakes the install-time hash into
// the launcher, which would otherwise pin every cold-start to that project —
// and this key is the sole source of truth for resuming.
const LAST_PROJECT_LS_KEY = `${LS_PREFIX}lastProjectId`;
// tabs / groups: per-project active tab id and active Group id. Both are
// per-device (localStorage) — the tab + group lists themselves live on the
// server. A missing group entry means the project's default Group.
type ActiveState = {
  projectId: string | null;
  tabs: Record<string, string | null>;
  groups: Record<string, string | null>;
};

function loadDownloadMode(): boolean {
  try { return localStorage.getItem(DL_MODE_LS_KEY) === '1'; } catch { return false; }
}

function loadSidebarView(): SidebarView {
  try { return localStorage.getItem(SIDEBAR_VIEW_LS_KEY) === 'groups' ? 'groups' : 'files'; } catch { return 'files'; }
}

function loadSidebarWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_WIDTH_LS_KEY));
    return Number.isFinite(n) && n >= SIDEBAR_MIN_WIDTH && n <= SIDEBAR_MAX_WIDTH ? n : null;
  } catch { return null; }
}

function loadReviewWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(REVIEW_WIDTH_LS_KEY));
    return Number.isFinite(n) && n >= REVIEW_MIN_WIDTH && n <= REVIEW_MAX_WIDTH ? n : null;
  } catch { return null; }
}

function loadReviewCollapsed(): boolean {
  try { return localStorage.getItem(REVIEW_COLLAPSED_LS_KEY) === '1'; } catch { return false; }
}

function loadCurrentBatches(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(REVIEW_CURRENT_BATCH_LS_KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function triggerDownload(projectId: string, filePath: string) {
  const filename = filePath.split('/').pop() || 'download';
  const a = document.createElement('a');
  a.href = `/api/fs/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function projectIdFromHash(): string | null {
  try {
    const h = decodeURIComponent(window.location.hash.slice(1));
    return h || null;
  } catch {
    return null;
  }
}

function loadActive(): { state: ActiveState; events: string[] } {
  const events: string[] = [];
  let tabs: Record<string, string | null> = {};
  let groups: Record<string, string | null> = {};
  try {
    const raw = localStorage.getItem(ACTIVE_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.tabs && typeof parsed.tabs === 'object' && !Array.isArray(parsed.tabs)) {
        tabs = parsed.tabs;
        if (parsed.groups && typeof parsed.groups === 'object' && !Array.isArray(parsed.groups)) {
          groups = parsed.groups;
        }
        const detail = Object.entries(tabs)
          .map(([pid, tid]) => `${pid}:${tid ?? 'null'}`)
          .join(', ');
        events.push(
          `restored active-tab map from localStorage (${Object.keys(tabs).length} project(s)${detail ? ` — ${detail}` : ''})`,
        );
      } else {
        events.push('active-tab map in localStorage has wrong shape, ignoring');
      }
    } else {
      events.push('no active-tab map in localStorage (first visit or cleared)');
    }
  } catch (e) {
    events.push(`failed to parse active-tab map: ${String(e)}`);
  }
  events.push(`storage mode: ${IS_PWA ? 'PWA' : 'browser'} (LS prefix "${LS_PREFIX}")`);
  let projectId: string | null = null;
  if (IS_PWA) {
    events.push('PWA standalone → ignoring URL hash on init (would otherwise pin to install-time hash)');
    try {
      const stored = localStorage.getItem(LAST_PROJECT_LS_KEY);
      if (stored) {
        projectId = stored;
        events.push(`resolved lastProjectId from localStorage: ${stored}`);
      } else {
        events.push('no lastProjectId in localStorage (first PWA launch or cleared)');
      }
    } catch (e) {
      events.push(`failed to read lastProjectId: ${String(e)}`);
    }
  } else {
    projectId = projectIdFromHash();
    if (projectId) {
      events.push(`active project from URL hash: ${projectId}`);
    } else {
      events.push('URL hash empty (browser mode has no fallback)');
    }
  }
  if (projectId) {
    if (projectId in tabs) {
      events.push(`stored active tab for project ${projectId}: ${tabs[projectId] ?? 'null'} (pending workspace validation)`);
    } else {
      events.push(`no stored active tab for project ${projectId} (not in map)`);
    }
  }
  return { state: { projectId, tabs, groups }, events };
}

function saveActive(s: ActiveState) {
  // Persist only the per-browser bit. projectId is reflected to the hash by a
  // separate effect so we don't fight ourselves on hashchange.
  try { localStorage.setItem(ACTIVE_LS_KEY, JSON.stringify({ tabs: s.tabs, groups: s.groups })); } catch {}
}

function groupExists(pw: ProjectWorkspace | undefined, gid: string): boolean {
  return gid === DEFAULT_GROUP_ID || (pw?.groups ?? []).some((g) => g.id === gid);
}

function groupName(groups: Group[], gid: string): string {
  if (gid === DEFAULT_GROUP_ID) return DEFAULT_GROUP_NAME;
  return groups.find((g) => g.id === gid)?.name ?? gid;
}

function reconcileActive(
  prev: ActiveState,
  projects: Project[],
  workspace: Workspace,
): { next: ActiveState; events: string[]; changed: boolean } {
  const events: string[] = [];
  let projectId = prev.projectId;
  // Archived projects count as absent for the active pointer (model:
  // entity Project.archived / web.ArchiveProject): fall back to the first
  // visible one, same path as a deleted project.
  const projectExists = projectId && projects.some((p) => p.id === projectId && !p.archived);
  if (!projectExists) {
    const fallback = projects.find((p) => !p.archived)?.id ?? null;
    if (projectId !== fallback) {
      events.push(
        `active project ${projectId ?? 'null'} not in visible projects list → fallback to ${fallback ?? 'null'}`,
      );
    }
    projectId = fallback;
  }
  const tabs: Record<string, string | null> = {};
  const groups: Record<string, string | null> = {};
  const droppedProjects: string[] = [];
  for (const pid of Object.keys(prev.tabs)) {
    if (projects.some((p) => p.id === pid)) tabs[pid] = prev.tabs[pid];
    else droppedProjects.push(pid);
  }
  for (const pid of Object.keys(prev.groups)) {
    if (projects.some((p) => p.id === pid)) groups[pid] = prev.groups[pid];
  }
  if (droppedProjects.length) {
    events.push(
      `dropped active-tab pointer for deleted project(s): ${droppedProjects.join(', ')}`,
    );
  }
  if (projectId) {
    const pw = workspace.projects[projectId];
    const list = pw?.tabs ?? [];
    const stored = tabs[projectId] ?? null;
    const hadEntry = projectId in tabs;
    const storedTab = stored ? list.find((t) => t.id === stored) ?? null : null;
    const storedGid = groups[projectId] ?? null;
    const gidValid = storedGid !== null && groupExists(pw, storedGid);
    let nextTabId: string | null;
    let nextGid: string;
    if (storedTab) {
      // The tab the user was looking at wins; its Group follows it.
      nextTabId = storedTab.id;
      nextGid = tabGroupId(storedTab);
      events.push(
        `project ${projectId} stored active tab ${stored} ✓ present in tabs list (${list.length} open) → keep` +
          (storedGid !== nextGid ? ` (active group ${storedGid ?? 'null'} → ${nextGid}, follows tab)` : ''),
      );
    } else if (gidValid) {
      // Tab gone (closed elsewhere) or none selected: stay in the stored
      // Group and pick its first tab, if any.
      nextGid = storedGid;
      nextTabId = list.find((t) => tabGroupId(t) === nextGid)?.id ?? null;
      events.push(
        `project ${projectId} stored active tab ${stored ?? 'null'} ${hadEntry ? '✗ not in tabs list' : '(none stored)'} → group ${nextGid} first tab = ${nextTabId ?? 'null'}`,
      );
    } else {
      const first = list[0] ?? null;
      nextTabId = first?.id ?? null;
      nextGid = first ? tabGroupId(first) : DEFAULT_GROUP_ID;
      if (list.length === 0) {
        events.push(`project ${projectId} has 0 open tabs → active tab = null, group = ${nextGid}`);
      } else {
        events.push(
          `project ${projectId} no valid stored tab/group (${storedGid ?? 'null'}) → default to tabs[0] = ${nextTabId ?? 'null'} in group ${nextGid} (${list.length} open)`,
        );
      }
    }
    tabs[projectId] = nextTabId;
    groups[projectId] = nextGid;
  } else {
    events.push('no active project → active tab lookup skipped');
  }
  const changed =
    projectId !== prev.projectId ||
    JSON.stringify(tabs) !== JSON.stringify(prev.tabs) ||
    JSON.stringify(groups) !== JSON.stringify(prev.groups);
  return { next: { projectId, tabs, groups }, events, changed };
}

function setProjectHash(id: string | null) {
  const target = id ? `#${encodeURIComponent(id)}` : '';
  if (window.location.hash === target) return;
  if (!target && !window.location.hash) return;
  const url = window.location.pathname + window.location.search + target;
  history.replaceState(null, '', url);
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>({ projects: {} });
  const [{ state: initialActive, events: bootEvents }] = useState(() => loadActive());
  const [active, setActive] = useState<ActiveState>(initialActive);
  const [loaded, setLoaded] = useState(false);
  const [authState, setAuthState] = useState<{ required: boolean; authenticated: boolean; username?: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Mobile-only right drawer for Review (model: web.ReviewPanel). Desktop
  // renders the same panel as a permanent third column.
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState(false);
  const [appToast, setAppToast] = useState<string | null>(null);
  const appToastTimer = useRef<number | null>(null);
  const showAppToast = useCallback((text: string) => {
    setAppToast(text);
    if (appToastTimer.current) window.clearTimeout(appToastTimer.current);
    appToastTimer.current = window.setTimeout(() => setAppToast(null), 2500);
  }, []);
  const [downloadMode, setDownloadMode] = useState<boolean>(() => loadDownloadMode());
  useEffect(() => {
    try { localStorage.setItem(DL_MODE_LS_KEY, downloadMode ? '1' : '0'); } catch {}
  }, [downloadMode]);
  const [sidebarView, setSidebarView] = useState<SidebarView>(() => loadSidebarView());
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_VIEW_LS_KEY, sidebarView); } catch {}
  }, [sidebarView]);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
  useEffect(() => {
    try {
      if (sidebarWidth == null) localStorage.removeItem(SIDEBAR_WIDTH_LS_KEY);
      else localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);
  // Drag state for the sidebar's right-edge handle; pointer capture keeps the
  // drag alive even when the cursor leaves the 6px bar.
  const sidebarDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onSidebarResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    sidebarDragRef.current = { startX: e.clientX, startW: panel.offsetWidth };
  };
  const onSidebarResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = sidebarDragRef.current;
    if (!d) return;
    setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, d.startW + (e.clientX - d.startX))));
  };
  const onSidebarResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return;
    sidebarDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const [reviewWidth, setReviewWidth] = useState<number | null>(() => loadReviewWidth());
  useEffect(() => {
    try {
      if (reviewWidth == null) localStorage.removeItem(REVIEW_WIDTH_LS_KEY);
      else localStorage.setItem(REVIEW_WIDTH_LS_KEY, String(reviewWidth));
    } catch {}
  }, [reviewWidth]);
  const [reviewCollapsed, setReviewCollapsed] = useState<boolean>(() => loadReviewCollapsed());
  useEffect(() => {
    try { localStorage.setItem(REVIEW_COLLAPSED_LS_KEY, reviewCollapsed ? '1' : '0'); } catch {}
  }, [reviewCollapsed]);
  const [currentBatches, setCurrentBatches] = useState<Record<string, string>>(() => loadCurrentBatches());
  useEffect(() => {
    try { localStorage.setItem(REVIEW_CURRENT_BATCH_LS_KEY, JSON.stringify(currentBatches)); } catch {}
  }, [currentBatches]);
  // Drag bar on the Review panel's *left* edge: moving the pointer left grows it.
  const reviewDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onReviewResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    reviewDragRef.current = { startX: e.clientX, startW: panel.offsetWidth };
  };
  const onReviewResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = reviewDragRef.current;
    if (!d) return;
    setReviewWidth(Math.min(REVIEW_MAX_WIDTH, Math.max(REVIEW_MIN_WIDTH, d.startW - (e.clientX - d.startX))));
  };
  const onReviewResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!reviewDragRef.current) return;
    reviewDragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // Latest workspace for event handlers that need the current groups list
  // without threading it through every call site.
  const workspaceRef = useRef<Workspace>(workspace);
  workspaceRef.current = workspace;
  const [refreshKey, setRefreshKey] = useState<Record<string, number>>({});
  // Lazy-mount: tabs only mount when they first become active. Once mounted,
  // they stay mounted (and hidden with display:none) so switching back is
  // instant. Otherwise a workspace with 77 devin tabs would open 77 WSes and
  // hit 77 transcript endpoints at boot.
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set());
  const exportApiRef = useRef<Map<string, { open: () => void; canExport: boolean }>>(new Map());
  const [exportApiVersion, setExportApiVersion] = useState(0);
  const registerExportApi = useCallback(
    (tabId: string, api: { open: () => void; canExport: boolean } | null) => {
      if (api) exportApiRef.current.set(tabId, api);
      else exportApiRef.current.delete(tabId);
      setExportApiVersion((n) => n + 1);
    },
    [],
  );
  // Per-tab session panel APIs (model: web.RevealMessage /
  // web.InsertBatchPrompt). A jump / send that has to open or lazy-mount a
  // tab parks its request in pendingReveal / pendingInsert until that tab's
  // panel registers.
  const panelApiRef = useRef<Map<string, SessionPanelApi>>(new Map());
  const pendingRevealRef = useRef<{ tabId: string; anchor: string } | null>(null);
  const pendingInsertRef = useRef<{ tabId: string; text: string; batchId: string } | null>(null);
  const fireReveal = useCallback((tabId: string, anchor: string) => {
    const api = panelApiRef.current.get(tabId);
    if (!api) return false;
    pendingRevealRef.current = null;
    logDebug('review', `reveal ${anchor} in tab ${tabId}`);
    api.reveal(anchor).then((found) => {
      if (!found) showAppToast('Message not found in this session');
    });
    return true;
  }, [showAppToast]);
  const fireInsert = useCallback((tabId: string, text: string, batchId: string) => {
    const api = panelApiRef.current.get(tabId);
    if (!api) return false;
    pendingInsertRef.current = null;
    logDebug('review', `insert batch ${batchId} into tab ${tabId} (${text.length} chars)`);
    api.insertPrompt(text, batchId);
    return true;
  }, []);
  const registerPanelApi = useCallback((tabId: string, api: SessionPanelApi | null) => {
    if (api) panelApiRef.current.set(tabId, api);
    else panelApiRef.current.delete(tabId);
    if (!api) return;
    const reveal = pendingRevealRef.current;
    if (reveal && reveal.tabId === tabId) fireReveal(tabId, reveal.anchor);
    const insert = pendingInsertRef.current;
    if (insert && insert.tabId === tabId) fireInsert(tabId, insert.text, insert.batchId);
  }, [fireReveal, fireInsert]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devinUsageOpen, setDevinUsageOpen] = useState(false);
  // Model: web.ProjectManager dialog.
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [picker, setPicker] = useState<{
    title: string;
    items: PickerItem[];
    onPick: (id: string) => void;
  } | null>(null);

  // Initial load — guarded so strict-mode double-mount doesn't double-fire
  // network calls or duplicate debug events.
  const bootRanRef = useRef(false);
  useEffect(() => {
    if (bootRanRef.current) return;
    bootRanRef.current = true;
    for (const msg of bootEvents) logDebug('init', msg);
    logDebug('init', `downloadMode = ${downloadMode}`);
    (async () => {
      const auth = await getAuthStatus();
      logDebug(
        'auth',
        `required=${auth.required} authenticated=${auth.authenticated}${auth.username ? ` username=${auth.username}` : ''}`,
      );
      setAuthState(auth);
      if (auth.required && !auth.authenticated) {
        logDebug('auth', 'not authenticated → showing login');
        return;
      }
      const [ps, ws, st] = await Promise.all([listProjects(), getWorkspace(), getSettings()]);
      logDebug(
        'load',
        `projects: ${ps.length} (${ps.map((p) => p.id).join(', ') || 'none'})`,
      );
      const wsProjectIds = Object.keys(ws.projects || {});
      const totalTabs = wsProjectIds.reduce(
        (n, pid) => n + (ws.projects[pid]?.tabs?.length ?? 0),
        0,
      );
      logDebug(
        'load',
        `workspace: ${wsProjectIds.length} project(s), ${totalTabs} tab(s) total`,
      );
      logDebug(
        'load',
        `settings: theme=${st.theme} fontScale=${st.fontScale} sendKey=${st.sendKey} model=${st.model || '(default)'} devinModel=${st.devinModel || '(default)'} devinMode=${st.devinMode || '(default)'} showStderr=${st.showStderr ?? false} richCopy=${st.richCopy ?? false} review=${st.review ?? false}`,
      );
      setProjects(ps);
      setWorkspace(ws);
      setSettings(st);
      // Summarize devin/chat tabs at boot; only dump per-tab detail for the
      // ones missing resumeId, which is the signal we care about when a tab
      // renders blank.
      let devinTotal = 0;
      let chatTotal = 0;
      const missing: Array<{ kind: 'devin' | 'chat'; pid: string; id: string; title?: string }> = [];
      for (const [pid, pws] of Object.entries(ws.projects || {})) {
        for (const t of pws.tabs || []) {
          if (t.type !== 'devin' && t.type !== 'session') continue;
          if (t.type === 'devin') devinTotal++;
          else chatTotal++;
          if (!t.resumeId) {
            missing.push({ kind: t.type === 'devin' ? 'devin' : 'chat', pid, id: t.id, title: t.title });
          }
        }
      }
      logDebug(
        'load',
        `boot tabs: devin=${devinTotal} chat=${chatTotal} missingResumeId=${missing.length}`,
      );
      for (const { kind, pid, id, title } of missing) {
        logDebug(
          `${kind}:tab`,
          `boot missing resumeId: project=${pid} tab=${id} title=${JSON.stringify(title ?? null)}`,
        );
      }
      setLoaded(true);
      logDebug('load', 'boot complete, entering reconcile phase');
    })();
  }, []);

  function updateSettings(next: Settings) {
    setSettings(next);
    putSettings(next);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.fontScale = settings.fontScale;
  }, [settings.fontScale]);

  // Per-project debounced persistence. Each project has its own timer +
  // pending payload so writes to project A never carry stale project B state
  // in the same request — this was the root cause of multi-window tab-loss
  // (two windows both PUTting the whole workspace clobbered each other).
  // Timers are flushed on page unload via keepalive fetch so the last write
  // in the debounce window still reaches the server if the user closes fast.
  const projectSaveTimers = useRef<Map<string, number>>(new Map());
  const projectSavePayloads = useRef<Map<string, ProjectWorkspace>>(new Map());
  const flushProjectSave = useCallback((pid: string) => {
    const timer = projectSaveTimers.current.get(pid);
    if (timer) window.clearTimeout(timer);
    projectSaveTimers.current.delete(pid);
    const pw = projectSavePayloads.current.get(pid);
    projectSavePayloads.current.delete(pid);
    if (pw) putProjectWorkspace(pid, pw);
  }, []);
  const saveProjectWorkspace = useCallback((projectId: string, pw: ProjectWorkspace) => {
    // Keep the ref current right away: two saves in one event (a panel's send
    // retitles its tab, then marks a Review Batch sent) each rebuild the slot
    // from workspaceRef and must not drop the other's change.
    workspaceRef.current = {
      ...workspaceRef.current,
      projects: { ...workspaceRef.current.projects, [projectId]: pw },
    };
    setWorkspace((ws) => ({
      ...ws,
      projects: { ...ws.projects, [projectId]: pw },
    }));
    projectSavePayloads.current.set(projectId, pw);
    const existing = projectSaveTimers.current.get(projectId);
    if (existing) window.clearTimeout(existing);
    projectSaveTimers.current.set(
      projectId,
      window.setTimeout(() => flushProjectSave(projectId), 250),
    );
  }, [flushProjectSave]);

  // Flush any pending per-project saves before the page unloads. Both events
  // for cross-browser coverage: pagehide fires reliably on mobile Safari
  // (where beforeunload is unreliable), beforeunload fires on desktop.
  // keepalive: true lets the request survive tab teardown.
  useEffect(() => {
    const flush = () => {
      for (const [pid, timer] of projectSaveTimers.current.entries()) {
        window.clearTimeout(timer);
        const pw = projectSavePayloads.current.get(pid);
        if (pw) {
          try {
            fetch(`/api/workspace/projects/${encodeURIComponent(pid)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(pw),
              keepalive: true,
            });
          } catch {}
        }
      }
      projectSaveTimers.current.clear();
      projectSavePayloads.current.clear();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // Persist active state synchronously so a quick refresh doesn't lose it.
  // Deps are narrowed to `active.tabs` — setActiveProject preserves the tabs
  // reference so it won't spuriously refire this effect. First mount is
  // skipped because the initial state was just read from localStorage:
  // writing it back would be a redundant round-trip.
  const persistMountedRef = useRef(false);
  useEffect(() => {
    if (!persistMountedRef.current) {
      persistMountedRef.current = true;
      return;
    }
    saveActive(active);
    const summary = Object.entries(active.tabs)
      .map(([pid, tid]) => `${pid}:${tid ?? 'null'}@${active.groups[pid] ?? DEFAULT_GROUP_ID}`)
      .join(', ');
    logDebug('persist', `wrote active-tab map to localStorage (${Object.keys(active.tabs).length} project(s)${summary ? ` — ${summary}` : ''})`);
  }, [active.tabs, active.groups]);

  // Reflect active project to the URL hash so it's shareable / survives copy.
  // lastProjectId is PWA-only: browser mode never reads it back (URL hash is
  // the source of truth) so writing it there would be dead I/O.
  useEffect(() => {
    const before = window.location.hash;
    setProjectHash(active.projectId);
    const after = window.location.hash;
    if (before !== after) {
      logDebug('persist', `URL hash: "${before || '(empty)'}" → "${after || '(empty)'}"`);
    }
    if (!IS_PWA) return;
    try {
      if (active.projectId) {
        localStorage.setItem(LAST_PROJECT_LS_KEY, active.projectId);
        logDebug('persist', `wrote lastProjectId = ${active.projectId}`);
      } else {
        localStorage.removeItem(LAST_PROJECT_LS_KEY);
        logDebug('persist', 'cleared lastProjectId');
      }
    } catch (e) {
      logDebug('persist', `failed to write lastProjectId: ${String(e)}`);
    }
  }, [active.projectId]);

  // Track external hash edits (back/forward, manual edit, paste of a deep link).
  useEffect(() => {
    function onHash() {
      const next = projectIdFromHash();
      setActive((a) => {
        if (a.projectId === next) {
          logDebug('hash', `hashchange → ${next ?? 'null'} (no change)`);
          return a;
        }
        logDebug('hash', `hashchange: active project ${a.projectId ?? 'null'} → ${next ?? 'null'}`);
        return { ...a, projectId: next };
      });
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Reconcile stored active state against actual data once both projects and
  // workspace have loaded — clears stale ids pointing at deleted projects /
  // closed tabs, falling back to the first available.
  const activeProjectId = active.projectId;
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const projectWs = activeProjectId ? workspace.projects[activeProjectId] : undefined;
  const tabs: Tab[] = projectWs?.tabs ?? [];
  const groups: Group[] = projectWs?.groups ?? [];
  const batches: Batch[] = projectWs?.batches ?? [];
  const activeTabId = activeProjectId ? (active.tabs[activeProjectId] ?? null) : null;
  const activeGroupId = (activeProjectId ? active.groups[activeProjectId] : null) ?? DEFAULT_GROUP_ID;
  // Only the active Group's tabs show in the TabBar; the others stay mounted
  // (hidden) so switching Groups never drops a live session WS.
  const visibleTabs = useMemo(
    () => tabs.filter((t) => tabGroupId(t) === activeGroupId),
    [tabs, activeGroupId],
  );

  // Narrow signatures for the reconcile effect. Depending on the full
  // `workspace` / `active` objects makes reconcile fire on every onTitle /
  // onSessionId write, even when the tab-id set hasn't changed — reconcile
  // then no-ops but still runs + logs. These sigs change only when the
  // inputs reconcile actually cares about change.
  // Archived flag is part of the signature: archiving the active project must
  // re-run reconcile so it falls back to a visible one (model: web.ArchiveProject).
  const projectIdsSig = useMemo(
    () => projects.map((p) => `${p.id}${p.archived ? '!' : ''}`).join('\0'),
    [projects],
  );
  const activeTabsSig = useMemo(() => {
    if (!activeProjectId) return '';
    const pw = workspace.projects[activeProjectId];
    const tabsSig = (pw?.tabs ?? []).map((t) => `${t.id}@${tabGroupId(t)}`).join('\0');
    const groupsSig = (pw?.groups ?? []).map((g) => g.id).join('\0');
    return `${tabsSig}|${groupsSig}`;
  }, [workspace, activeProjectId]);
  const activeTabsMapKeysSig = useMemo(
    () => Object.keys(active.tabs).sort().join('\0'),
    [active.tabs],
  );

  // Reconcile stored active state against actual data once both projects and
  // workspace have loaded — clears stale ids pointing at deleted projects /
  // closed tabs, falling back to the first available.
  // The ref suppresses the immediate follow-up run caused by our own setActive
  // in the previous cycle — that second run would just re-validate the tab we
  // just wrote and log a spurious "keep". A user-driven setActive still runs
  // normally because the ref was cleared on the last cycle.
  const reconcileSelfRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (reconcileSelfRef.current) {
      reconcileSelfRef.current = false;
      return;
    }
    const { next, events, changed } = reconcileActive(active, projects, workspace);
    for (const msg of events) logDebug('reconcile', msg);
    if (changed) {
      reconcileSelfRef.current = true;
      setActive(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, projectIdsSig, activeProjectId, activeTabId, activeGroupId, activeTabsSig, activeTabsMapKeysSig]);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeExport = useMemo(
    () => (activeTabId ? exportApiRef.current.get(activeTabId) ?? null : null),
    [activeTabId, exportApiVersion],
  );

  // Reflect the active project name into the browser tab title so users with
  // multiple windows open can tell them apart from the OS tab strip.
  useEffect(() => {
    document.title = activeProject ? `${activeProject.name} — AI Studio` : 'AI Studio';
  }, [activeProject]);

  // Record that a tab was visited so lazy-mount keeps it alive after the
  // first switch away. Fires whenever the active tab id changes.
  useEffect(() => {
    if (!activeTabId) return;
    setVisitedTabs((prev) => {
      if (prev.has(activeTabId)) return prev;
      const next = new Set(prev);
      next.add(activeTabId);
      logDebug('tab', `visited tabs +${activeTabId} (${next.size} mounted)`);
      return next;
    });
  }, [activeTabId]);

  function setActiveProject(id: string) {
    setActive((a) => {
      if (a.projectId === id) {
        logDebug('nav', `setActiveProject(${id}) — already active, no-op`);
        return a;
      }
      logDebug('nav', `setActiveProject: ${a.projectId ?? 'null'} → ${id}`);
      return { ...a, projectId: id };
    });
  }

  // Remember the last active tab per Group so switching back to a Group
  // restores where the user was, not just its first tab. Keyed "pid:gid".
  const lastTabByGroup = useRef<Map<string, string>>(new Map());

  function setActiveSelection(projectId: string, groupId: string, tabId: string | null) {
    if (tabId) lastTabByGroup.current.set(`${projectId}:${groupId}`, tabId);
    setActive((a) => {
      const prevTab = a.tabs[projectId] ?? null;
      const prevGid = a.groups[projectId] ?? DEFAULT_GROUP_ID;
      if (prevTab === tabId && prevGid === groupId) {
        logDebug('nav', `setActiveSelection(${projectId}, ${groupId}, ${tabId ?? 'null'}) — already active, no-op`);
        return a;
      }
      logDebug('nav', `setActiveSelection: project ${projectId} tab ${prevTab ?? 'null'} → ${tabId ?? 'null'}, group ${prevGid} → ${groupId}`);
      return {
        ...a,
        tabs: { ...a.tabs, [projectId]: tabId },
        groups: { ...a.groups, [projectId]: groupId },
      };
    });
  }

  // Activate a tab; the active Group follows the tab (it may live in another
  // Group, e.g. when a file already open elsewhere is re-opened).
  function setActiveTab(projectId: string, tabId: string | null, tabList?: Tab[]) {
    const list = tabList ?? workspaceRef.current.projects[projectId]?.tabs ?? [];
    const tab = tabId ? list.find((t) => t.id === tabId) : undefined;
    const gid = tab ? tabGroupId(tab) : (active.groups[projectId] ?? DEFAULT_GROUP_ID);
    setActiveSelection(projectId, gid, tab ? tab.id : null);
  }

  // Switch Group: restore its last active tab if still there, else its first
  // tab, else nothing (empty Group → empty TabBar).
  function setActiveGroup(projectId: string, groupId: string, tabList?: Tab[]) {
    const list = (tabList ?? workspaceRef.current.projects[projectId]?.tabs ?? []).filter(
      (t) => tabGroupId(t) === groupId,
    );
    const remembered = lastTabByGroup.current.get(`${projectId}:${groupId}`);
    const tab = (remembered && list.find((t) => t.id === remembered)) || list[0] || null;
    setActiveSelection(projectId, groupId, tab ? tab.id : null);
  }

  function updateProjectTabs(projectId: string, nextTabs: Tab[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: nextTabs, groups: current?.groups ?? [], batches: current?.batches ?? [] });
  }

  function updateProjectGroups(projectId: string, nextGroups: Group[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], groups: nextGroups, batches: current?.batches ?? [] });
  }

  function updateProjectBatches(projectId: string, nextBatches: Batch[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], groups: current?.groups ?? [], batches: nextBatches });
  }

  function openFileTab(filePath: string) {
    if (!activeProjectId) {
      logDebug('tab', `openFileTab(${filePath}) ignored — no active project`);
      return;
    }
    const existing = tabs.find((t) => t.type === 'file' && t.path === filePath);
    if (existing) {
      logDebug('tab', `openFileTab: file ${filePath} already open (tab ${existing.id}), activating`);
      setActiveTab(activeProjectId, existing.id);
      return;
    }
    const tab: Tab = { id: randomId(), type: 'file', path: filePath, groupId: activeGroupId };
    logDebug('tab', `openFileTab: new file tab ${tab.id} for ${filePath} in project ${activeProjectId} group ${activeGroupId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, activeGroupId, tab.id);
  }

  // Returns the (existing or new) tab id so callers like JumpToComment can
  // target it.
  function openSessionTab(resumeId?: string, title?: string): string | undefined {
    if (!activeProjectId) {
      logDebug('tab', 'openSessionTab ignored — no active project');
      return;
    }
    // Resume of an already-open session: activate the existing tab instead of
    // duplicating. Two tabs on the same sessionId share one server-side entry
    // and just confuse the user (typing in one updates state in the other).
    if (resumeId) {
      const existing = tabs.find((t) => t.type === 'session' && t.resumeId === resumeId);
      if (existing) {
        logDebug('tab', `openSessionTab: session ${resumeId} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return existing.id;
      }
    }
    const d = new Date();
    const defaultTitle = `Chat ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tab: Tab = { id: randomId(), type: 'session', resumeId, title: title || defaultTitle, groupId: activeGroupId };
    logDebug('tab', `openSessionTab: new session tab ${tab.id}${resumeId ? ` (resume ${resumeId})` : ' (fresh)'} in project ${activeProjectId} group ${activeGroupId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, activeGroupId, tab.id);
    return tab.id;
  }

  function openDevinTab(resumeId?: string, title?: string): string | undefined {
    if (!activeProjectId) {
      logDebug('tab', 'openDevinTab ignored — no active project');
      return;
    }
    if (resumeId) {
      const existing = tabs.find((t) => t.type === 'devin' && t.resumeId === resumeId);
      if (existing) {
        logDebug('tab', `openDevinTab: devin session ${resumeId} already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return existing.id;
      }
    }
    const d = new Date();
    const defaultTitle = `Devin ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const tab: Tab = { id: randomId(), type: 'devin', resumeId, title: title || defaultTitle, groupId: activeGroupId };
    logDebug('tab', `openDevinTab: new devin tab ${tab.id}${resumeId ? ` (resume ${resumeId})` : ' (fresh)'} in project ${activeProjectId} group ${activeGroupId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, activeGroupId, tab.id);
    return tab.id;
  }

  // Generic append + activate for registered tab kinds (TabRenderContext.openTab).
  function openTab(newTab: Tab) {
    if (!activeProjectId) {
      logDebug('tab', `openTab(${newTab.type}) ignored — no active project`);
      return;
    }
    // File tabs dedupe on path (same as the file tree) so a citation clicked
    // twice, or for a file already open, just activates the existing tab.
    if (newTab.type === 'file') {
      openFileTab(newTab.path);
      return;
    }
    const tab: Tab = { ...newTab, groupId: activeGroupId };
    logDebug('tab', `openTab: new ${tab.type} tab ${tab.id} in project ${activeProjectId} group ${activeGroupId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, activeGroupId, tab.id);
  }

  function openTabOfKind(kindId: string) {
    if (!activeProjectId || !activeProject) {
      logDebug('tab', `openTabOfKind(${kindId}) ignored — no active project`);
      return;
    }
    const kind = getTabKind(kindId);
    if (!kind?.createAction) {
      logDebug('tab', `openTabOfKind(${kindId}) ignored — kind not registered or missing createAction`);
      return;
    }
    if (kind.singleton) {
      const existing = tabs.find((t) => t.type === kindId);
      if (existing) {
        logDebug('tab', `openTabOfKind(${kindId}): singleton already open (tab ${existing.id}), activating`);
        setActiveTab(activeProjectId, existing.id);
        return;
      }
    }
    const created = kind.createAction.create({ project: { id: activeProject.id, path: activeProject.path } });
    const tab: Tab = { ...created, groupId: activeGroupId };
    logDebug('tab', `openTabOfKind: new ${kindId} tab ${tab.id} in project ${activeProjectId} group ${activeGroupId}`);
    updateProjectTabs(activeProjectId, [...tabs, tab]);
    setActiveSelection(activeProjectId, activeGroupId, tab.id);
  }

  function activateTab(id: string) {
    if (!activeProjectId) return;
    setActiveTab(activeProjectId, id);
  }

  function closeTab(id: string) {
    if (!activeProjectId) return;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) {
      logDebug('tab', `closeTab(${id}) ignored — tab not found`);
      return;
    }
    const nextTabs = tabs.filter((t) => t.id !== id);
    logDebug('tab', `closeTab: closed tab ${id} in project ${activeProjectId} (${tabs.length} → ${nextTabs.length})`);
    updateProjectTabs(activeProjectId, nextTabs);
    // Release the mounted-panel slot so it can be re-mounted fresh if the
    // user later opens a tab with the same id (unlikely but possible on
    // workspace reload).
    setVisitedTabs((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (activeTabId === id) {
      // Fall back to a neighbour inside the same Group so closing never
      // silently jumps the user to another Group.
      const gid = tabGroupId(tabs[idx]);
      const siblings = tabs.filter((t) => tabGroupId(t) === gid);
      const sIdx = siblings.findIndex((t) => t.id === id);
      const nextSiblings = siblings.filter((t) => t.id !== id);
      const fallback = nextSiblings[Math.min(sIdx, nextSiblings.length - 1)]?.id ?? null;
      logDebug('tab', `closed tab was active → fallback to ${fallback ?? 'null'} (group ${gid})`);
      setActiveSelection(activeProjectId, gid, fallback);
    }
  }

  function createGroup() {
    if (!activeProjectId) return;
    const name = prompt('New group name')?.trim();
    if (!name) return;
    const group: Group = { id: randomId(), name };
    logDebug('group', `createGroup: ${group.id} "${name}" in project ${activeProjectId}`);
    // New Groups go to the top of the list (groups[] order = display order).
    updateProjectGroups(activeProjectId, [group, ...groups]);
    setActiveSelection(activeProjectId, group.id, null);
  }

  // Drag-to-reorder from GroupList: same id set, new order. Persisted via the
  // usual whole-project PUT; groups[] order is the display order.
  function reorderGroups(next: Group[]) {
    if (!activeProjectId) return;
    const same = next.length === groups.length && next.every((g) => groups.some((x) => x.id === g.id));
    if (!same) return;
    logDebug('group', `reorderGroups: ${next.map((g) => g.id).join(',')}`);
    updateProjectGroups(activeProjectId, next);
  }

  function renameGroup(id: string, name: string) {
    if (!activeProjectId || id === DEFAULT_GROUP_ID) return;
    const trimmed = name.trim();
    if (!trimmed || !groups.some((g) => g.id === id)) return;
    logDebug('group', `renameGroup: ${id} → "${trimmed}"`);
    updateProjectGroups(activeProjectId, groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)));
  }

  function deleteGroup(id: string) {
    if (!activeProjectId || id === DEFAULT_GROUP_ID) return;
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    const victims = tabs.filter((t) => tabGroupId(t) === id);
    const msg = victims.length
      ? `Delete group "${group.name}" and close its ${victims.length} tab(s)?`
      : `Delete group "${group.name}"?`;
    if (!confirm(msg)) return;
    const nextTabs = tabs.filter((t) => tabGroupId(t) !== id);
    logDebug('group', `deleteGroup: ${id} "${group.name}" closed ${victims.length} tab(s)`);
    saveProjectWorkspace(activeProjectId, { tabs: nextTabs, groups: groups.filter((g) => g.id !== id), batches });
    if (victims.length) {
      setVisitedTabs((prev) => {
        const next = new Set(prev);
        for (const t of victims) next.delete(t.id);
        return next;
      });
    }
    if (activeGroupId === id) setActiveGroup(activeProjectId, DEFAULT_GROUP_ID, nextTabs);
  }

  function moveTabToGroup(tabId: string, groupId: string) {
    if (!activeProjectId) return;
    if (!groupExists(projectWs, groupId)) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tabGroupId(tab) === groupId) return;
    logDebug('group', `moveTabToGroup: tab ${tabId} ${tabGroupId(tab)} → ${groupId}`);
    const nextTabs = tabs.map((t) => (t.id === tabId ? { ...t, groupId } : t));
    updateProjectTabs(activeProjectId, nextTabs);
    // Keep looking at the moved tab: the active Group follows it.
    if (activeTabId === tabId) setActiveSelection(activeProjectId, groupId, tabId);
  }

  // ---- Review (model: entity Batch / Comment; package Review) ----
  // All mutations go through lib/review on the freshest batches[] (not this
  // render's closure) so back-to-back changes compose.

  function latestBatches(): Batch[] {
    return activeProjectId ? workspaceRef.current.projects[activeProjectId]?.batches ?? [] : [];
  }

  function applyBatches(label: string, fn: (batches: Batch[]) => Batch[]) {
    if (!activeProjectId) return;
    const before = latestBatches();
    const next = fn(before);
    if (next === before) return;
    logDebug('review', label);
    updateProjectBatches(activeProjectId, next);
  }

  const currentBatch = review.resolveCurrentBatch(batches, activeProjectId ? currentBatches[activeProjectId] : null);

  function setCurrentBatch(batchId: string) {
    if (!activeProjectId) return;
    setCurrentBatches((m) => ({ ...m, [activeProjectId]: batchId }));
  }

  // The batch new comments go to, creating "Batch N" when no draft exists.
  function withCurrentBatch(batches: Batch[]): { batches: Batch[]; batch: Batch } {
    const existing = review.resolveCurrentBatch(batches, activeProjectId ? currentBatches[activeProjectId] : null);
    if (existing) return { batches, batch: existing };
    const batch = review.newBatch(batches, randomId(), Date.now());
    setCurrentBatch(batch.id);
    return { batches: [...batches, batch], batch };
  }

  function createBatch() {
    applyBatches('createBatch', (bs) => {
      const batch = review.newBatch(bs, randomId(), Date.now());
      setCurrentBatch(batch.id);
      return [...bs, batch];
    });
  }

  function renameBatch(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    applyBatches(`renameBatch: ${id}`, (bs) => (
      bs.some((b) => b.id === id && b.name !== trimmed) ? bs.map((b) => (b.id === id ? { ...b, name: trimmed } : b)) : bs
    ));
  }

  function deleteBatch(id: string) {
    const batch = latestBatches().find((b) => b.id === id);
    if (!batch) return;
    if (batch.status === 'draft' && batch.comments.length > 0) {
      const n = batch.comments.length;
      if (!confirm(`Delete "${batch.name}" and its ${n} comment${n === 1 ? '' : 's'}?`)) return;
    }
    applyBatches(`deleteBatch: ${id}`, (bs) => bs.filter((b) => b.id !== id));
  }

  // "+ Comment" under a batch in the panel (model: web.AddComment).
  function addPlainComment(batchId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const origin = tabRef(activeTab);
    const comment: Comment = { id: randomId(), text: trimmed, createdAt: Date.now(), ...(origin ? { tab: origin } : {}) };
    applyBatches(`addComment: ${comment.id} → batch ${batchId}`, (bs) => review.addComment(bs, batchId, comment));
  }

  // From a session panel: a text selection (model: web.CommentOnSelection).
  // Returns a status for the panel to toast.
  function addSessionComment(tab: Tab, c: NewComment): string | null {
    if (!activeProjectId) return null;
    const trimmed = c.text.trim();
    if (!trimmed) return null;
    const origin = tabRef(tab);
    const comment: Comment = {
      id: randomId(),
      text: trimmed,
      createdAt: Date.now(),
      ...(c.quote ? { quote: review.clampQuote(c.quote) } : {}),
      ...(origin ? { tab: origin } : {}),
      // An anchor is only meaningful together with the session it lives in.
      ...(origin && c.anchor ? { anchor: c.anchor } : {}),
    };
    const { batches: withBatch, batch } = withCurrentBatch(latestBatches());
    logDebug('review', `comment ${comment.id} → batch ${batch.id} (${comment.anchor ?? 'no anchor'}${comment.quote ? `, quote ${comment.quote.length} chars` : ''})`);
    updateProjectBatches(activeProjectId, review.addComment(withBatch, batch.id, comment));
    // A collapsed panel would hide the new row — open it so the user sees
    // where the comment went (model: web.ToggleReviewPanel).
    setReviewCollapsed(false);
    return `Added to ${batch.name}`;
  }

  function editComment(id: string, text: string) {
    applyBatches(`editComment: ${id}`, (bs) => review.editComment(bs, id, text));
  }

  function deleteComment(id: string) {
    applyBatches(`deleteComment: ${id}`, (bs) => review.deleteComment(bs, id));
  }

  // Reorder within a batch or move to another draft (model:
  // web.ReorderComments / web.MoveComment).
  function placeComment(id: string, batchId: string, index?: number) {
    applyBatches(`placeComment: ${id} → batch ${batchId}${index == null ? '' : ` @${index}`}`, (bs) => review.placeComment(bs, id, batchId, index));
  }

  function moveCommentToNewBatch(id: string) {
    applyBatches(`moveCommentToNewBatch: ${id}`, (bs) => {
      const batch = review.newBatch(bs, randomId(), Date.now());
      const next = review.placeComment([...bs, batch], id, batch.id);
      if (next.length === bs.length + 1 && next[next.length - 1].comments.length === 0) return bs;
      setCurrentBatch(batch.id);
      return next;
    });
  }

  // Model: web.ViewQuoteComments — a painted quote was clicked in a session:
  // make sure the panel is showing, then have it scroll to / flash the row.
  const [focusedComment, setFocusedComment] = useState<{ id: string; seq: number } | null>(null);
  function focusComment(commentId: string) {
    setReviewCollapsed(false);
    setDrawerOpen(false);
    setReviewDrawerOpen(true);
    setFocusedComment((prev) => ({ id: commentId, seq: (prev?.seq ?? 0) + 1 }));
  }

  function reopenBatch(id: string) {
    applyBatches(`reopenBatch: ${id}`, (bs) => review.reopenBatch(bs, id));
  }

  // Reported by a session panel once a prompt carrying this Batch really
  // went out (model: web.InsertBatchPrompt).
  function markBatchSent(batchId: string) {
    applyBatches(`markBatchSent: ${batchId}`, (bs) => review.markBatchSent(bs, batchId, Date.now()));
  }

  // Anchored comments per tab (model: web.HighlightQuotes) so panels can
  // outline those messages and paint the quotes. Recomputed only when
  // batches / tabs change.
  const commentMarksByTab = useMemo(() => {
    const map = new Map<string, review.CommentMark[]>();
    for (const t of tabs) {
      if (t.type !== 'session' && t.type !== 'devin') continue;
      const ref = tabRef(t);
      const marks = ref ? review.commentMarksFor(batches, ref) : [];
      if (marks.length) map.set(t.id, marks);
    }
    return map;
  }, [tabs, batches]);
  const draftComments = useMemo(() => review.draftCommentCount(batches), [batches]);

  // Activate the tab a TabRef points at, re-opening it if it was closed.
  // Returns the tab id (model: web.JumpToComment / web.SendBatch → OpenTab).
  function openTabRef(ref: TabRef, title: string): string | undefined {
    if (!activeProjectId) return undefined;
    const existing = tabs.find((t) => sameTabRef(tabRef(t), ref));
    if (existing) {
      setActiveTab(activeProjectId, existing.id);
      return existing.id;
    }
    if (ref.type === 'session') return openSessionTab(ref.key, title);
    if (ref.type === 'devin') return openDevinTab(ref.key, title);
    // Non-session tabs have no panel API to follow up with; no id needed.
    if (ref.type === 'file') openFileTab(ref.key);
    else openTabOfKind(ref.type);
    return undefined;
  }

  // Clicking a comment row: bring back the tab it was written in, then ask
  // its panel to scroll to the anchored message once it has registered.
  function jumpToComment(comment: Comment) {
    if (!comment.tab) return;
    setReviewDrawerOpen(false);
    const tabId = openTabRef(comment.tab, comment.text.slice(0, 30));
    logDebug('review', `jumpToComment: ${comment.id} → tab ${tabId ?? '(none)'} anchor ${comment.anchor ?? '(none)'}`);
    if (!tabId || !comment.anchor) return;
    pendingRevealRef.current = { tabId, anchor: comment.anchor };
    // Panel already mounted → reveal now (it waits internally until the tab
    // is actually displayed). Otherwise registerPanelApi fires it on mount.
    fireReveal(tabId, comment.anchor);
  }

  // Model: web.SendBatch — fill the batch's prompt into the target session's
  // input box. The Batch only turns `sent` when the user really sends it.
  function sendBatch(id: string) {
    const batch = latestBatches().find((b) => b.id === id);
    if (!batch || batch.comments.length === 0 || !activeProjectId) return;
    const target = review.batchTargetSession(batch);
    let tabId: string | undefined;
    if (target) tabId = openTabRef(target, batch.name);
    else if (activeTab && (activeTab.type === 'session' || activeTab.type === 'devin')) tabId = activeTab.id;
    if (!tabId) {
      showAppToast('Open the session tab you want to send this batch to');
      return;
    }
    setReviewDrawerOpen(false);
    const text = review.composeBatchPrompt(batch);
    logDebug('review', `sendBatch: ${id} (${batch.comments.length} comments) → tab ${tabId}`);
    pendingInsertRef.current = { tabId, text, batchId: id };
    fireInsert(tabId, text, id);
    showAppToast('Batch filled into the input — review and press Send');
  }

  async function handleAddProject(path: string, name?: string) {
    try {
      const p = await addProject({ path, name });
      logDebug('nav', `added project ${p.id} (${path})`);
      const ps = await listProjects();
      setProjects(ps);
      // In-memory only: server creates the workspace slot on the first
      // per-project PUT (when a tab is actually opened). No need to PUT an
      // empty slot up-front.
      setWorkspace((ws) => {
        if (ws.projects[p.id]) return ws;
        return { ...ws, projects: { ...ws.projects, [p.id]: { tabs: [], groups: [], batches: [] } } };
      });
      setActive((a) => {
        logDebug('nav', `new project auto-active: ${a.projectId ?? 'null'} → ${p.id}`);
        return { ...a, projectId: p.id };
      });
    } catch (e: any) {
      logDebug('nav', `addProject failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  // Model: web.ArchiveProject — PATCH then re-list; reconcile (keyed on the
  // archived flag via projectIdsSig) moves the active pointer off an archived
  // project. Workspace data is untouched.
  async function handleArchiveProject(id: string, archived: boolean) {
    try {
      await updateProject(id, { archived });
      logDebug('nav', `${archived ? 'archived' : 'unarchived'} project ${id}`);
      setProjects(await listProjects());
    } catch (e: any) {
      logDebug('nav', `archiveProject failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  // Model: web.ReorderProjects — PUT the full order, then re-list.
  async function handleReorderProjects(ids: string[]) {
    try {
      await reorderProjects(ids);
      logDebug('nav', `reordered projects: ${ids.join(',')}`);
      setProjects(await listProjects());
    } catch (e: any) {
      logDebug('nav', `reorderProjects failed: ${e.message}`);
      alert(`Failed: ${e.message}`);
    }
  }

  async function handleDeleteProject(id: string) {
    if (!confirm('Remove this project from the list? (files are not touched)')) return;
    await deleteProject(id);
    logDebug('nav', `deleted project ${id}`);
    const ps = await listProjects();
    setProjects(ps);
    // Server-side deleteProject already removed the workspace slot for us
    // (see store.ts deleteProject). Just mirror in memory + drop any pending
    // per-project save timer for the deleted project.
    const pending = projectSaveTimers.current.get(id);
    if (pending) window.clearTimeout(pending);
    projectSaveTimers.current.delete(id);
    projectSavePayloads.current.delete(id);
    setWorkspace((ws) => {
      if (!ws.projects[id]) return ws;
      const nextProjects = { ...ws.projects };
      delete nextProjects[id];
      return { ...ws, projects: nextProjects };
    });
    setActive((a) => {
      const nextTabs = { ...a.tabs };
      delete nextTabs[id];
      const nextGroups = { ...a.groups };
      delete nextGroups[id];
      const nextProject = a.projectId === id ? (ps[0]?.id ?? null) : a.projectId;
      if (a.projectId === id) {
        logDebug('nav', `deleted project was active → fallback to ${nextProject ?? 'null'}`);
      }
      return { projectId: nextProject, tabs: nextTabs, groups: nextGroups };
    });
  }

  if (!authState) return <div className="loading">Loading…</div>;
  if (authState.required && !authState.authenticated) {
    return <Login onSuccess={() => window.location.reload()} />;
  }
  if (!loaded) return <div className="loading">Loading…</div>;

  // Model: web.ReviewPanel — the whole Review feature is opt-in (settings.review).
  const reviewOn = settings.review ?? false;

  return (
    <div
      className={`app${reviewOn ? '' : ' no-review'}`}
      style={{
        ...(sidebarWidth != null ? { '--sidebar-width': `${sidebarWidth}px` } : {}),
        ...(reviewCollapsed
          ? { '--review-width': `${REVIEW_COLLAPSED_WIDTH}px` }
          : reviewWidth != null ? { '--review-width': `${reviewWidth}px` } : {}),
      } as React.CSSProperties}
    >
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {reviewOn && reviewDrawerOpen && <div className="review-drawer-backdrop" onClick={() => setReviewDrawerOpen(false)} />}

      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="panel files-panel">
          <div
            className="sidebar-resize"
            title="Drag to resize; double-click to reset"
            onPointerDown={onSidebarResizeDown}
            onPointerMove={onSidebarResizeMove}
            onPointerUp={onSidebarResizeUp}
            onPointerCancel={onSidebarResizeUp}
            onDoubleClick={() => setSidebarWidth(null)}
          />
          <div className="panel-header">
            <ProjectPicker
              projects={projects.filter((p) => !p.archived)}
              activeId={activeProjectId}
              onSelect={setActiveProject}
              onManage={() => setProjectManagerOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenDevinUsage={() => setDevinUsageOpen(true)}
              onOpenDebug={() => setDebugOpen(true)}
              downloadMode={downloadMode}
              onToggleDownloadMode={() => setDownloadMode((v) => !v)}
              sidebarView={sidebarView}
              onToggleSidebarView={() => setSidebarView((v) => (v === 'files' ? 'groups' : 'files'))}
            />
          </div>
          <div className="panel-body">
            {!activeProject ? (
              <div className="empty">Select or add a project</div>
            ) : sidebarView === 'files' ? (
              <FileTree
                projectId={activeProject.id}
                onSelect={(p) => {
                  if (downloadMode) {
                    triggerDownload(activeProject.id, p);
                    return;
                  }
                  openFileTab(p);
                  setDrawerOpen(false);
                }}
                selectedPath={activeTab?.type === 'file' ? activeTab.path : null}
              />
            ) : (
              <GroupList
                groups={groups}
                tabs={tabs}
                activeGroupId={activeGroupId}
                onSelectGroup={(gid) => setActiveGroup(activeProject.id, gid)}
                onCreateGroup={createGroup}
                onRenameGroup={renameGroup}
                onDeleteGroup={deleteGroup}
                onReorderGroups={reorderGroups}
              />
            )}
          </div>
        </div>
      </div>

      <div className="panel main-panel">
        <TabBar
          onMenuClick={() => { setReviewDrawerOpen(false); setDrawerOpen((v) => !v); }}
          reviewCount={draftComments}
          onReviewClick={reviewOn ? () => { setDrawerOpen(false); setReviewDrawerOpen((v) => !v); } : undefined}
          activeProjectName={activeProject?.name ?? null}
          onRefresh={
            activeTab
              ? () => setRefreshKey((r) => ({ ...r, [activeTab.id]: (r[activeTab.id] ?? 0) + 1 }))
              : undefined
          }
          onExport={activeExport?.open}
          canExport={activeExport?.canExport ?? false}
          tabs={visibleTabs}
          activeTabId={activeTabId}
          onActivate={activateTab}
          onClose={closeTab}
          activeGroupName={groupName(groups, activeGroupId)}
          moveTargets={[
            ...(activeGroupId !== DEFAULT_GROUP_ID ? [{ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME }] : []),
            ...groups.filter((g) => g.id !== activeGroupId),
          ]}
          onMoveTab={moveTabToGroup}
          onNewSession={() => openSessionTab()}
          onOpenTabKind={openTabOfKind}
          onResumeSession={
            activeProject
              ? async () => {
                  const list = await listResumableSessions(activeProject.id);
                  if (list.length === 0) {
                    alert('No resumable Claude sessions for this project');
                    return;
                  }
                  const items: PickerItem[] = list.map((s) => ({
                    id: s.uuid,
                    primary: s.preview || s.uuid.slice(0, 8),
                    secondary: s.uuid.slice(0, 8),
                    timestamp: s.mtime,
                  }));
                  setPicker({
                    title: 'Resume Claude session',
                    items,
                    onPick: (uuid) => {
                      const s = list.find((x) => x.uuid === uuid);
                      if (s) openSessionTab(s.uuid, s.preview.slice(0, 30) || s.uuid.slice(0, 8));
                      setPicker(null);
                    },
                  });
                }
              : undefined
          }
          onNewDevinSession={activeProject ? () => openDevinTab() : undefined}
          onResumeDevinSession={
            activeProject
              ? async () => {
                  const list = await listDevinSessions(activeProject.id);
                  if (list.length === 0) {
                    alert('No resumable Devin sessions for this project');
                    return;
                  }
                  const items: PickerItem[] = list.map((s) => ({
                    id: s.sessionId,
                    primary: s.title || s.sessionId,
                    secondary: s.sessionId,
                    timestamp: s.updatedAt ? new Date(s.updatedAt).getTime() : undefined,
                  }));
                  setPicker({
                    title: 'Resume Devin session',
                    items,
                    onPick: (sid) => {
                      const s = list.find((x) => x.sessionId === sid);
                      if (s) openDevinTab(s.sessionId, s.title || s.sessionId);
                      setPicker(null);
                    },
                  });
                }
              : undefined
          }
        />
        <div className="panel-body main-body">
          {activeProject ? (
            <>
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                // Lazy-mount gate: skip rendering until this tab has been the
                // active tab at least once. Prevents e.g. 77 devin panels
                // spinning up transcript fetches + WS connections at boot.
                if (!isActive && !visitedTabs.has(tab.id)) return null;
                const rk = refreshKey[tab.id] ?? 0;
                const tabKey = `${tab.id}-${rk}`;
                const style: React.CSSProperties = isActive
                  ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
                  : { display: 'none' };
                const kind = getTabKind(tab.type);
                const body = kind ? kind.render({
                  tab,
                  project: activeProject,
                  settings,
                  updateTabs: (updater) => {
                    if (!activeProjectId) return;
                    updateProjectTabs(activeProjectId, updater(tabs));
                  },
                  openTab,
                  updateSettings,
                  registerExportApi: (api) => registerExportApi(tab.id, api),
                  addComment: (c) => addSessionComment(tab, c),
                  commentMarks: commentMarksByTab.get(tab.id) ?? NO_COMMENT_MARKS,
                  markBatchSent,
                  focusComment,
                  registerPanelApi: (api) => registerPanelApi(tab.id, api),
                }) : <div className="empty">Unknown tab kind: {tab.type}</div>;
                return <div key={tabKey} style={style}>{body}</div>;
              })}
              {!activeTab && (
                <div className="empty">
                  {visibleTabs.length === 0 && (activeGroupId !== DEFAULT_GROUP_ID || tabs.length > 0)
                    ? `Group "${groupName(groups, activeGroupId)}" is empty — open a file or start an AI session`
                    : 'Open a file or start an AI session'}
                </div>
              )}
            </>
          ) : (
            <div className="empty">No project selected</div>
          )}
        </div>
      </div>

      {reviewOn && (
      <div className={`review-drawer ${reviewDrawerOpen ? 'open' : ''}`}>
        <div className={`panel review-panel ${reviewCollapsed ? 'collapsed' : ''}`}>
          <div
            className="review-resize"
            title="Drag to resize; double-click to reset"
            onPointerDown={onReviewResizeDown}
            onPointerMove={onReviewResizeMove}
            onPointerUp={onReviewResizeUp}
            onPointerCancel={onReviewResizeUp}
            onDoubleClick={() => setReviewWidth(null)}
          />
          <div className="panel-header">
            {!reviewCollapsed && <span>Review</span>}
            <button
              className="review-collapse"
              onClick={() => setReviewCollapsed((v) => !v)}
              title={reviewCollapsed ? 'Expand Review' : 'Collapse Review'}
              aria-label={reviewCollapsed ? 'Expand Review' : 'Collapse Review'}
            >{reviewCollapsed ? '«' : '»'}</button>
            <button className="review-panel-close" onClick={() => setReviewDrawerOpen(false)} aria-label="Close">×</button>
          </div>
          <div className="panel-body">
            {activeProject ? (
              <ReviewPanel
                batches={batches}
                currentBatchId={currentBatch?.id ?? null}
                focused={focusedComment}
                onAddComment={addPlainComment}
                onEditComment={editComment}
                onDeleteComment={deleteComment}
                onPlaceComment={placeComment}
                onMoveToNewBatch={moveCommentToNewBatch}
                onJump={jumpToComment}
                onCreateBatch={createBatch}
                onRenameBatch={renameBatch}
                onDeleteBatch={deleteBatch}
                onSetCurrent={setCurrentBatch}
                onSendBatch={sendBatch}
                onReopenBatch={reopenBatch}
              />
            ) : (
              <div className="empty">Select a project</div>
            )}
          </div>
        </div>
      </div>
      )}

      {appToast && <div className="app-toast">{appToast}</div>}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          username={authState?.username}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onSignOut={async () => {
            await logout();
            window.location.reload();
          }}
        />
      )}
      {devinUsageOpen && <DevinUsage onClose={() => setDevinUsageOpen(false)} />}
      {projectManagerOpen && (
        <ProjectManager
          projects={projects}
          activeId={activeProjectId}
          onAdd={handleAddProject}
          onArchive={handleArchiveProject}
          onReorder={handleReorderProjects}
          onDelete={handleDeleteProject}
          onClose={() => setProjectManagerOpen(false)}
        />
      )}
      {debugOpen && <DebugPanel onClose={() => setDebugOpen(false)} />}
      {picker && (
        <SessionPicker
          title={picker.title}
          items={picker.items}
          onPick={picker.onPick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

