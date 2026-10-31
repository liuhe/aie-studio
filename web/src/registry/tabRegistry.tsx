import type { ReactNode } from 'react';
import type { Project, Settings, Tab } from '../types';
import type { NewComment } from '../components/CommentComposer';
import type { CommentMark } from '../lib/review';

export type ExportApi = { open: () => void; canExport: boolean };

// What a session panel exposes to App. reveal (model: web.RevealMessage):
// scroll to a message anchor — resolves true once it is on screen, false if
// it isn't in this session (even after paging back through history).
// insertPrompt (model: web.InsertBatchPrompt): put a composed Batch prompt in
// the input box without sending it.
import type { TabActivity } from '../lib/tabActivity';
export type { TabActivity };

export type SessionPanelApi = {
  reveal: (anchor: string) => Promise<boolean>;
  insertPrompt: (text: string, batchId: string) => void;
};

// Context passed to every tab renderer. New callbacks belong here (add once,
// all registered kinds can opt into using them).
export type TabRenderContext = {
  tab: Tab;
  project: Project;
  settings: Settings;
  updateTabs: (updater: (tabs: Tab[]) => Tab[]) => void;
  // Append a new tab to the current project and activate it. Panels that
  // want to launch e.g. a Claude session with an initialPrompt go through
  // this instead of hand-rolling updateTabs + activation.
  openTab: (tab: Tab) => void;
  updateSettings: (next: Settings) => void;
  registerExportApi: (api: ExportApi | null) => void;
  // Model: web.CommentOnSelection. The panel supplies
  // text + quote + its stable message anchor (if any); App fills in the tab
  // origin and files the comment into the current Batch. Returns a short
  // status string for the panel to toast, or null when nothing needs saying.
  addComment: (c: NewComment) => string | null;
  // Anchored comments in this tab's session (model: web.HighlightQuotes), so
  // the panel can outline those messages and paint the quotes.
  commentMarks: readonly CommentMark[];
  // Model: web.ViewQuoteComments. Bring this comment's row into view in the
  // Review panel (expanding the column / opening the mobile drawer).
  focusComment: (commentId: string) => void;
  // Model: web.InsertBatchPrompt. The panel reports that a prompt carrying
  // this Batch was actually sent.
  markBatchSent: (batchId: string) => void;
  // Register on mount / null on unmount so JumpToComment / SendBatch can
  // reach this tab's panel.
  registerPanelApi: (api: SessionPanelApi | null) => void;
  // Model: web.TabActivityMarkers. Session panels report whether they are
  // generating / waiting on the user; null on unmount. App turns this into
  // the TabBar / GroupList markers.
  reportActivity: (activity: TabActivity | null) => void;
};

// Kinds that opt into createAction get a "+ label" entry in the TabBar
// overflow menu. Kinds without it (session/devin/file — created via bespoke
// flows) stay hidden from the generic menu.
export type TabCreateAction = {
  label: string;
  create: (ctx: { project: { id: string; path: string } }) => Tab;
};

export type TabKind = {
  id: string;
  label: string;
  render: (ctx: TabRenderContext) => ReactNode;
  createAction?: TabCreateAction;
  // Model: TabKind.singleton. When true, at most one tab of this kind exists
  // per project: openTabOfKind activates the existing one instead of creating
  // another. For project-level views (e.g. aie-test) that have no per-tab state.
  singleton?: boolean;
};

const registry = new Map<string, TabKind>();

export function registerTabKind(k: TabKind) {
  registry.set(k.id, k);
}

export function getTabKind(id: string): TabKind | undefined {
  return registry.get(id);
}

export function listTabKinds(): TabKind[] {
  return [...registry.values()];
}
