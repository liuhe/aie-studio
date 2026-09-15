import { useEffect, useRef, useState } from 'react';
import type { Pin, TabRef } from '../types';

// Pinboard (model: web.PinList) — the right-hand sidebar on desktop, a
// right-side drawer on mobile. A vertical list of Pins in pins[] order:
// notes (free text) and bookmarks (a message inside a session). Rows
// drag-to-reorder (HTML5 DnD, same implementation as GroupList); the ⋯ menu
// offers Move up / Move down for touch, plus Edit / Delete. "+ New note" sits
// below the list so the newest entry (appended last) lands right above it.

type DropPos = 'before' | 'after';

function originLabel(ref: TabRef): string {
  if (ref.type === 'file') return ref.key.split('/').pop() || ref.key;
  if (ref.type === 'session') return `Claude ${ref.key.slice(0, 8)}`;
  if (ref.type === 'devin') return `Devin ${ref.key.slice(0, 8)}`;
  return ref.type;
}

function originIcon(ref: TabRef) {
  if (ref.type === 'session') return <img src="/icons/claude.png" alt="" />;
  if (ref.type === 'devin') return <img src="/icons/devin.png" alt="" />;
  return <span>{ref.type === 'file' ? '📄' : '🧩'}</span>;
}

export function PinList({
  pins,
  onAddNote,
  onEditPin,
  onDeletePin,
  onReorderPins,
  onJump,
  emptyText,
}: {
  // Already filtered by App (model: web.FilterPins); order = display order.
  pins: Pin[];
  emptyText?: string;
  onAddNote: (text: string) => void;
  onEditPin: (id: string, text: string) => void;
  onDeletePin: (id: string) => void;
  onReorderPins: (next: Pin[]) => void;
  onJump: (pin: Pin) => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; top: number; left: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPos } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  function openMenu(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ id, top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - 244)) });
  }

  function commitAdd() {
    const text = (adding ?? '').trim();
    setAdding(null);
    if (text) onAddNote(text);
  }

  function commitEdit() {
    if (!editing) return;
    const text = editing.value.trim();
    setEditing(null);
    if (text) onEditPin(editing.id, text);
  }

  // ⌘/Ctrl+Enter submits, Escape cancels; plain Enter inserts a newline so
  // multi-line notes are possible.
  function editorKeys(e: React.KeyboardEvent, commit: () => void, cancel: () => void) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  function move(id: string, delta: -1 | 1) {
    const idx = pins.findIndex((p) => p.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= pins.length) return;
    const next = pins.slice();
    [next[idx], next[to]] = [next[to], next[idx]];
    onReorderPins(next);
  }

  // --- drag-to-reorder (HTML5 DnD) ---
  function onDragOverRow(e: React.DragEvent, id: string) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos: DropPos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drop?.id !== id || drop.pos !== pos) setDrop({ id, pos });
  }

  function onDropRow(e: React.DragEvent, id: string) {
    e.preventDefault();
    const from = dragId;
    const target = drop?.id === id ? drop : null;
    setDragId(null);
    setDrop(null);
    if (!from || !target || from === id) return;
    const moved = pins.find((p) => p.id === from);
    if (!moved) return;
    const without = pins.filter((p) => p.id !== from);
    let idx = without.findIndex((p) => p.id === id);
    if (idx < 0) return;
    if (target.pos === 'after') idx += 1;
    const next = [...without.slice(0, idx), moved, ...without.slice(idx)];
    if (next.every((p, i) => p.id === pins[i]?.id)) return;
    onReorderPins(next);
  }

  function endDrag() {
    setDragId(null);
    setDrop(null);
  }

  const menuPin = menu ? pins.find((p) => p.id === menu.id) : undefined;
  const menuIdx = menuPin ? pins.indexOf(menuPin) : -1;

  return (
    <div className="pin-list">
      {pins.map((pin) => {
        const isEditing = editing?.id === pin.id;
        const dropCls = drop?.id === pin.id ? `drop-${drop.pos}` : '';
        const dragCls = dragId === pin.id ? 'dragging' : '';
        const isBookmark = pin.kind === 'bookmark';
        // Notes remember the tab they were written in; clicking brings it back.
        const origin = pin.kind === 'note' ? pin.tab : undefined;
        const clickable = isBookmark || !!origin;
        return (
          <div
            key={pin.id}
            className={`pin pin-${pin.kind} ${dragCls} ${dropCls}`}
            draggable={!isEditing}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', pin.id);
              setDragId(pin.id);
            }}
            onDragOver={(e) => onDragOverRow(e, pin.id)}
            onDragLeave={() => { if (drop?.id === pin.id) setDrop(null); }}
            onDrop={(e) => onDropRow(e, pin.id)}
            onDragEnd={endDrag}
          >
            <div
              className={`pin-row ${clickable ? 'pin-row-link' : ''}`}
              onClick={() => { if (clickable && !isEditing) onJump(pin); }}
              onDoubleClick={() => setEditing({ id: pin.id, value: pin.text })}
              title={isBookmark
                ? `Jump to this message (${pin.sessionKind === 'devin' ? 'Devin' : 'Claude'} ${pin.sessionId.slice(0, 8)})`
                : origin ? `Written in ${originLabel(origin)} — click to open that tab, double-click to edit` : 'Double-click to edit'}
            >
              <span className="pin-icon">
                {pin.kind === 'note'
                  ? '✎'
                  : <img src={pin.sessionKind === 'devin' ? '/icons/devin.png' : '/icons/claude.png'} alt="" />}
              </span>
              {isEditing ? (
                <textarea
                  autoFocus
                  className="pin-editor-input"
                  value={editing!.value}
                  rows={Math.max(2, Math.min(8, editing!.value.split('\n').length))}
                  onChange={(e) => setEditing({ id: pin.id, value: e.target.value })}
                  onBlur={commitEdit}
                  onKeyDown={(e) => editorKeys(e, commitEdit, () => setEditing(null))}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="pin-body">
                  <span className="pin-text">{pin.text}</span>
                  {origin && (
                    <span className="pin-origin">
                      {originIcon(origin)}
                      {originLabel(origin)}
                    </span>
                  )}
                </span>
              )}
              {!isEditing && (
                <button
                  className="pin-menu-btn"
                  onClick={(e) => openMenu(e, pin.id)}
                  title="Pin menu"
                  aria-label="Pin menu"
                >⋯</button>
              )}
            </div>
          </div>
        );
      })}
      {pins.length === 0 && adding === null && (
        <div className="empty">{emptyText ?? 'Nothing pinned yet — add a note, or ☆ a message in a session'}</div>
      )}
      {adding === null ? (
        <div className="pin-add" onClick={() => setAdding('')}>+ New note</div>
      ) : (
        <div className="pin-editor">
          <textarea
            autoFocus
            className="pin-editor-input"
            placeholder="Type a note… (⌘/Ctrl+Enter to save)"
            value={adding}
            rows={3}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => editorKeys(e, commitAdd, () => setAdding(null))}
          />
          <div className="pin-editor-actions">
            <button type="button" className="pin-editor-cancel" onClick={() => setAdding(null)}>Cancel</button>
            <button type="button" className="pin-editor-save" onClick={commitAdd} disabled={!adding.trim()}>Save</button>
          </div>
        </div>
      )}

      {menu && menuPin && (
        <div
          ref={menuRef}
          className="tab-overflow-menu"
          style={{ top: menu.top, left: menu.left }}
        >
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setEditing({ id: menuPin.id, value: menuPin.text }); }}
          >✎ Edit</button>
          <button
            className="overflow-action"
            disabled={menuIdx <= 0}
            onClick={() => { setMenu(null); move(menuPin.id, -1); }}
          >↑ Move up</button>
          <button
            className="overflow-action"
            disabled={menuIdx < 0 || menuIdx >= pins.length - 1}
            onClick={() => { setMenu(null); move(menuPin.id, 1); }}
          >↓ Move down</button>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); onDeletePin(menuPin.id); }}
          >🗑 Delete</button>
        </div>
      )}
    </div>
  );
}
