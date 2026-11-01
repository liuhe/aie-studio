import type { ActivityMark } from '../lib/tabActivity';

// Model: web.TabActivityMarkers rule-312. One marker, two looks: an amber
// pulsing "?" when the session waits on the user, an accent breathing dot
// while it generates. Renders nothing otherwise.
export function TabActivityMark({ mark }: { mark: ActivityMark | null }) {
  if (!mark) return null;
  const label = mark === 'awaiting' ? 'Waiting for your input' : 'Generating';
  return (
    <span className={`tab-activity tab-activity-${mark}`} title={label} aria-label={label} role="img">
      {mark === 'awaiting' ? '?' : ''}
    </span>
  );
}
