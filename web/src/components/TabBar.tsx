import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Tab } from '../types';
import { listTabKinds, type TabActivity } from '../registry';
import { activityMark } from '../lib/tabActivity';
import { TabActivityMark } from './TabActivityMark';

export function tabLabel(tab: Tab): string {
  if (tab.type === 'file' || tab.type === 'editor') {
    const parts = tab.path.split('/');
    return parts[parts.length - 1] || tab.path;
  }
  if (tab.type === 'session' || tab.type === 'devin' || tab.type === 'claude-sdk') {
    const idPart = tab.resumeId ? tab.resumeId.slice(0, 8) : '';
    const fallback = tab.type === 'devin' ? 'Devin session' : 'AI session';
    // Wire-capture mark comes from Tab.wire, not the title: titles persisted
    // before 2026-11-01 carried a trailing " ⚡" which is stripped here so the
    // mark shows once and survives renames.
    const title = tab.title?.replace(/\s*⚡$/, '');
    const base = title && idPart ? `${idPart} · ${title}` : title || idPart || fallback;
    return (tab.type === 'session' || tab.type === 'claude-sdk') && tab.wire ? `${base} ⚡` : base;
  }
  // Tabs persisted before 2026-11-01 carry a "👁 " prefix in the title; strip
  // it so the icon slot is the only eye.
  if (tab.type === 'observe') return (tab.title || tab.origin.key.slice(0, 8)).replace(/^👁\s*/, '');
  // Registered tab kind — no baked-in title shape, look up label from registry.
  // (Read the id before narrowing: with only built-in kinds declared, TS
  // narrows `tab` to never here, but panels can widen TabKindMap at any time.)
  const kindId: string = (tab as Tab).type;
  return listTabKinds().find((k) => k.id === kindId)?.label ?? kindId;
}

// Vendored favicons (web/public/icons) for the two AI providers so the tab
// strip reads like a browser's: recognisable brand marks instead of emoji.
// Shared by the tab strip and the ⋮ menu's New / Resume items (model:
// MainShell display mapping) so a session type always has one mark.
export function providerIcon(provider: 'session' | 'devin'): ReactNode {
  if (provider === 'devin') return <img className="tab-icon-devin" src="/icons/devin.png" alt="" />;
  return <img src="/icons/claude.png" alt="" />;
}

export function tabIcon(tab: Tab): ReactNode {
  if (tab.type === 'file') return '📄';
  if (tab.type === 'editor') return '✎';
  if (tab.type === 'devin' || tab.type === 'session') return providerIcon(tab.type);
  // Model: MainShell display mapping — Claude mark plus a small "sdk" tag so
  // the two Claude bridges are telling apart in the strip.
  if (tab.type === 'claude-sdk') return <>{providerIcon('session')}<span className="tab-sdk-mark">sdk</span></>;
  if (tab.type === 'observe') return '👁';
  return '🧩';
}

export function tabTitle(tab: Tab): string {
  if (tab.type === 'file') return tab.path;
  if (tab.type === 'editor') return `Edit ${tab.path}`;
  if (tab.type === 'devin') return 'Devin session';
  if (tab.type === 'session') return 'AI session';
  if (tab.type === 'claude-sdk') return 'Claude session (Agent SDK)';
  if (tab.type === 'observe') return `Observe ${tab.origin.type} ${tab.origin.key}`;
  const kindId: string = (tab as Tab).type;
  return listTabKinds().find((k) => k.id === kindId)?.label ?? kindId;
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onNewSession,
  onNewWireSession,
  onResumeSession,
  claudeBridge,
  onRenameSdkSession,
  onNewDevinSession,
  onResumeDevinSession,
  onOpenTabKind,
  onObserve,
  onMenuClick,
  onReviewClick,
  reviewCount,
  onRefresh,
  onExport,
  canExport,
  activeProjectName,
  activeGroupName,
  moveTargets,
  onMoveTab,
  activity,
}: {
  // Only the active Group's tabs — App filters before passing them in.
  tabs: Tab[];
  // Model: web.TabActivityMarkers — per-tab live state reported by mounted panels.
  activity?: Record<string, TabActivity>;
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  // Absent when the device has Claude disabled (Settings → Claude).
  onNewSession?: () => void;
  // Model: web.WireCaptureSession — a fresh Claude session whose API traffic
  // is recorded by the server's wire proxy.
  onNewWireSession?: () => void;
  onResumeSession?: () => void;
  // Which bridge the Claude items open (device-local pref; shown in their
  // tooltips). App wires onNewSession / onResumeSession accordingly.
  claudeBridge?: 'sdk' | 'cli';
  // Model: web.RenameSdkSession — only offered for the active claude-sdk tab
  // once it has a session id.
  onRenameSdkSession?: (tab: Tab) => void;
  onNewDevinSession?: () => void;
  onResumeDevinSession?: () => void;
  onOpenTabKind?: (kindId: string) => void;
  // Model: web.ObserveTab. Shown for session / devin tabs; enabled once the
  // session has a resumeId (Claude reads the transcript, Devin its sessions.db).
  onObserve?: (tab: Tab) => void;
  onMenuClick?: () => void;
  // Mobile only (CSS hides it on desktop): toggles the right-hand Review
  // drawer, mirroring ☰ for the left drawer. Model: web.ReviewPanel.
  onReviewClick?: () => void;
  // Draft comments waiting to be sent — shown as a badge on 💬.
  reviewCount?: number;
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
  const activeForMenu = tabs.find((t) => t.id === activeTabId);
  const observableKind = (t: Tab) => t.type === 'session' || t.type === 'claude-sdk' || t.type === 'devin';
  const observable = !!onObserve && !!activeForMenu && observableKind(activeForMenu);
  const observeEnabled = !!activeForMenu && observableKind(activeForMenu) && !!activeForMenu.resumeId;
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
                <TabActivityMark mark={activityMark(activity?.[active.id])} />
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
            <TabActivityMark mark={activityMark(activity?.[t.id])} />
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
            {observable && activeForMenu && (
              <button
                className="overflow-action"
                disabled={!observeEnabled}
                title={
                  !observeEnabled
                    ? 'The session has not started yet'
                    : 'Open a read-only observation of this session (turns, actions, tokens)'
                }
                onClick={() => { setOpen(false); onObserve!(activeForMenu); }}
              >👁 Observe this session</button>
            )}
            {onRenameSdkSession && activeForMenu?.type === 'claude-sdk' && (
              <button
                className="overflow-action"
                disabled={!activeForMenu.resumeId}
                title={activeForMenu.resumeId ? 'Give this session a persistent name (shown in the resume list too)' : 'The session has not started yet'}
                onClick={() => { setOpen(false); onRenameSdkSession(activeForMenu); }}
              >✎ Rename session</button>
            )}
            {onMoveTab && activeTabId && (moveTargets ?? []).length > 0 && (
              <button
                className="overflow-action overflow-submenu"
                onClick={() => setSubmenu('move')}
              >→ Move tab to …<span className="overflow-chevron">›</span></button>
            )}
            {activeTabId && ((onRefresh || onExport || observable || (onRenameSdkSession && activeForMenu?.type === 'claude-sdk')) || (onMoveTab && (moveTargets ?? []).length > 0)) && (
              <div className="overflow-divider" />
            )}
            {onNewSession && (
              <button
                className="overflow-action overflow-provider"
                title={claudeBridge === 'cli' ? 'Classic bridge (claude -p subprocess). Change in Settings → Claude bridge.' : 'Agent SDK bridge: AI-generated session titles, renamable. Change in Settings → Claude bridge.'}
                onClick={() => { setOpen(false); onNewSession(); }}
              ><span className="overflow-glyph">+</span><span className="tab-icon">{providerIcon('session')}</span>New Claude session</button>
            )}
            {onNewWireSession && (
              <button
                className="overflow-action overflow-provider"
                title="New Claude session whose API calls are routed through the local wire proxy. Every request and response (plaintext prompts included) is written under <project>/.aie/observations/wire/ for the observe tab. Applies only to sessions started from that tab."
                onClick={() => { setOpen(false); onNewWireSession(); }}
              ><span className="overflow-glyph">⚡</span><span className="tab-icon">{providerIcon('session')}</span>New Claude session (wire capture)</button>
            )}
            {onResumeSession && (
              <button
                className="overflow-action overflow-provider"
                title={claudeBridge === 'cli' ? 'Resume in a classic Claude tab' : 'Resume in an Agent SDK Claude tab'}
                onClick={() => { setOpen(false); onResumeSession(); }}
              ><span className="overflow-glyph">↻</span><span className="tab-icon">{providerIcon('session')}</span>Resume Claude session</button>
            )}
            {onNewDevinSession && (
              <button
                className="overflow-action overflow-provider"
                onClick={() => { setOpen(false); onNewDevinSession(); }}
              ><span className="overflow-glyph">+</span><span className="tab-icon">{providerIcon('devin')}</span>New Devin session</button>
            )}
            {onResumeDevinSession && (
              <button
                className="overflow-action overflow-provider"
                onClick={() => { setOpen(false); onResumeDevinSession(); }}
              ><span className="overflow-glyph">↻</span><span className="tab-icon">{providerIcon('devin')}</span>Resume Devin session</button>
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
      {onReviewClick && (
        <button className="tab-review" onClick={onReviewClick} title="Review" aria-label="Review">
          💬{!!reviewCount && <span className="tab-review-count">{reviewCount}</span>}
        </button>
      )}
    </div>
  );
}
