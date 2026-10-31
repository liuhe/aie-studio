import { useEffect, useState } from 'react';
import { clearDebugEvents, getDebugEvents, subscribeDebug, type DebugEvent } from '../lib/debugLog';
import { downloadText } from '../lib/export/download';

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtDateForFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadAll(events: DebugEvent[]) {
  const body = events
    .map((e) => `${fmtTs(e.ts)} [${e.category}] ${e.message}`)
    .join('\n');
  downloadText(body + '\n', `debug-log-${fmtDateForFilename()}.txt`, 'text/plain');
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<DebugEvent[]>(() => getDebugEvents());
  useEffect(() => subscribeDebug((next) => setEvents(next.slice())), []);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal debug-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Debug log</span>
          <button
            className="settings-signout"
            style={{ marginLeft: 'auto', marginRight: 8 }}
            disabled={events.length === 0}
            onClick={() => downloadAll(events)}
          >Download</button>
          <button
            className="settings-signout"
            style={{ marginRight: 12 }}
            onClick={clearDebugEvents}
          >Clear</button>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-body debug-body">
          {events.length === 0 ? (
            <div className="empty">No events yet</div>
          ) : (
            <div className="debug-list">
              {events.map((e) => (
                <div key={e.id} className="debug-row">
                  <span className="debug-ts">{fmtTs(e.ts)}</span>
                  <span className="debug-cat">[{e.category}]</span>
                  <span className="debug-msg">{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
