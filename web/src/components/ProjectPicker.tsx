import { useEffect, useRef, useState } from 'react';
import type { Project } from '../types';

export function ProjectPicker({
  projects,
  activeId,
  onSelect,
  onAdd,
  onDelete,
  onOpenSettings,
  onOpenDevinUsage,
  onOpenDebug,
  downloadMode,
  onToggleDownloadMode,
  sidebarView,
  onToggleSidebarView,
}: {
  projects: Project[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: (path: string, name?: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings?: () => void;
  onOpenDevinUsage?: () => void;
  onOpenDebug?: () => void;
  downloadMode?: boolean;
  onToggleDownloadMode?: () => void;
  sidebarView?: 'files' | 'groups';
  onToggleSidebarView?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const [adding, setAdding] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = projects.find((p) => p.id === activeId) ?? null;

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 2, left: r.left, width: Math.max(220, r.width) });
    }
    setOpen((v) => !v);
    setAdding(false);
  }

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  function submitAdd() {
    if (!pathInput.trim()) return;
    onAdd(pathInput.trim(), nameInput.trim() || undefined);
    setPathInput('');
    setNameInput('');
    setAdding(false);
    setOpen(false);
  }

  return (
    <>
      <button ref={btnRef} className="project-picker-btn" onClick={toggle} title={active?.path}>
        <span className="project-picker-name">{active ? active.name : 'Select project'}</span>
        <span className="project-picker-chevron">▾</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          className="project-picker-menu"
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {onToggleSidebarView && (
            <div
              className="picker-add-action"
              role="menuitem"
              onClick={() => { setOpen(false); onToggleSidebarView(); }}
            >{sidebarView === 'groups' ? '📁 Show files' : '🗂 Show groups'}</div>
          )}
          {onToggleDownloadMode && (
            <div
              className="picker-toggle"
              role="menuitemcheckbox"
              aria-checked={!!downloadMode}
              onClick={onToggleDownloadMode}
            >
              <span className="picker-toggle-box">{downloadMode ? '☑' : '☐'}</span>
              <span>Click file to download</span>
            </div>
          )}
          {(onToggleSidebarView || onToggleDownloadMode) && <div className="picker-divider" />}
          {onOpenDevinUsage && (
            <div
              className="picker-add-action"
              role="menuitem"
              onClick={() => { setOpen(false); onOpenDevinUsage(); }}
            >📊 Devin usage</div>
          )}
          {onOpenSettings && (
            <div
              className="picker-add-action"
              onClick={() => { setOpen(false); onOpenSettings(); }}
            >⚙ Settings</div>
          )}
          {(onOpenDevinUsage || onOpenSettings) && <div className="picker-divider" />}
          {projects.map((p) => (
            <div
              key={p.id}
              className={`picker-item ${p.id === activeId ? 'active' : ''}`}
              onClick={() => { onSelect(p.id); setOpen(false); }}
              title={p.path}
            >
              <span className="picker-item-name">{p.name}</span>
              <button
                className="picker-item-del"
                onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                title="Remove"
              >×</button>
            </div>
          ))}
          {projects.length > 0 && <div className="picker-divider" />}
          {adding ? (
            <div className="picker-add">
              <input
                autoFocus
                placeholder="/absolute/path"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') setAdding(false); }}
              />
              <input
                placeholder="Display name (optional)"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
              />
              <div className="picker-add-buttons">
                <button onClick={submitAdd}>Add</button>
                <button onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="picker-add-action" onClick={() => setAdding(true)}>+ Add project</div>
          )}
          {onOpenDebug && (
            <>
              <div className="picker-divider" />
              <div
                className="picker-add-action"
                onClick={() => { setOpen(false); onOpenDebug(); }}
              >🐞 Debug window</div>
            </>
          )}
        </div>
      )}
    </>
  );
}
