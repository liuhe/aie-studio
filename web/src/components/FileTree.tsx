import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Entry = { name: string; path: string; isDir: boolean };

const POLL_INTERVAL_MS = 3000;
// Use a sentinel for the project root so it slots into the same Set / Map as
// nested directories — keeps the polling loop uniform.
const ROOT_KEY = '';

function entriesEqual(a: Entry[] | undefined, b: Entry[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].isDir !== b[i].isDir) return false;
  }
  return true;
}

function Node({
  entry,
  depth,
  expanded,
  childrenByPath,
  onToggle,
  selectedPath,
}: {
  entry: Entry;
  depth: number;
  expanded: Set<string>;
  childrenByPath: Map<string, Entry[]>;
  onToggle: (entry: Entry) => void;
  selectedPath: string | null;
}) {
  const open = expanded.has(entry.path);
  const kids = open ? childrenByPath.get(entry.path) : undefined;
  const selected = selectedPath === entry.path;
  return (
    <>
      <div
        className={`tree-item ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onToggle(entry)}
      >
        <span className="tree-toggle">{entry.isDir ? (open ? '▾' : '▸') : ' '}</span>
        <span className="tree-icon">{entry.isDir ? '📁' : '📄'}</span>
        <span>{entry.name}</span>
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
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </>
  );
}

export function FileTree({
  projectId,
  onSelect,
  selectedPath,
}: {
  projectId: string;
  onSelect: (path: string) => void;
  selectedPath: string | null;
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

  const fetchDir = useCallback(async (path: string) => {
    try {
      const r = await fetch(
        `/api/fs/list?project=${projectId}&path=${encodeURIComponent(path)}`,
      );
      if (!r.ok) return;
      const j = await r.json();
      const items: Entry[] = j.items ?? [];
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
          selectedPath={selectedPath}
        />
      ))}
    </div>
  );
}
