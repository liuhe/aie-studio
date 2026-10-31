import { useEffect, useRef, useState, type RefObject } from 'react';
import { clampQuote, type CommentMark } from '../lib/review';
import { marksAtPoint } from '../lib/quoteHighlight';

// Review entry point inside a session panel (model: web.CommentOnSelection).
// Selecting text in a message floats a "💬 Comment" button under the
// selection; that button opens a small composer showing the quote + a
// textarea. Clicking an already painted quote lists the comments on it
// (model: web.ViewQuoteComments).

export type NewComment = { text: string; quote?: string; anchor?: string };
type Point = { x: number; y: number };
type Draft = { quote: string; anchor: string | null; at: Point };
const POPOVER_WIDTH = 320;

function below(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.bottom + 6 };
}

export function CommentComposer({ containerRef, onComment, onSend, highlightOwner, onFocusComment }: {
  // The scrolling message list; only selections inside one of its .msg count.
  containerRef: RefObject<HTMLElement | null>;
  onComment: (c: NewComment) => void;
  // Skip the Batch: append the comment to the panel's prompt input instead
  // (model: web.SendCommentToPrompt).
  onSend: (c: NewComment) => void;
  // The panel's applyQuoteHighlights owner, for hit-testing painted quotes.
  highlightOwner: object;
  // Show this comment in the Review panel.
  onFocusComment: (commentId: string) => void;
}) {
  const [sel, setSel] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [viewing, setViewing] = useState<{ marks: CommentMark[]; at: Point } | null>(null);
  const draftOpenRef = useRef(false);
  draftOpenRef.current = !!draft;

  useEffect(() => {
    function update() {
      if (draftOpenRef.current) return;
      const root = containerRef.current;
      const s = document.getSelection();
      if (!root || !s || s.isCollapsed || s.rangeCount === 0) { setSel(null); return; }
      const range = s.getRangeAt(0);
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
      const msg = start?.closest<HTMLElement>('.msg');
      const quote = s.toString().trim();
      if (!msg || !root.contains(msg) || !quote) { setSel(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { setSel(null); return; }
      setViewing(null);
      setSel({ quote: clampQuote(quote), anchor: msg.dataset.anchor ?? null, at: below(rect) });
    }
    const root = containerRef.current;
    document.addEventListener('selectionchange', update);
    root?.addEventListener('scroll', update, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', update);
      root?.removeEventListener('scroll', update);
    };
  }, [containerRef]);

  // Painted quotes are not elements: hit-test clicks / hovers against them.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const s = document.getSelection();
      if (draftOpenRef.current || (s && !s.isCollapsed)) return;
      const marks = marksAtPoint(highlightOwner, e.clientX, e.clientY);
      setViewing(marks.length ? { marks, at: { x: e.clientX, y: e.clientY + 12 } } : null);
    }
    let frame = 0;
    function onMove(e: MouseEvent) {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root!.style.cursor = marksAtPoint(highlightOwner, e.clientX, e.clientY).length ? 'pointer' : '';
      });
    }
    const dismiss = () => setViewing(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    root.addEventListener('click', onClick);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('scroll', dismiss, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.style.cursor = '';
      root.removeEventListener('click', onClick);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('scroll', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [containerRef, highlightOwner]);
  // Any press outside the list closes it (a click on another quote reopens).
  useEffect(() => {
    if (!viewing) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if ((e.target as Element | null)?.closest?.('.quote-comments')) return;
      setViewing(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [viewing]);

  function close() {
    setDraft(null);
    setText('');
  }

  function submit(deliver: (c: NewComment) => void) {
    if (!draft) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    deliver({ text: trimmed, quote: draft.quote || undefined, anchor: draft.anchor ?? undefined });
    close();
    document.getSelection()?.removeAllRanges();
  }

  if (draft) {
    const left = Math.max(8, Math.min(draft.at.x - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    // Not enough room below → sit above the anchor point instead.
    const flip = draft.at.y > window.innerHeight - 220;
    return (
      <div
        className="comment-popover"
        style={{ left, width: POPOVER_WIDTH, ...(flip ? { bottom: window.innerHeight - draft.at.y + 30 } : { top: draft.at.y }) }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {draft.quote && <div className="comment-popover-quote">{draft.quote}</div>}
        <textarea
          autoFocus
          className="review-editor-input"
          placeholder="Comment… (⌘/Ctrl+Enter to save, +Shift to send)"
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(e.shiftKey ? onSend : onComment); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
        />
        <div className="review-editor-actions">
          <button type="button" className="review-editor-cancel" onClick={close}>Cancel</button>
          <button type="button" className="review-editor-send" title="Append to the prompt input, without adding it to a batch" onClick={() => submit(onSend)} disabled={!text.trim()}>Send</button>
          <button type="button" className="review-editor-save" title="Add to the current batch" onClick={() => submit(onComment)} disabled={!text.trim()}>Save</button>
        </div>
      </div>
    );
  }

  if (viewing && !sel) {
    const left = Math.max(8, Math.min(viewing.at.x - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    const flip = viewing.at.y > window.innerHeight - 160;
    return (
      <div
        className="comment-popover quote-comments"
        style={{ left, width: POPOVER_WIDTH, ...(flip ? { bottom: window.innerHeight - viewing.at.y + 30 } : { top: viewing.at.y }) }}
      >
        {viewing.marks.map((m) => (
          <button
            key={m.id}
            type="button"
            className="quote-comment"
            title="Show in the Review panel"
            onClick={() => { setViewing(null); onFocusComment(m.id); }}
          >
            <span className="quote-comment-text">{m.text}</span>
            <span className="quote-comment-batch">{m.batchName}{m.sent ? ' · sent' : ''}</span>
          </button>
        ))}
      </div>
    );
  }

  if (!sel) return null;
  return (
    <button
      type="button"
      className="selection-comment-btn"
      style={{ left: Math.max(8, Math.min(sel.at.x - 50, window.innerWidth - 108)), top: Math.min(sel.at.y, window.innerHeight - 40) }}
      // pointerdown, not click: a touch tap collapses the selection (and with
      // it this button) before click would fire. preventDefault keeps the
      // selection painted while the composer is open.
      onPointerDown={(e) => {
        e.preventDefault();
        setText('');
        setDraft(sel);
        setSel(null);
      }}
    >💬 Comment</button>
  );
}

// Flash a just-revealed message so the eye lands on it (model: web.RevealMessage).
export function flashMessage(el: HTMLElement) {
  el.classList.remove('msg-flash');
  void el.offsetWidth; // restart the animation if it was already running
  el.classList.add('msg-flash');
  window.setTimeout(() => el.classList.remove('msg-flash'), 1700);
}

export function sleep(ms: number) {
  return new Promise<void>((r) => window.setTimeout(r, ms));
}
