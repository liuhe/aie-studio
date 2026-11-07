import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listDir, makeDir, moveEntry, type FsEntry } from '../api';
import { joinPath, parentPath, rewriteMovedPath } from '../lib/movedPath';
import { isTextFile } from '../lib/textFiles';

// Model: web.FileTree (auc-009). Lazy tree over server.ListDir; the per-row
// ⋯ menu offers Download (files), Rename and Move to… — the latter two both
// land on server.MoveEntry.

type Entry = FsEntry;

const POLL_INTERVAL_MS = 3000;
// Use a sentinel for the project root so it slots into the same Set / Map as
// nested directories — keeps the polling loop uniform.
const ROOT_KEY = '';

// rule-076 — "Download" hits ReadFile via a same-origin <a download>; no Tab
// is opened and the drawer stays put.
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

function entriesEqual(a: Entry[] | undefined, b: Entry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].isDir !== b[i].isDir) return false;
  }
  return true;
}

type Rename = { path: string; value: string };

function Node({
  entry,
  depth,
  expanded,
  childrenByPath,
  onToggle,
  onMenu,
  selectedPath,
  rename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: {
  entry: Entry;
  depth: number;
  expanded: Set<string>;
  childrenByPath: Map<string, Entry[]>;
  onToggle: (entry: Entry) => void;
  onMenu: (e: React.MouseEvent, entry: Entry) => void;
  selectedPath: string | null;
  rename: Rename | null;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const open = expanded.has(entry.path);
  const kids = open ? childrenByPath.get(entry.path) : undefined;
  const selected = selectedPath === entry.path;
  const renaming = rename?.path === entry.path;
  return (
    <>
      <div
        className={`tree-item ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => { if (!renaming) onToggle(entry); }}
      >
        <span className="tree-toggle">{entry.isDir ? (open ? '▾' : '▸') : ' '}</span>
        <span className="tree-icon">{entry.isDir ? '📁' : '📄'}</span>
        {renaming ? (
          // rule-411 — inline rename; Enter commits, Esc / blur cancels.
          <input
            autoFocus
            className="tree-rename"
            value={rename!.value}
            onChange={(e) => onRenameChange(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={onRenameCancel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); }
              if (e.key === 'Escape') { e.preventDefault(); onRenameCancel(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{entry.name}</span>
        )}
        {!renaming && (
          <button
            className="tree-menu-btn"
            onClick={(e) => onMenu(e, entry)}
            title={entry.isDir ? 'Folder menu' : 'File menu'}
            aria-label={entry.isDir ? 'Folder menu' : 'File menu'}
          >⋯</button>
        )}
      </div>
      {open && kids && (
        <div className="tree-children">
          {kids.map((c) => (
            <Node
              key={c.path}
              entry={c}
              depth={depth + 1}
              expanded={expanded}
              childrenByPath={childrenByPath}
              onToggle={onToggle}
              onMenu={onMenu}
              selectedPath={selectedPath}
              rename={rename}
              onRenameChange={onRenameChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
            />
          ))}
        </div>
      )}
    </>
  );
}

// rule-412 — "Move to…" destination chooser: a dirs-only lazy tree with the
// project root pinned on top. The entry being moved (and, for a directory,
// everything under it) is shown but not selectable. "+ New folder" creates a
// directory under the selected one in place (server.MakeDir).
function DirPicker({
  projectId,
  entry,
  onPick,
  onClose,
  onNotice,
}: {
  projectId: string;
  entry: Entry;
  onPick: (destDir: string) => void;
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const currentParent = parentPath(entry.path);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Pre-open the chain down to the entry's current parent so the user
    // starts where the entry lives.
    const s = new Set<string>([ROOT_KEY]);
    let p = currentParent;
    while (p) { s.add(p); p = parentPath(p); }
    return s;
  });
  const [dirs, setDirs] = useState<Map<string, Entry[]>>(new Map());
  const [selected, setSelected] = useState<string>(currentParent);
  // Inline "new folder" input under `selected`; null = not editing.
  const [newFolder, setNewFolder] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    try {
      const items = await listDir(projectId, path);
      setDirs((prev) => {
        const next = new Map(prev);
        next.set(path, items.filter((i) => i.isDir));
        return next;
      });
    } catch {
      // leave the node childless; the user can retry by toggling
    }
  }, [projectId]);

  useEffect(() => {
    for (const p of expanded) if (!dirs.has(p)) load(p);
  }, [expanded, load]);

  const isBlocked = (dir: string) =>
    entry.isDir && (dir === entry.path || dir.startsWith(entry.path + '/'));

  function toggle(dir: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir); else next.add(dir);
      return next;
    });
  }

  function startNewFolder() {
    setExpanded((prev) => new Set(prev).add(selected));
    setNewFolder('');
  }

  async function commitNewFolder() {
    if (newFolder === null) return;
    const name = newFolder.trim();
    const parent = selected;
    setNewFolder(null);
    if (!name) return;
    if (name.includes('/')) {
      onNotice?.('Name cannot contain "/"');
      return;
    }
    try {
      const res = await makeDir(projectId, joinPath(parent, name));
      await load(parent);
      setExpanded((prev) => new Set(prev).add(parent));
      setSelected(res.path);
    } catch (e) {
      onNotice?.(`New folder failed: ${(e as Error).message}`);
    }
  }

  function renderDir(dir: string, name: string, depth: number) {
    const open = expanded.has(dir);
    const kids = dirs.get(dir);
    const blocked = isBlocked(dir);
    const hasKids = kids === undefined || kids.length > 0;
    return (
      <div key={dir || '/'}>
        <div
          className={`dirpicker-row ${selected === dir ? 'selected' : ''} ${blocked ? 'disabled' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            if (blocked) return;
            setSelected(dir);
            if (!open) toggle(dir);
          }}
        >
          <span
            className="tree-toggle"
            onClick={(e) => { e.stopPropagation(); if (!blocked) toggle(dir); }}
          >{hasKids ? (open ? '▾' : '▸') : ' '}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{name}</span>
        </div>
        {open && !blocked && newFolder !== null && selected === dir && (
          <div className="dirpicker-row" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
            <span className="tree-toggle"> </span>
            <span className="tree-icon">📁</span>
            <input
              autoFocus
              className="tree-rename"
              placeholder="New folder name"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onBlur={() => setNewFolder(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void commitNewFolder(); }
                if (e.key === 'Escape') { e.preventDefault(); setNewFolder(null); }
              }}
            />
          </div>
        )}
        {open && !blocked && kids && kids.map((k) => renderDir(k.path, k.name, depth + 1))}
      </div>
    );
  }

  const unchanged = selected === currentParent;
  // Portal: the mobile sidebar drawer is transformed, which would otherwise
  // make it the containing block for this fixed backdrop.
  return createPortal(
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-modal dirpicker-modal"
        role="dialog"
        aria-label="Move to"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span>Move “{entry.name}” to…</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="dirpicker-body">
          {renderDir(ROOT_KEY, '/ (project root)', 0)}
        </div>
        <div className="dirpicker-footer">
          <button
            className="dirpicker-newfolder"
            disabled={newFolder !== null || isBlocked(selected)}
            onClick={startNewFolder}
          >+ New folder</button>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={unchanged || isBlocked(selected)}
            onClick={() => onPick(selected)}
          >Move here</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function FileTree({
  projectId,
  onSelect,
  selectedPath,
  onEntryMoved,
  onNotice,
  onEdit,
}: {
  projectId: string;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  // web.EditorPanel entry — "✎ Edit" on text files.
  onEdit?: (path: string) => void;
  // rule-413 — fired after a successful rename / move so the App can rewrite
  // open file Tabs.
  onEntryMoved?: (from: string, to: string) => void;
  onNotice?: (text: string) => void;
}) {
  // Which dirs are visually expanded. Survives polling refreshes because it
  // lives at the top level — Node only reads it. Closing a dir removes it
  // from the set; deletion-from-disk doesn't (next render just won't reach it
  // because the parent's child list no longer contains it).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Cached directory listings. Replaced wholesale per-dir on refresh but only
  // when the contents actually changed (entriesEqual short-circuit), keeping
  // React re-renders tight.
  const [childrenByPath, setChildrenByPath] = useState<Map<string, Entry[]>>(new Map());
  // Mirror of the latest expanded/cache so the polling effect can read them
  // without having `expanded` in its dep array (which would tear down/rebuild
  // the interval on every toggle).
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(childrenByPath);
  expandedRef.current = expanded;
  cacheRef.current = childrenByPath;
  // Per-row ⋯ overflow menu (one open at a time); closes on outside press.
  const [menu, setMenu] = useState<{ entry: Entry; top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [rename, setRename] = useState<Rename | null>(null);
  const [moving, setMoving] = useState<Entry | null>(null);

  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [menu]);

  const openMenu = useCallback((e: React.MouseEvent, entry: Entry) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      entry,
      top: r.bottom + 2,
      left: Math.max(4, Math.min(r.left, window.innerWidth - 244)),
    });
  }, []);

  const fetchDir = useCallback(async (path: string) => {
    try {
      const items = await listDir(projectId, path);
      setChildrenByPath((prev) => {
        if (entriesEqual(prev.get(path), items)) return prev;
        const next = new Map(prev);
        next.set(path, items);
        return next;
      });
    } catch {
      // network blips during polling are silently ignored — next tick retries
    }
  }, [projectId]);

  // Initial load when projectId changes. Drop caches so we don't show stale
  // entries from the previous project briefly while the new ones fetch.
  useEffect(() => {
    setExpanded(new Set());
    setChildrenByPath(new Map());
    setMenu(null);
    setRename(null);
    setMoving(null);
    fetchDir(ROOT_KEY);
  }, [projectId, fetchDir]);

  // Poll: every interval, re-fetch root + every currently-expanded dir.
  // Skipped while the tab is hidden so we don't spam the server in background
  // tabs.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      const paths = new Set<string>([ROOT_KEY, ...expandedRef.current]);
      await Promise.all([...paths].map((p) => fetchDir(p)));
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [fetchDir]);

  const handleToggle = useCallback((entry: Entry) => {
    if (!entry.isDir) {
      onSelect(entry.path);
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.path)) {
        next.delete(entry.path);
      } else {
        next.add(entry.path);
        if (!cacheRef.current.has(entry.path)) {
          // Fire off the first fetch immediately — async update lands when
          // the response arrives. Polling will keep it fresh thereafter.
          fetchDir(entry.path);
        }
      }
      return next;
    });
  }, [onSelect, fetchDir]);

  // rule-413 — shared tail of Rename and Move: call MoveEntry, refresh both
  // parents right away, carry expanded state along, and tell the App.
  const doMove = useCallback(async (from: string, to: string) => {
    if (from === to) return;
    try {
      const res = await moveEntry(projectId, from, to);
      setExpanded((prev) => {
        let changed = false;
        const next = new Set<string>();
        for (const p of prev) {
          const np = rewriteMovedPath(p, res.from, res.to);
          if (np === null) next.add(p); else { next.add(np); changed = true; }
        }
        return changed ? next : prev;
      });
      const refresh = new Set<string>([parentPath(res.from), parentPath(res.to)]);
      for (const p of expandedRef.current) {
        const np = rewriteMovedPath(p, res.from, res.to);
        if (np !== null) refresh.add(np);
      }
      await Promise.all([...refresh].map((p) => fetchDir(p)));
      onEntryMoved?.(res.from, res.to);
    } catch (e) {
      onNotice?.(`Move failed: ${(e as Error).message}`);
    }
  }, [projectId, fetchDir, onEntryMoved, onNotice]);

  // rule-411 — commit only when the name actually changed and is a plain
  // basename.
  const commitRename = useCallback(() => {
    if (!rename) return;
    const name = rename.value.trim();
    const oldName = rename.path.split('/').pop() ?? '';
    setRename(null);
    if (!name || name === oldName) return;
    if (name.includes('/')) {
      onNotice?.('Name cannot contain "/"');
      return;
    }
    void doMove(rename.path, joinPath(parentPath(rename.path), name));
  }, [rename, doMove, onNotice]);

  const rootItems = useMemo(() => childrenByPath.get(ROOT_KEY) ?? [], [childrenByPath]);

  return (
    <div className="tree">
      {rootItems.map((e) => (
        <Node
          key={e.path}
          entry={e}
          depth={0}
          expanded={expanded}
          childrenByPath={childrenByPath}
          onToggle={handleToggle}
          onMenu={openMenu}
          selectedPath={selectedPath}
          rename={rename}
          onRenameChange={(value) => setRename((r) => (r ? { ...r, value } : r))}
          onRenameCommit={commitRename}
          onRenameCancel={() => setRename(null)}
        />
      ))}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="tab-overflow-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          {!menu.entry.isDir && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); triggerDownload(projectId, menu.entry.path); }}
            >⬇ Download</button>
          )}
          {!menu.entry.isDir && onEdit && isTextFile(menu.entry.mime, menu.entry.name) && (
            <button
              className="overflow-action"
              onClick={() => { setMenu(null); onEdit(menu.entry.path); }}
            >✎ Edit</button>
          )}
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setRename({ path: menu.entry.path, value: menu.entry.name }); }}
          >✎ Rename</button>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setMoving(menu.entry); }}
          >📂 Move to…</button>
        </div>,
        document.body,
      )}
      {moving && (
        <DirPicker
          projectId={projectId}
          entry={moving}
          onClose={() => setMoving(null)}
          onNotice={onNotice}
          onPick={(destDir) => {
            const entry = moving;
            setMoving(null);
            void doMove(entry.path, joinPath(destDir, entry.name));
          }}
        />
      )}
    </div>
  );
}
