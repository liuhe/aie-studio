import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tab } from '../types';
import { listTabKinds } from '../registry';

export function tabLabel(tab: Tab): string {
  if (tab.type === 'file') {
    const parts = tab.path.split('/');
    return parts[parts.length - 1] || tab.path;
  }
  if (tab.type === 'session' || tab.type === 'devin') {
    const idPart = tab.resumeId ? tab.resumeId.slice(0, 8) : '';
    const fallback = tab.type === 'devin' ? 'Devin session' : 'AI session';
    if (tab.title && idPart) return `${idPart} · ${tab.title}`;
    return tab.title || idPart || fallback;
  }
  // Registered tab kind — no baked-in title shape, look up label from registry.
  // (Read the id before narrowing: with only built-in kinds declared, TS
  // narrows `tab` to never here, but panels can widen TabKindMap at any time.)
  const kindId: string = (tab as Tab).type;
  return listTabKinds().find((k) => k.id === kindId)?.label ?? kindId;
}

// Vendored favicons (web/public/icons) for the two AI providers so the tab
// strip reads like a browser's: recognisable brand marks instead of emoji.
export function tabIcon(tab: Tab): ReactNode {
  if (tab.type === 'file') return '📄';
  if (tab.type === 'devin') return <img className="tab-icon-devin" src="/icons/devin.png" alt="" />;
  if (tab.type === 'session') return <img src="/icons/claude.png" alt="" />;
  return '🧩';
}

export function tabTitle(tab: Tab): string {
  if (tab.type === 'file') return tab.path;
  if (tab.type === 'devin') return 'Devin session';
  if (tab.type === 'session') return 'AI session';
  const kindId: string = (tab as Tab).type;
  return listTabKinds().find((k) => k.id === kindId)?.label ?? kindId;
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewSession,
  onResumeSession,
  onNewDevinSession,
  onResumeDevinSession,
  onOpenTabKind,
  onMenuClick,
  onPinsClick,
  onRefresh,
  onExport,
  canExport,
  activeProjectName,
  activeGroupName,
  moveTargets,
  onMoveTab,
}: {
  // Only the active Group's tabs — App filters before passing them in.
  tabs: Tab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession: () => void;
  onResumeSession?: () => void;
  onNewDevinSession?: () => void;
  onResumeDevinSession?: () => void;
  onOpenTabKind?: (kindId: string) => void;
  onMenuClick?: () => void;
  // Mobile only (CSS hides it on desktop): toggles the right-hand Pinboard
  // drawer, mirroring ☰ for the left drawer. Model: web.PinList.
  onPinsClick?: () => void;
  onRefresh?: () => void;
  onExport?: () => void;
  canExport?: boolean;
  activeProjectName?: string | null;
  activeGroupName?: string;
  // Other Groups the active tab can be moved to ("Move to …" overflow entries).
  moveTargets?: { id: string; name: string }[];
  onMoveTab?: (tabId: string, groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Drill-down level of the overflow menu; 'move' shows the Group list for
  // "Move tab to …" (model: web.MoveTabToGroup). Reset whenever the menu closes.
  const [submenu, setSubmenu] = useState<'move' | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function toggleMenu() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 2, right: Math.max(4, window.innerWidth - r.right) });
    }
    setOpen((v) => !v);
  }

  useEffect(() => {
    if (!open) { setSubmenu(null); return; }
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

  return (
    <div className="tab-bar">
      {onMenuClick && (
        <button
          className="tab-menu"
          onClick={onMenuClick}
          title={activeGroupName ? `${activeProjectName ?? ''} · ${activeGroupName}` : activeProjectName ?? 'Menu'}
        >☰</button>
      )}
      {(() => {
        const active = tabs.find((t) => t.id === activeTabId);
        return (
          <div className="tab-current">
            {!active && <span className="tab-current-empty">No tab</span>}
            {active && (
              <>
                <span className="tab-icon">{tabIcon(active)}</span>
                <span className="tab-current-label" title={tabTitle(active)}>
                  {tabLabel(active)}
                </span>
                <button
                  className="tab-close"
                  onClick={() => onClose(active.id)}
                  title="Close"
                >×</button>
              </>
            )}
          </div>
        );
      })()}
      <div className="tab-list">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'active' : ''} tab-${t.type}`}
            onClick={() => onActivate(t.id)}
            title={tabTitle(t)}
          >
            <span className="tab-icon">{tabIcon(t)}</span>
            <span className="tab-label">{tabLabel(t)}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
              title="Close"
            >×</button>
          </div>
        ))}
      </div>
      <div className="tab-overflow">
        <button ref={btnRef} className="tab-overflow-btn" onClick={toggleMenu} aria-label="Tab menu">⋮</button>
        {open && submenu === 'move' && activeTabId && onMoveTab && (
          <div
            ref={menuRef}
            className="tab-overflow-menu"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            <button
              className="overflow-action overflow-back"
              onClick={() => setSubmenu(null)}
            >‹ Back</button>
            <div className="overflow-heading">Move tab to</div>
            <div className="overflow-divider" />
            {(moveTargets ?? []).map((g) => (
              <button
                key={g.id}
                className="overflow-action"
                onClick={() => { setOpen(false); onMoveTab(activeTabId, g.id); }}
              >{g.name}</button>
            ))}
          </div>
        )}
        {open && submenu === null && (
          <div
            ref={menuRef}
            className="tab-overflow-menu"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            {onRefresh && activeTabId && (
              <button
                className="overflow-action"
                onClick={() => { setOpen(false); onRefresh(); }}
              >↻ Refresh tab</button>
            )}
            {onExport && activeTabId && (
              <button
                className="overflow-action"
                onClick={() => { setOpen(false); onExport(); }}
                disabled={!canExport}
              >⤓ Export session</button>
            )}
            {onMoveTab && activeTabId && (moveTargets ?? []).length > 0 && (
              <button
                className="overflow-action overflow-submenu"
                onClick={() => setSubmenu('move')}
              >→ Move tab to …<span className="overflow-chevron">›</span></button>
            )}
            {activeTabId && ((onRefresh || onExport) || (onMoveTab && (moveTargets ?? []).length > 0)) && (
              <div className="overflow-divider" />
            )}
            <button
              className="overflow-action"
              onClick={() => { setOpen(false); onNewSession(); }}
            >+ New Claude session</button>
            {onResumeSession && (
              <button
                className="overflow-action"
                onClick={() => { setOpen(false); onResumeSession(); }}
              >↻ Resume Claude session</button>
            )}
            {onNewDevinSession && (
              <button
                className="overflow-action"
                onClick={() => { setOpen(false); onNewDevinSession(); }}
              >+ New Devin session</button>
            )}
            {onResumeDevinSession && (
              <button
                className="overflow-action"
                onClick={() => { setOpen(false); onResumeDevinSession(); }}
              >↻ Resume Devin session</button>
            )}
            {onOpenTabKind && listTabKinds()
              .filter((k) => k.createAction)
              .map((k) => (
                <button
                  key={k.id}
                  className="overflow-action"
                  onClick={() => { setOpen(false); onOpenTabKind(k.id); }}
                >{k.createAction!.label}</button>
              ))}
            {tabs.length > 0 && <div className="overflow-divider" />}
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`overflow-tab ${t.id === activeTabId ? 'active' : ''}`}
                onClick={() => { setOpen(false); onActivate(t.id); }}
              >
                <span className="tab-icon">{tabIcon(t)}</span>
                <span className="overflow-tab-label">{tabLabel(t)}</span>
                <button
                  className="tab-close"
                  onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                  title="Close"
                >×</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {onPinsClick && (
        <button className="tab-pins" onClick={onPinsClick} title="Pinboard" aria-label="Pinboard">☆</button>
      )}
    </div>
  );
}
