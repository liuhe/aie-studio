export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: number;
};

// A user-created tab Group inside a project (cmux-style workspace). Every
// project also has an implicit default Group (DEFAULT_GROUP_ID) that is never
// stored in groups[], cannot be deleted/renamed, and is hidden while empty.
export type Group = { id: string; name: string };
export const DEFAULT_GROUP_ID = 'default';
export const DEFAULT_GROUP_NAME = 'Default';

// groupId: owning Group. Absent on legacy tabs = the default Group, so old
// workspace files need no migration.
export type FileTab = { id: string; type: 'file'; path: string; groupId?: string };
// initialPrompt: one-shot first message for a *new* session (used by other
// tab kinds' ▶ buttons). ChatPanel sends it once the session is ready and
// immediately strips it from the workspace, so a refresh never re-sends.
export type SessionTab = { id: string; type: 'session'; resumeId?: string; title?: string; initialPrompt?: string; groupId?: string };
export type DevinTab = { id: string; type: 'devin'; resumeId?: string; title?: string; groupId?: string };

// Extension point: panel modules can add entries to TabKindMap via TS
// declaration merging (`declare module '../types' { interface TabKindMap { ... } }`)
// to teach the type system about their tab shape without editing this file or
// App.tsx. The union is derived automatically.
export interface TabKindMap {
  file: FileTab;
  session: SessionTab;
  devin: DevinTab;
}
export type Tab = TabKindMap[keyof TabKindMap];

// Model: entity Pin — one row of the Pinboard (desktop right sidebar / mobile
// right drawer). `note` is free text the user typed; `bookmark` points at a
// message inside a session — at the session, not the tab, so it survives the
// tab being closed (jumping re-opens a resume tab). `anchor` is the panel's
// stable message key: Claude u:<uuid> / a:<uuid>:<blockIdx> / t:<toolUseId>,
// Devin n:<nodeId> / t:<toolCallId>. pins[] order is the display order.
// Which tab a Pin belongs to, for the "This tab" filter (model: Pin.tab /
// web.FilterPins). session/devin → resumeId, file → path, other kinds → type.
export type TabRef = { type: string; key: string };
export function tabRef(tab: Tab | null | undefined): TabRef | null {
  if (!tab) return null;
  if (tab.type === 'file') return { type: 'file', key: tab.path };
  if (tab.type === 'session' || tab.type === 'devin') return tab.resumeId ? { type: tab.type, key: tab.resumeId } : null;
  const type: string = (tab as Tab).type;
  return { type, key: type };
}
export function sameTabRef(a: TabRef | null | undefined, b: TabRef | null | undefined): boolean {
  return !!a && !!b && a.type === b.type && a.key === b.key;
}

// tab: the tab that was active when the note was written (absent if none).
export type NotePin = { id: string; kind: 'note'; text: string; createdAt: number; tab?: TabRef };
export type BookmarkPin = {
  id: string;
  kind: 'bookmark';
  text: string;
  createdAt: number;
  sessionKind: 'session' | 'devin';
  sessionId: string;
  anchor: string;
};
export type Pin = NotePin | BookmarkPin;
// A Pin's origin tab: bookmarks are anchored to their session, notes carry
// the tab they were written in.
export function pinTabRef(pin: Pin): TabRef | null {
  if (pin.kind === 'bookmark') return { type: pin.sessionKind, key: pin.sessionId };
  return pin.tab ?? null;
}

export type ProjectWorkspace = {
  tabs: Tab[];
  groups: Group[];
  pins: Pin[];
};

export function tabGroupId(tab: { groupId?: string }): string {
  return tab.groupId ?? DEFAULT_GROUP_ID;
}

export type Workspace = {
  projects: Record<string, ProjectWorkspace>;
};

export type ResumableSession = {
  uuid: string;
  mtime: number;
  size: number;
  preview: string;
};

export type ResumableDevinSession = {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
};

export type SendKey = 'enter' | 'cmd-enter' | 'shift-enter';
export type Theme = 'dark' | 'light' | 'dim';
export type FontScale = 'small' | 'normal' | 'large' | 'xlarge' | 'huge' | 'xhuge';
export type Settings = {
  sendKey: SendKey;
  theme: Theme;
  fontScale: FontScale;
  // claude CLI --model arg for new sessions. '' = no override.
  // Accepts aliases ('opus' | 'sonnet' | 'haiku') or full model IDs.
  model: string;
  // claude CLI --effort arg for new sessions. '' = claude's per-model default.
  effort?: string;
  // Devin (ACP) model id for new sessions. '' = let Devin pick its default.
  // Applied via session/set_config_option after session/new.
  devinModel?: string;
  // Devin (ACP) mode id for new sessions (bypass / accept-edits / ask / plan).
  // '' = Devin's default (Code = accept-edits). Applied via session/set_mode after session/new.
  devinMode?: string;
  // Whether to show stderr output in the UI. Hidden by default to reduce noise.
  showStderr?: boolean;
  // Desktop-only opt-in: 🍚 on assistant messages opens an editable rich-text
  // copy of the reply (model: web.RichCopyEditor). Off by default; never
  // rendered in the mobile layout.
  richCopy?: boolean;
  // Opt-in right-hand Pinboard (notes + message bookmarks; model: web.PinList).
  // Off by default: no third column / right drawer / ☆ on messages. Pins data
  // is kept while off.
  pinboard?: boolean;
};
