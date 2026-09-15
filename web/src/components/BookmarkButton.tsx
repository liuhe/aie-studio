// ☆ on a chat message (model: web.BookmarkMessage). Only rendered for
// messages that already have a stable anchor — the panels decide that.
// `active` = already bookmarked: filled ★, always visible, click removes.
export function BookmarkButton({ onClick, className, active }: { onClick: () => void; className?: string; active?: boolean }) {
  const label = active ? 'Remove bookmark' : 'Bookmark this message';
  return (
    <button
      type="button"
      className={`msg-bookmark-btn ${active ? 'active' : ''} ${className ?? ''}`}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >{active ? '★' : '☆'}</button>
  );
}

// Default Pin label for a bookmarked message: first 80 chars, whitespace
// collapsed. Model: entity Pin.text.
export function bookmarkLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
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
