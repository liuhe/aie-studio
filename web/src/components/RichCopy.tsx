import { useCallback, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

// Model: web.RichCopy — opt-in (settings.richCopy), any device.
// 🍚 on an assistant message copies that reply to the clipboard as rich text
// (semantic HTML + plain-text fallback) in one click. There is no overlay and
// nothing to edit; the transcript is never touched.

export function RichCopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="msg-richcopy-btn"
      title="Copy as rich text"
      aria-label="Copy as rich text"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >🍚</button>
  );
}

// Attributes that survive into the clipboard HTML. Everything else — class,
// style, data-*, title, aria-* — is dropped so nothing of the chat rendering
// (bubble background, theme colours, highlighter palette, font sizes) can
// reach the paste target. The target applies its own native styles for
// headings / lists / tables / code, which is what "plain rich text" means.
const KEEP_ATTRS: Record<string, readonly string[]> = {
  a: ['href'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align'],
  ol: ['start'],
  input: ['type', 'checked', 'disabled'],
};
const MONO_STYLE = 'font-family: ui-monospace, Menlo, Consolas, monospace';

// Build the clipboard HTML ourselves instead of letting the browser serialise
// the selection: browser serialisation inlines computed styles (container
// background + padding, line-height, code-block colours), which is exactly
// what made the paste look like a boxed quote.
// SyntaxHighlighter renders <pre><div class="language-x" style><code class="language-x" style><span style>…
// (PreTag="div" inside react-markdown's own <pre>); it is collapsed to
// <pre><code>text</code></pre> first, then every element is stripped down to
// KEEP_ATTRS, with pre/code getting a monospace font hint only.
export function toClipboardHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  for (const code of Array.from(clone.querySelectorAll('code[class*="language-"]'))) {
    const parent = code.parentElement;
    const wrapper = parent && parent.tagName === 'DIV' ? parent : code;
    const plain = document.createElement('code');
    plain.textContent = code.textContent ?? '';
    if (wrapper.parentElement && wrapper.parentElement.tagName === 'PRE') {
      wrapper.replaceWith(plain);
    } else {
      const pre = document.createElement('pre');
      pre.appendChild(plain);
      wrapper.replaceWith(pre);
    }
  }
  for (const el of Array.from(clone.querySelectorAll('*'))) {
    const keep = KEEP_ATTRS[el.tagName.toLowerCase()] ?? [];
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'PRE' || el.tagName === 'CODE') el.setAttribute('style', MONO_STYLE);
  }
  return clone.innerHTML;
}

// Primary path: select the off-screen source so execCommand('copy') is
// allowed, but intercept the copy event and write our own text/html +
// text/plain. Works in Chromium / WebKit / Firefox and does not need a secure
// context (navigator.clipboard is unavailable over plain http on the LAN).
// The user's own selection is restored afterwards.
function copyViaEvent(el: HTMLElement, html: string, text: string): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const prev = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  let handled = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', text);
    handled = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    return document.execCommand('copy') && handled;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    sel.removeAllRanges();
    if (prev) sel.addRange(prev);
  }
}

async function copyRichText(el: HTMLElement): Promise<boolean> {
  const html = toClipboardHtml(el);
  const text = el.innerText;
  if (copyViaEvent(el, html, text)) return true;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

// Owns the click-time snapshot and the off-screen copy source.
// `render(text)` returns the panel's own MarkdownText — the same variant the
// bubble uses, because none of its styling reaches the clipboard (see
// toClipboardHtml). The source is mounted synchronously (flushSync) inside the
// click handler so execCommand('copy') still runs within the user gesture,
// then unmounted once the copy settles. It must stay rendered (not
// display:none) so it can be selected and innerText is populated.
// Returns `source` for the panel to render and `copy(text)` for the 🍚 click.
export function useRichCopy(
  render: (text: string) => ReactNode,
  onDone: (ok: boolean) => void,
): { copy: (text: string) => void; source: ReactNode } {
  const [text, setText] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const copy = useCallback((t: string) => {
    if (busy.current) return;
    busy.current = true;
    flushSync(() => setText(t));
    const el = ref.current;
    void (el ? copyRichText(el) : Promise.resolve(false)).then((ok) => {
      busy.current = false;
      setText(null);
      onDoneRef.current(ok);
    });
  }, []);

  const source = text != null
    ? <div ref={ref} className="richcopy-source" aria-hidden="true">{render(text)}</div>
    : null;
  return { copy, source };
}
