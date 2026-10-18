import { useEffect, useRef } from 'react';

export type PickerItem = {
  id: string;
  primary: string;
  secondary?: string;
  timestamp?: number; // ms since epoch
};

// Generic resume-session picker. Replaces the native prompt() flow which was
// effectively unusable on mobile (multi-line text gets truncated, can't tap
// rows). Both Claude and Devin Resume actions reuse this.
export function SessionPicker({
  title,
  items,
  onPick,
  onClose,
}: {
  title: string;
  items: PickerItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus the modal so Esc works without first clicking inside.
  useEffect(() => { ref.current?.focus(); }, []);

  function fmt(ts?: number): string {
    if (!ts) return '';
    return new Date(ts).toLocaleString();
  }

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div
        className="picker-modal"
        ref={ref}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="picker-header">
          <span>{title}</span>
          <button className="picker-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="picker-body">
          {items.map((it) => (
            <button
              key={it.id}
              className="session-picker-item"
              onClick={() => onPick(it.id)}
              title={it.id}
            >
              <div className="session-picker-item-primary">{it.primary}</div>
              {(it.secondary || it.timestamp) && (
                <div className="session-picker-item-meta">
                  {it.secondary && <span className="session-picker-item-secondary">{it.secondary}</span>}
                  {it.timestamp && <span className="session-picker-item-stamp">{fmt(it.timestamp)}</span>}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
