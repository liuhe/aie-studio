import type { ReactNode } from 'react';
import type { Project, Settings, Tab } from '../types';

export type ExportApi = { open: () => void; canExport: boolean };

// Model: web.RevealMessage — a session panel's imperative "scroll to this
// message anchor" hook. Resolves true once the message is on screen, false
// if it isn't in this session (even after paging back through history).
export type MessageLocator = { reveal: (anchor: string) => Promise<boolean> };

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
  // Model: web.BookmarkMessage. Called from a message's ☆ button with the
  // panel's stable anchor + a display label; App fills in sessionKind /
  // sessionId from the tab. ☆ is a toggle: an anchor that is already
  // bookmarked gets un-bookmarked. Returns a short status string for the
  // panel to toast, or null when nothing needs saying.
  toggleBookmark: (anchor: string, label: string) => string | null;
  // Anchors in this tab's session that currently have a bookmark, so the
  // panel can render them as ★ + outlined.
  bookmarkedAnchors: ReadonlySet<string>;
  // Model: web.RevealMessage. Register on mount / null on unmount so
  // JumpToBookmark can ask this tab to scroll to an anchor.
  registerLocator: (api: MessageLocator | null) => void;
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
