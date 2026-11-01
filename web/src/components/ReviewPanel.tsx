import { useEffect, useRef, useState } from 'react';
import type { Batch, Comment, TabRef } from '../types';
import { flashMessage } from './CommentComposer';

// Review (model: web.ReviewPanel) — the right-hand sidebar on desktop, a
// right-side drawer on mobile. Draft Batches on top, each with its Comments
// (quote + text) and a Send button; sent Batches fold away underneath.
// Comments drag (HTML5 DnD, same implementation as GroupList) within a batch
// to reorder and onto another draft batch to move; the ⋯ menu offers the same
// for touch.

type DropPos = 'before' | 'after';
type Drop = { kind: 'comment'; id: string; pos: DropPos } | { kind: 'batch'; id: string };
type Menu = { kind: 'comment' | 'batch'; id: string; top: number; left: number };

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

function sentLabel(ts: number | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ReviewPanel({
  batches,
  currentBatchId,
  focused,
  onAddComment,
  onEditComment,
  onDeleteComment,
  onPlaceComment,
  onMoveToNewBatch,
  onJump,
  onCreateBatch,
  onRenameBatch,
  onDeleteBatch,
  onSetCurrent,
  onSendBatch,
  onReopenBatch,
}: {
  batches: Batch[];
  // Resolved current batch (model: web.SetCurrentBatch); null = no draft yet.
  currentBatchId: string | null;
  // Model: web.ViewQuoteComments — scroll this comment into view and flash
  // it; `seq` makes focusing the same comment twice a new event.
  focused?: { id: string; seq: number } | null;
  onAddComment: (batchId: string, text: string) => void;
  onEditComment: (id: string, text: string) => void;
  onDeleteComment: (id: string) => void;
  // index counts positions after the comment is removed from its source;
  // omitted = append.
  onPlaceComment: (id: string, batchId: string, index?: number) => void;
  onMoveToNewBatch: (id: string) => void;
  onJump: (comment: Comment) => void;
  onCreateBatch: () => void;
  onRenameBatch: (id: string, name: string) => void;
  onDeleteBatch: (id: string) => void;
  onSetCurrent: (id: string) => void;
  onSendBatch: (id: string) => void;
  onReopenBatch: (id: string) => void;
}) {
  const [adding, setAdding] = useState<{ batchId: string; value: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [sentOpen, setSentOpen] = useState(false);
  const [expandedSent, setExpandedSent] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused) return;
    // A comment inside a sent batch is folded away twice — open both first.
    const owner = batches.find((b) => b.comments.some((c) => c.id === focused.id));
    if (owner?.status === 'sent') {
      setSentOpen(true);
      setExpandedSent((prev) => new Set(prev).add(owner.id));
    }
    const frame = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(focused.id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      flashMessage(el);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.id, focused?.seq]);

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

  const drafts = batches.filter((b) => b.status === 'draft');
  const sent = batches.filter((b) => b.status === 'sent').sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));

  function openMenu(e: React.MouseEvent, kind: Menu['kind'], id: string) {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ kind, id, top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - 244)) });
  }

  function commitAdd() {
    if (!adding) return;
    const text = adding.value.trim();
    setAdding(null);
    if (text) onAddComment(adding.batchId, text);
  }

  function commitEdit() {
    if (!editing) return;
    const text = editing.value.trim();
    setEditing(null);
    if (text) onEditComment(editing.id, text);
  }

  function commitRename() {
    if (!renaming) return;
    const name = renaming.value.trim();
    setRenaming(null);
    if (name) onRenameBatch(renaming.id, name);
  }

  // ⌘/Ctrl+Enter submits, Escape cancels; plain Enter inserts a newline so
  // multi-line comments are possible.
  function editorKeys(e: React.KeyboardEvent, commit: () => void, cancel: () => void) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  }

  // --- drag a comment: reorder within its batch / move to another draft ---
  function onDragOverComment(e: React.DragEvent, id: string) {
    if (!dragId || dragId === id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pos: DropPos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drop?.kind !== 'comment' || drop.id !== id || drop.pos !== pos) setDrop({ kind: 'comment', id, pos });
  }

  function onDropComment(e: React.DragEvent, batch: Batch, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const from = dragId;
    const target = drop?.kind === 'comment' && drop.id === id ? drop : null;
    endDrag();
    if (!from || !target || from === id) return;
    const without = batch.comments.filter((c) => c.id !== from);
    let idx = without.findIndex((c) => c.id === id);
    if (idx < 0) return;
    if (target.pos === 'after') idx += 1;
    onPlaceComment(from, batch.id, idx);
  }

  function onDragOverBatch(e: React.DragEvent, id: string) {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drop?.kind !== 'batch' || drop.id !== id) setDrop({ kind: 'batch', id });
  }

  function onDropBatch(e: React.DragEvent, id: string) {
    e.preventDefault();
    const from = dragId;
    endDrag();
    if (from) onPlaceComment(from, id);
  }

  function endDrag() {
    setDragId(null);
    setDrop(null);
  }

  function moveBy(batch: Batch, id: string, delta: -1 | 1) {
    const idx = batch.comments.findIndex((c) => c.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= batch.comments.length) return;
    onPlaceComment(id, batch.id, to);
  }

  function renderComment(batch: Batch, c: Comment) {
    const readOnly = batch.status === 'sent';
    const isEditing = editing?.id === c.id;
    const dropCls = drop?.kind === 'comment' && drop.id === c.id ? `drop-${drop.pos}` : '';
    const dragCls = dragId === c.id ? 'dragging' : '';
    return (
      <div
        key={c.id}
        data-comment-id={c.id}
        className={`review-comment ${dragCls} ${dropCls}`}
        draggable={!readOnly && !isEditing}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', c.id);
          setDragId(c.id);
        }}
        onDragOver={readOnly ? undefined : (e) => onDragOverComment(e, c.id)}
        onDragLeave={() => { if (drop?.kind === 'comment' && drop.id === c.id) setDrop(null); }}
        onDrop={readOnly ? undefined : (e) => onDropComment(e, batch, c.id)}
        onDragEnd={endDrag}
      >
        <div
          className={`review-comment-row ${c.tab ? 'review-comment-link' : ''}`}
          onClick={() => { if (c.tab && !isEditing) onJump(c); }}
          onDoubleClick={() => { if (!readOnly) setEditing({ id: c.id, value: c.text }); }}
          title={c.tab
            ? `${c.anchor ? 'Jump to this message' : 'Open'} (${originLabel(c.tab)})${readOnly ? '' : ' — double-click to edit'}`
            : readOnly ? undefined : 'Double-click to edit'}
        >
          <span className="review-comment-body">
            {c.quote && <span className="review-quote">{c.quote}</span>}
            {isEditing ? (
              <textarea
                autoFocus
                className="review-editor-input"
                value={editing!.value}
                rows={Math.max(2, Math.min(8, editing!.value.split('\n').length))}
                onChange={(e) => setEditing({ id: c.id, value: e.target.value })}
                onBlur={commitEdit}
                onKeyDown={(e) => editorKeys(e, commitEdit, () => setEditing(null))}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="review-text">{c.text}</span>
            )}
            {c.tab && !isEditing && (
              <span className="review-origin">
                {originIcon(c.tab)}
                {originLabel(c.tab)}
              </span>
            )}
          </span>
          {!isEditing && !readOnly && (
            <button
              className="review-menu-btn"
              onClick={(e) => openMenu(e, 'comment', c.id)}
              title="Comment menu"
              aria-label="Comment menu"
            >⋯</button>
          )}
        </div>
      </div>
    );
  }

  function renderBatchName(batch: Batch) {
    if (renaming?.id === batch.id) {
      return (
        <input
          autoFocus
          className="review-batch-rename"
          value={renaming.value}
          onChange={(e) => setRenaming({ id: batch.id, value: e.target.value })}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
            if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      );
    }
    return (
      <span
        className="review-batch-name"
        onDoubleClick={(e) => { e.stopPropagation(); setRenaming({ id: batch.id, value: batch.name }); }}
        title="Double-click to rename"
      >{batch.name}</span>
    );
  }

  const menuComment = menu?.kind === 'comment'
    ? drafts.flatMap((b) => b.comments.map((c) => ({ batch: b, comment: c }))).find((x) => x.comment.id === menu.id)
    : undefined;
  const menuBatch = menu?.kind === 'batch' ? batches.find((b) => b.id === menu.id) : undefined;
  const menuIdx = menuComment ? menuComment.batch.comments.indexOf(menuComment.comment) : -1;

  return (
    <div className="review-list" ref={listRef}>
      {batches.length === 0 && (
        <div className="empty">
          Select text in a session and hit 💬 Comment, or 💬 a whole message. Comments collect in a batch; send the batch to the AI when you're ready.
        </div>
      )}
      {drafts.map((batch) => {
        const isCurrent = batch.id === currentBatchId;
        const dropCls = drop?.kind === 'batch' && drop.id === batch.id ? 'drop-into' : '';
        return (
          <div key={batch.id} className={`review-batch ${isCurrent ? 'current' : ''}`}>
            <div
              className={`review-batch-header ${dropCls}`}
              onDragOver={(e) => onDragOverBatch(e, batch.id)}
              onDragLeave={() => { if (drop?.kind === 'batch' && drop.id === batch.id) setDrop(null); }}
              onDrop={(e) => onDropBatch(e, batch.id)}
            >
              <button
                className="review-batch-current"
                onClick={() => onSetCurrent(batch.id)}
                title={isCurrent ? 'Current batch — new comments go here' : 'Make this the current batch'}
                aria-label={isCurrent ? 'Current batch' : 'Make current batch'}
                aria-pressed={isCurrent}
              >{isCurrent ? '●' : '○'}</button>
              {renderBatchName(batch)}
              <span className="review-batch-count">{batch.comments.length}</span>
              <button
                className="review-batch-send"
                disabled={batch.comments.length === 0}
                onClick={() => onSendBatch(batch.id)}
                title="Fill this batch into the session's input box"
              >Send ▸</button>
              <button
                className="review-menu-btn"
                onClick={(e) => openMenu(e, 'batch', batch.id)}
                title="Batch menu"
                aria-label="Batch menu"
              >⋯</button>
            </div>
            {batch.comments.map((c) => renderComment(batch, c))}
            {adding?.batchId === batch.id ? (
              <div className="review-editor">
                <textarea
                  autoFocus
                  className="review-editor-input"
                  placeholder="Comment… (⌘/Ctrl+Enter to save)"
                  value={adding.value}
                  rows={3}
                  onChange={(e) => setAdding({ batchId: batch.id, value: e.target.value })}
                  onKeyDown={(e) => editorKeys(e, commitAdd, () => setAdding(null))}
                />
                <div className="review-editor-actions">
                  <button type="button" className="review-editor-cancel" onClick={() => setAdding(null)}>Cancel</button>
                  <button type="button" className="review-editor-save" onClick={commitAdd} disabled={!adding.value.trim()}>Save</button>
                </div>
              </div>
            ) : (
              <div className="review-add" onClick={() => setAdding({ batchId: batch.id, value: '' })}>+ Comment</div>
            )}
          </div>
        );
      })}
      <div className="review-add review-add-batch" onClick={onCreateBatch}>+ New batch</div>

      {sent.length > 0 && (
        <div className="review-sent">
          <div className="review-sent-header" onClick={() => setSentOpen((v) => !v)}>
            <span>{sentOpen ? '▾' : '▸'}</span> Sent ({sent.length})
          </div>
          {sentOpen && sent.map((batch) => {
            const open = expandedSent.has(batch.id);
            return (
              <div key={batch.id} className="review-batch sent">
                <div
                  className="review-batch-header"
                  onClick={() => setExpandedSent((prev) => {
                    const next = new Set(prev);
                    if (open) next.delete(batch.id); else next.add(batch.id);
                    return next;
                  })}
                >
                  <span className="review-batch-current">{open ? '▾' : '▸'}</span>
                  {renderBatchName(batch)}
                  <span className="review-batch-count">{batch.comments.length}</span>
                  <span className="review-batch-sent-at">{sentLabel(batch.sentAt)}</span>
                  <button
                    className="review-menu-btn"
                    onClick={(e) => openMenu(e, 'batch', batch.id)}
                    title="Batch menu"
                    aria-label="Batch menu"
                  >⋯</button>
                </div>
                {open && batch.comments.map((c) => renderComment(batch, c))}
              </div>
            );
          })}
        </div>
      )}

      {menu && menuComment && (
        <div ref={menuRef} className="tab-overflow-menu" style={{ top: menu.top, left: menu.left }}>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setEditing({ id: menuComment.comment.id, value: menuComment.comment.text }); }}
          >✎ Edit</button>
          <button
            className="overflow-action"
            disabled={menuIdx <= 0}
            onClick={() => { setMenu(null); moveBy(menuComment.batch, menuComment.comment.id, -1); }}
          >↑ Move up</button>
          <button
            className="overflow-action"
            disabled={menuIdx < 0 || menuIdx >= menuComment.batch.comments.length - 1}
            onClick={() => { setMenu(null); moveBy(menuComment.batch, menuComment.comment.id, 1); }}
          >↓ Move down</button>
          {drafts.filter((b) => b.id !== menuComment.batch.id).map((b) => (
            <button
              key={b.id}
              className="overflow-action"
              onClick={() => { setMenu(null); onPlaceComment(menuComment.comment.id, b.id); }}
            >→ Move to {b.name}</button>
          ))}
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); onMoveToNewBatch(menuComment.comment.id); }}
          >→ Move to new batch</button>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); onDeleteComment(menuComment.comment.id); }}
          >🗑 Delete</button>
        </div>
      )}
      {menu && menuBatch && (
        <div ref={menuRef} className="tab-overflow-menu" style={{ top: menu.top, left: menu.left }}>
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); setRenaming({ id: menuBatch.id, value: menuBatch.name }); }}
          >✎ Rename</button>
          {menuBatch.status === 'draft' ? (
            <button
              className="overflow-action"
              disabled={menuBatch.id === currentBatchId}
              onClick={() => { setMenu(null); onSetCurrent(menuBatch.id); }}
            >● Set as current</button>
          ) : (
            <>
              <button
                className="overflow-action"
                disabled={menuBatch.comments.length === 0}
                onClick={() => { setMenu(null); onSendBatch(menuBatch.id); }}
              >▸ Send again</button>
              <button
                className="overflow-action"
                onClick={() => { setMenu(null); onReopenBatch(menuBatch.id); }}
              >↺ Reopen</button>
            </>
          )}
          <button
            className="overflow-action"
            onClick={() => { setMenu(null); onDeleteBatch(menuBatch.id); }}
          >🗑 Delete</button>
        </div>
      )}
    </div>
  );
}
