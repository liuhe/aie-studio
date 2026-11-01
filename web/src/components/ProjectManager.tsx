import { useEffect, useState } from 'react';
import type { Project } from '../types';

// Model: web.ProjectManager — the one place projects are added, archived,
// reordered and removed. Opened from the ProjectPicker menu ("⚙ Manage projects…"); the
// picker itself only selects. Lists every project, archived ones last and
// dimmed; archived projects are hidden from the picker but keep all data
// (model: entity Project.archived / web.ArchiveProject).
export function ProjectManager({ projects, activeId, onAdd, onArchive, onReorder, onDelete, onClose }: {
  projects: Project[];
  activeId: string | null;
  onAdd: (path: string, name?: string) => Promise<void>;
  onArchive: (id: string, archived: boolean) => Promise<void>;
  // Full new order (live section first, then archived) — model: web.ReorderProjects.
  onReorder: (ids: string[]) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [busy, setBusy] = useState(false);
  // HTML5 drag state (desktop). `over` + `after` = where the insertion line is.
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const live = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  async function submitAdd() {
    const path = pathInput.trim();
    if (!path || busy) return;
    setBusy(true);
    try {
      await onAdd(path, nameInput.trim() || undefined);
      setPathInput('');
      setNameInput('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  // Model: web.ReorderProjects — moves stay inside their section; the order
  // sent to the server is live + archived so archived rows keep trailing.
  function commitOrder(nextLive: Project[], nextArchived: Project[]) {
    return onReorder([...nextLive, ...nextArchived].map((p) => p.id));
  }
  function moveBy(p: Project, delta: number) {
    const list = p.archived ? archived : live;
    const i = list.indexOf(p);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    next.splice(i, 1);
    next.splice(j, 0, p);
    void run(() => (p.archived ? commitOrder(live, next) : commitOrder(next, archived)));
  }
  function dropOn(target: Project, after: boolean) {
    const src = drag ? projects.find((p) => p.id === drag.id) : undefined;
    if (!src || src.id === target.id || !!src.archived !== !!target.archived) return;
    const list = (src.archived ? archived : live).filter((p) => p.id !== src.id);
    let idx = list.findIndex((p) => p.id === target.id);
    if (idx < 0) return;
    if (after) idx++;
    list.splice(idx, 0, src);
    void run(() => (src.archived ? commitOrder(live, list) : commitOrder(list, archived)));
  }

  function row(p: Project) {
    const isActive = p.id === activeId;
    const list = p.archived ? archived : live;
    const idx = list.indexOf(p);
    const dropCls = drag?.over === p.id ? (drag.after ? ' drop-after' : ' drop-before') : '';
    const sameSection = drag ? !!projects.find((x) => x.id === drag.id)?.archived === !!p.archived : false;
    return (
      <div
        key={p.id}
        className={`pm-row${p.archived ? ' archived' : ''}${drag?.id === p.id ? ' dragging' : ''}${dropCls}`}
        title={p.path}
        draggable={!busy}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id);
          setDrag({ id: p.id, over: null, after: false });
        }}
        onDragOver={(e) => {
          if (!drag || drag.id === p.id || !sameSection) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const r = e.currentTarget.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          setDrag((d) => (d && (d.over !== p.id || d.after !== after) ? { ...d, over: p.id, after } : d));
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (drag && drag.over === p.id) dropOn(p, drag.after);
          setDrag(null);
        }}
        onDragEnd={() => setDrag(null)}
      >
        <span className="pm-handle" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
        <div className="pm-row-main">
          <div className="pm-row-name">
            {isActive && <span className="pm-active-dot" title="Current project">●</span>}
            <span>{p.name}</span>
            {p.archived && <span className="pm-badge">Archived</span>}
          </div>
          <div className="pm-row-path">{p.path}</div>
        </div>
        <div className="pm-row-actions">
          <button type="button" className="pm-btn icon" disabled={busy || idx <= 0} onClick={() => moveBy(p, -1)} title="Move up" aria-label="Move up">▲</button>
          <button type="button" className="pm-btn icon" disabled={busy || idx >= list.length - 1} onClick={() => moveBy(p, 1)} title="Move down" aria-label="Move down">▼</button>
          <button
            type="button"
            className="pm-btn"
            disabled={busy}
            onClick={() => run(() => onArchive(p.id, !p.archived))}
            title={p.archived ? 'Show this project in the picker again' : 'Hide from the picker; nothing is deleted'}
          >{p.archived ? 'Unarchive' : 'Archive'}</button>
          <button
            type="button"
            className="pm-btn danger"
            disabled={busy}
            onClick={() => run(() => onDelete(p.id))}
            title="Remove from the list (files are not touched)"
          >Remove</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal pm-modal" role="dialog" aria-label="Projects" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Projects</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="pm-body">
          {adding ? (
            <div className="pm-add">
              <input
                autoFocus
                placeholder="/absolute/path or ~/path"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAdd();
                  if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); }
                }}
              />
              <input
                placeholder="Display name (optional)"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitAdd();
                  if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); }
                }}
              />
              <div className="pm-add-buttons">
                <button type="button" className="pm-btn primary" disabled={busy || !pathInput.trim()} onClick={() => void submitAdd()}>Add</button>
                <button type="button" className="pm-btn" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="pm-add-action" onClick={() => setAdding(true)}>+ Add project</button>
          )}
          {projects.length === 0 && <div className="pm-empty">No projects yet — add a directory above.</div>}
          {live.map(row)}
          {archived.length > 0 && live.length > 0 && <div className="pm-divider" />}
          {archived.map(row)}
        </div>
      </div>
    </div>
  );
}
