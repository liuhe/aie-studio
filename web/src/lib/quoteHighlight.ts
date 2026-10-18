import type { CommentMark } from './review';

// Model: web.HighlightQuotes — paint commented quotes inside session messages
// with the CSS Custom Highlight API. No DOM mutation, so React's tree is left
// alone; callers just re-run this after messages or comments change.

const HIGHLIGHT_NAME = 'review-quote';

type HighlightRegistry = { set: (name: string, h: unknown) => void; get: (name: string) => unknown; delete: (name: string) => void };
type HighlightSet = { add: (r: Range) => void; delete: (r: Range) => void };
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function' ? css.highlights : null;
}

// selection.toString() inserts newlines between blocks that textContent
// doesn't have, so compare with all whitespace removed and map the match back
// to text-node offsets. First occurrence wins.
export function findQuoteRange(root: Node, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, '');
  if (!needle) return null;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let hay = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Text).data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) continue;
      hay += data[i];
      nodes.push(n as Text);
      offsets.push(i);
    }
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length - 1;
  const range = doc.createRange();
  range.setStart(nodes[at], offsets[at]);
  range.setEnd(nodes[end], offsets[end] + 1);
  return range;
}

// Replace the ranges this `owner` (one session panel) contributed to the
// shared highlight. Several panels stay mounted at once, hence per-owner sets.
const owned = new WeakMap<object, { range: Range; mark: CommentMark }[]>();
export function applyQuoteHighlights(owner: object, root: HTMLElement | null, marks: readonly CommentMark[]) {
  const reg = registry();
  if (!reg) return;
  let highlight = reg.get(HIGHLIGHT_NAME) as HighlightSet | undefined;
  if (!highlight) {
    highlight = new (globalThis as unknown as { Highlight: new () => HighlightSet }).Highlight();
    reg.set(HIGHLIGHT_NAME, highlight);
  }
  for (const o of owned.get(owner) ?? []) highlight.delete(o.range);
  const ranges: { range: Range; mark: CommentMark }[] = [];
  if (root) {
    for (const m of marks) {
      if (!m.quote) continue;
      const el = root.querySelector(`[data-anchor="${CSS.escape(m.anchor)}"]`);
      const range = el ? findQuoteRange(el, m.quote) : null;
      if (range) { highlight.add(range); ranges.push({ range, mark: m }); }
    }
  }
  owned.set(owner, ranges);
}

// Model: web.ViewQuoteComments — highlights aren't elements and get no
// events, so clicks are hit-tested against the painted ranges' client rects.
export function marksAtPoint(owner: object, x: number, y: number): CommentMark[] {
  const hits: CommentMark[] = [];
  for (const { range, mark } of owned.get(owner) ?? []) {
    for (const r of Array.from(range.getClientRects())) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { hits.push(mark); break; }
    }
  }
  return hits;
}
