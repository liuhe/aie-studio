import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree } from './components/FileTree';
import { GroupList } from './components/GroupList';
import { PinList } from './components/PinList';
import { ProjectPicker } from './components/ProjectPicker';
import { TabBar } from './components/TabBar';
import { Settings as SettingsModal } from './components/Settings';
import { DevinUsage } from './components/DevinUsage';
import { SessionPicker, type PickerItem } from './components/SessionPicker';
import { Login } from './components/Login';
import { DebugPanel } from './components/DebugPanel';
import { logDebug } from './lib/debugLog';
import { getTabKind, listTabKinds, type MessageLocator } from './registry';
import {
  listProjects,
  addProject,
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
import type { Project, Tab, Group, Pin, Workspace, ProjectWorkspace, Settings } from './types';
import { DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, tabGroupId, tabRef, sameTabRef, pinTabRef } from './types';
import { isStandalone } from './usePwaInstall';

const DEFAULT_SETTINGS: Settings = { sendKey: 'cmd-enter', theme: 'dark', fontScale: 'normal', model: '', devinModel: '', devinMode: '', showStderr: false, richCopy: false, pinboard: false };

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
// Desktop Pinboard column (model: web.ResizePinboard / web.TogglePinboard).
// null width = CSS default (280px); collapsed = 32px rail with just «.
const PIN_WIDTH_LS_KEY = `${LS_PREFIX}pinWidth`;
const PIN_COLLAPSED_LS_KEY = `${LS_PREFIX}pinCollapsed`;
const PIN_MIN_WIDTH = 200;
const PIN_MAX_WIDTH = 600;
const PIN_COLLAPSED_WIDTH = 32;
// Pinboard filter (model: web.FilterPins): everything in the project, or only
// bookmarks into the active tab's session.
const PIN_FILTER_LS_KEY = `${LS_PREFIX}pinFilter`;
type PinFilter = 'all' | 'tab';
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

function loadPinWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(PIN_WIDTH_LS_KEY));
    return Number.isFinite(n) && n >= PIN_MIN_WIDTH && n <= PIN_MAX_WIDTH ? n : null;
  } catch { return null; }
}

function loadPinFilter(): PinFilter {
  try { return localStorage.getItem(PIN_FILTER_LS_KEY) === 'tab' ? 'tab' : 'all'; } catch { return 'all'; }
}

function loadPinCollapsed(): boolean {
  try { return localStorage.getItem(PIN_COLLAPSED_LS_KEY) === '1'; } catch { return false; }
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
  const projectExists = projectId && projects.some((p) => p.id === projectId);
  if (!projectExists) {
    const fallback = projects[0]?.id ?? null;
    if (projectId !== fallback) {
      events.push(
        `active project ${projectId ?? 'null'} not in projects list → fallback to ${fallback ?? 'null'}`,
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
  // Mobile-only right drawer for the Pinboard (model: web.PinList). Desktop
  // renders the same panel as a permanent third column.
  const [pinDrawerOpen, setPinDrawerOpen] = useState(false);
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
  const [pinWidth, setPinWidth] = useState<number | null>(() => loadPinWidth());
  useEffect(() => {
    try {
      if (pinWidth == null) localStorage.removeItem(PIN_WIDTH_LS_KEY);
      else localStorage.setItem(PIN_WIDTH_LS_KEY, String(pinWidth));
    } catch {}
  }, [pinWidth]);
  const [pinCollapsed, setPinCollapsed] = useState<boolean>(() => loadPinCollapsed());
  useEffect(() => {
    try { localStorage.setItem(PIN_COLLAPSED_LS_KEY, pinCollapsed ? '1' : '0'); } catch {}
  }, [pinCollapsed]);
  const [pinFilter, setPinFilter] = useState<PinFilter>(() => loadPinFilter());
  useEffect(() => {
    try { localStorage.setItem(PIN_FILTER_LS_KEY, pinFilter); } catch {}
  }, [pinFilter]);
  // Drag bar on the Pinboard's *left* edge: moving the pointer left grows it.
  const pinDragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onPinResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pinDragRef.current = { startX: e.clientX, startW: panel.offsetWidth };
  };
  const onPinResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = pinDragRef.current;
    if (!d) return;
    setPinWidth(Math.min(PIN_MAX_WIDTH, Math.max(PIN_MIN_WIDTH, d.startW - (e.clientX - d.startX))));
  };
  const onPinResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pinDragRef.current) return;
    pinDragRef.current = null;
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
  // Per-tab message locators (model: web.RevealMessage). A jump that has to
  // open / lazy-mount a tab parks its anchor in pendingReveal until that
  // tab's panel registers.
  const locatorRef = useRef<Map<string, MessageLocator>>(new Map());
  const pendingRevealRef = useRef<{ tabId: string; anchor: string } | null>(null);
  const fireReveal = useCallback((tabId: string, anchor: string) => {
    const loc = locatorRef.current.get(tabId);
    if (!loc) return false;
    pendingRevealRef.current = null;
    logDebug('pin', `reveal ${anchor} in tab ${tabId}`);
    loc.reveal(anchor).then((found) => {
      if (!found) showAppToast('Message not found in this session');
    });
    return true;
  }, [showAppToast]);
  const registerLocator = useCallback((tabId: string, api: MessageLocator | null) => {
    if (api) locatorRef.current.set(tabId, api);
    else locatorRef.current.delete(tabId);
    const pending = pendingRevealRef.current;
    if (api && pending && pending.tabId === tabId) fireReveal(tabId, pending.anchor);
  }, [fireReveal]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devinUsageOpen, setDevinUsageOpen] = useState(false);
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
        `settings: theme=${st.theme} fontScale=${st.fontScale} sendKey=${st.sendKey} model=${st.model || '(default)'} devinModel=${st.devinModel || '(default)'} devinMode=${st.devinMode || '(default)'} showStderr=${st.showStderr ?? false} richCopy=${st.richCopy ?? false} pinboard=${st.pinboard ?? false}`,
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
  const pins: Pin[] = projectWs?.pins ?? [];
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
  const projectIdsSig = useMemo(
    () => projects.map((p) => p.id).join('\0'),
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
    saveProjectWorkspace(projectId, { tabs: nextTabs, groups: current?.groups ?? [], pins: current?.pins ?? [] });
  }

  function updateProjectGroups(projectId: string, nextGroups: Group[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], groups: nextGroups, pins: current?.pins ?? [] });
  }

  function updateProjectPins(projectId: string, nextPins: Pin[]) {
    const current = workspaceRef.current.projects[projectId];
    saveProjectWorkspace(projectId, { tabs: current?.tabs ?? [], groups: current?.groups ?? [], pins: nextPins });
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

  // Returns the (existing or new) tab id so callers like JumpToBookmark can
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
    saveProjectWorkspace(activeProjectId, { tabs: nextTabs, groups: groups.filter((g) => g.id !== id), pins });
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

  // ---- Pinboard (model: entity Pin; web.AddNote / EditPin / DeletePin /
  // ReorderPins / BookmarkMessage / JumpToBookmark) ----

  function addNote(text: string) {
    if (!activeProjectId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // Remember which tab the note was written in (model: Pin.tab).
    const origin = tabRef(activeTab);
    const pin: Pin = { id: randomId(), kind: 'note', text: trimmed, createdAt: Date.now(), ...(origin ? { tab: origin } : {}) };
    logDebug('pin', `addNote: ${pin.id} in project ${activeProjectId}${origin ? ` (tab ${origin.type}:${origin.key})` : ''}`);
    updateProjectPins(activeProjectId, [...pins, pin]);
  }

  function editPin(id: string, text: string) {
    if (!activeProjectId) return;
    const trimmed = text.trim();
    if (!trimmed || !pins.some((p) => p.id === id)) return;
    logDebug('pin', `editPin: ${id}`);
    updateProjectPins(activeProjectId, pins.map((p) => (p.id === id ? { ...p, text: trimmed } : p)));
  }

  function deletePin(id: string) {
    if (!activeProjectId || !pins.some((p) => p.id === id)) return;
    logDebug('pin', `deletePin: ${id}`);
    updateProjectPins(activeProjectId, pins.filter((p) => p.id !== id));
  }

  // The subset PinList shows (model: web.FilterPins). "This tab" = Pins whose
  // origin TabRef equals the active tab's: bookmarks via their session, notes
  // via the tab they were written in.
  const activeRef = tabRef(activeTab);
  const visiblePins = useMemo(() => {
    if (pinFilter === 'all') return pins;
    if (!activeRef) return [];
    return pins.filter((p) => sameTabRef(pinTabRef(p), activeRef));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, pinFilter, activeRef?.type, activeRef?.key]);

  // `nextVisible` is the reordered *visible* subset. Same id set as what was
  // shown; the reordered items are written back into the slots those ids
  // occupied in pins[], so hidden pins keep their positions.
  function reorderPins(nextVisible: Pin[]) {
    if (!activeProjectId) return;
    const shownIds = new Set(visiblePins.map((p) => p.id));
    const same = nextVisible.length === shownIds.size && nextVisible.every((p) => shownIds.has(p.id));
    if (!same) return;
    let i = 0;
    const next = pins.map((p) => (shownIds.has(p.id) ? nextVisible[i++] : p));
    logDebug('pin', `reorderPins: ${next.map((p) => p.id).join(',')}`);
    updateProjectPins(activeProjectId, next);
  }

  // Anchors bookmarked per tab (model: web.BookmarkMessage) so panels can
  // render ★ on the right messages. Recomputed only when pins / tabs change.
  const bookmarkedByTab = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const t of tabs) {
      if ((t.type !== 'session' && t.type !== 'devin') || !t.resumeId) continue;
      const set = new Set<string>();
      for (const p of pins) {
        if (p.kind === 'bookmark' && p.sessionKind === t.type && p.sessionId === t.resumeId) set.add(p.anchor);
      }
      if (set.size) map.set(t.id, set);
    }
    return map;
  }, [tabs, pins]);
  const EMPTY_ANCHORS: ReadonlySet<string> = useMemo(() => new Set(), []);

  // ☆ on a message is a toggle. The panel supplies its stable anchor + label;
  // the tab tells us which session. Returns a status for the panel to toast.
  function toggleBookmark(tab: Tab, anchor: string, label: string): string | null {
    if (!activeProjectId) return null;
    if (tab.type !== 'session' && tab.type !== 'devin') return null;
    if (!tab.resumeId) return 'Session not ready yet — try again in a moment';
    const current = workspaceRef.current.projects[activeProjectId]?.pins ?? [];
    const existing = current.find(
      (p) => p.kind === 'bookmark' && p.sessionKind === tab.type && p.sessionId === tab.resumeId && p.anchor === anchor,
    );
    if (existing) {
      logDebug('pin', `toggleBookmark: remove ${existing.id} (${anchor})`);
      updateProjectPins(activeProjectId, current.filter((p) => p.id !== existing.id));
      return 'Bookmark removed';
    }
    const pin: Pin = {
      id: randomId(),
      kind: 'bookmark',
      text: label || `${tab.type === 'devin' ? 'Devin' : 'Claude'} · ${tab.resumeId.slice(0, 8)}`,
      createdAt: Date.now(),
      sessionKind: tab.type,
      sessionId: tab.resumeId,
      anchor,
    };
    logDebug('pin', `toggleBookmark: add ${pin.id} → ${tab.type} ${tab.resumeId} ${anchor}`);
    updateProjectPins(activeProjectId, [...current, pin]);
    // A collapsed Pinboard would hide the new row — open it so the user sees
    // where the bookmark went (model: web.TogglePinboard).
    setPinCollapsed(false);
    return 'Bookmarked';
  }

  // Clicking a Pin row. Bookmarks scroll to their message; notes just bring
  // back the tab they were written in (model: web.PinList / OpenTab).
  function jumpToPin(pin: Pin) {
    if (pin.kind === 'bookmark') { jumpToBookmark(pin); return; }
    const origin = pin.tab;
    if (!origin || !activeProjectId) return;
    setPinDrawerOpen(false);
    logDebug('pin', `jumpToPin: note ${pin.id} → tab ${origin.type}:${origin.key}`);
    if (origin.type === 'file') openFileTab(origin.key);
    else if (origin.type === 'session') openSessionTab(origin.key, pin.text.slice(0, 30));
    else if (origin.type === 'devin') openDevinTab(origin.key, pin.text.slice(0, 30));
    else {
      const existing = tabs.find((t) => t.type === origin.type);
      if (existing) setActiveTab(activeProjectId, existing.id);
      else openTabOfKind(origin.type);
    }
  }

  // Activate (or resume into a fresh tab) the bookmarked session, then ask
  // its panel to scroll to the anchor once it's registered a locator.
  function jumpToBookmark(pin: Pin) {
    if (pin.kind !== 'bookmark' || !activeProjectId) return;
    setPinDrawerOpen(false);
    const existing = tabs.find((t) => t.type === pin.sessionKind && t.resumeId === pin.sessionId);
    let tabId: string | undefined;
    if (existing) {
      setActiveTab(activeProjectId, existing.id);
      tabId = existing.id;
    } else {
      tabId = pin.sessionKind === 'devin'
        ? openDevinTab(pin.sessionId, pin.text.slice(0, 30))
        : openSessionTab(pin.sessionId, pin.text.slice(0, 30));
    }
    if (!tabId) return;
    logDebug('pin', `jumpToBookmark: ${pin.id} → tab ${tabId}${existing ? '' : ' (resumed)'} anchor ${pin.anchor}`);
    pendingRevealRef.current = { tabId, anchor: pin.anchor };
    // Panel already mounted → reveal now (it waits internally until the tab
    // is actually displayed). Otherwise registerLocator fires it on mount.
    fireReveal(tabId, pin.anchor);
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
        return { ...ws, projects: { ...ws.projects, [p.id]: { tabs: [], groups: [], pins: [] } } };
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

  // Model: web.PinList — the whole Pinboard is opt-in (settings.pinboard).
  const pinboardOn = settings.pinboard ?? false;

  return (
    <div
      className={`app${pinboardOn ? '' : ' no-pinboard'}`}
      style={{
        ...(sidebarWidth != null ? { '--sidebar-width': `${sidebarWidth}px` } : {}),
        ...(pinCollapsed
          ? { '--pin-width': `${PIN_COLLAPSED_WIDTH}px` }
          : pinWidth != null ? { '--pin-width': `${pinWidth}px` } : {}),
      } as React.CSSProperties}
    >
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
      {pinboardOn && pinDrawerOpen && <div className="pin-drawer-backdrop" onClick={() => setPinDrawerOpen(false)} />}

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
              projects={projects}
              activeId={activeProjectId}
              onSelect={setActiveProject}
              onAdd={handleAddProject}
              onDelete={handleDeleteProject}
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
          onMenuClick={() => { setPinDrawerOpen(false); setDrawerOpen((v) => !v); }}
          onPinsClick={pinboardOn ? () => { setDrawerOpen(false); setPinDrawerOpen((v) => !v); } : undefined}
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
                  toggleBookmark: (anchor, label) => toggleBookmark(tab, anchor, label),
                  bookmarkedAnchors: bookmarkedByTab.get(tab.id) ?? EMPTY_ANCHORS,
                  registerLocator: (api) => registerLocator(tab.id, api),
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

      {pinboardOn && (
      <div className={`pin-drawer ${pinDrawerOpen ? 'open' : ''}`}>
        <div className={`panel pin-panel ${pinCollapsed ? 'collapsed' : ''}`}>
          <div
            className="pin-resize"
            title="Drag to resize; double-click to reset"
            onPointerDown={onPinResizeDown}
            onPointerMove={onPinResizeMove}
            onPointerUp={onPinResizeUp}
            onPointerCancel={onPinResizeUp}
            onDoubleClick={() => setPinWidth(null)}
          />
          <div className="panel-header">
            {!pinCollapsed && <span>Pinboard</span>}
            {!pinCollapsed && (
              <div className="pin-filter" role="tablist" aria-label="Pinboard filter">
                <button
                  className={pinFilter === 'all' ? 'active' : ''}
                  onClick={() => setPinFilter('all')}
                  role="tab"
                  aria-selected={pinFilter === 'all'}
                >All</button>
                <button
                  className={pinFilter === 'tab' ? 'active' : ''}
                  onClick={() => setPinFilter('tab')}
                  role="tab"
                  aria-selected={pinFilter === 'tab'}
                  title="Only bookmarks into the active session tab"
                >This tab</button>
              </div>
            )}
            <button
              className="pin-collapse"
              onClick={() => setPinCollapsed((v) => !v)}
              title={pinCollapsed ? 'Expand Pinboard' : 'Collapse Pinboard'}
              aria-label={pinCollapsed ? 'Expand Pinboard' : 'Collapse Pinboard'}
            >{pinCollapsed ? '«' : '»'}</button>
            <button className="pin-panel-close" onClick={() => setPinDrawerOpen(false)} aria-label="Close">×</button>
          </div>
          <div className="panel-body">
            {activeProject ? (
              <PinList
                pins={visiblePins}
                emptyText={
                  pinFilter === 'tab'
                    ? activeRef
                      ? 'Nothing pinned for this tab yet — add a note, or ☆ a message'
                      : 'Open a tab to see its pins'
                    : undefined
                }
                onAddNote={addNote}
                onEditPin={editPin}
                onDeletePin={deletePin}
                onReorderPins={reorderPins}
                onJump={jumpToPin}
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

