import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// Model: web.RichCopyEditor — desktop-only, opt-in (settings.richCopy).
// 🍚 on an assistant message opens RichCopySheet: the rendered Markdown in a
// contentEditable box so the user can tweak it in place and copy rich text
// (HTML) into another app. Edits never flow back into the transcript.

export function RichCopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="msg-richcopy-btn"
      title="Edit & copy as rich text"
      aria-label="Edit & copy as rich text"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >🍚</button>
  );
}

// Select everything inside `el` and copy via the browser's own rich-text
// serialisation (execCommand inlines computed styles in Chromium/WebKit).
// Falls back to a ClipboardItem built from innerHTML / innerText.
async function copyAll(el: HTMLElement): Promise<boolean> {
  const sel = window.getSelection();
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  try {
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand('copy')) return true;
    }
  } catch { /* fall through */ } finally {
    if (sel) {
      sel.removeAllRanges();
      if (prev) sel.addRange(prev);
    }
  }
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([el.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([el.innerText], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(el.innerText);
    return true;
  } catch {
    return false;
  }
}

export function RichCopySheet({ children, onClose }: {
  // The message rendered with the panel's own MarkdownText — same look as
  // the bubble, so what you copy is what you saw.
  children: ReactNode;
  onClose: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Bumping the key remounts children, discarding contentEditable edits.
  const [resetKey, setResetKey] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current); }, []);

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1400);
  }, []);

  const onCopy = useCallback(async () => {
    const el = bodyRef.current;
    if (!el) return;
    showFlash((await copyAll(el)) ? 'Copied ✓' : 'Copy failed');
  }, [showFlash]);

  return (
    <div className="richcopy-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="richcopy-sheet" role="dialog" aria-label="Edit & copy as rich text">
        <div className="richcopy-header">
          <span className="richcopy-title">🍚 Edit &amp; copy</span>
          <span className="richcopy-flash" data-on={flash ? '1' : '0'}>{flash}</span>
          <div className="richcopy-actions">
            <button type="button" className="richcopy-btn" onClick={onCopy} title="Select all and copy as rich text">Copy all</button>
            <button type="button" className="richcopy-btn" onClick={() => setResetKey((k) => k + 1)} title="Discard edits">Reset</button>
            <button type="button" className="settings-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div
          key={resetKey}
          ref={bodyRef}
          className="richcopy-body msg-assistant"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
        >
          {children}
        </div>
        <div className="richcopy-hint">Edit in place, then select and ⌘C — or Copy all. Changes are not saved to the conversation.</div>
      </div>
    </div>
  );
}
