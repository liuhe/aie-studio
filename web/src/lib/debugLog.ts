export type DebugEvent = {
  id: number;
  ts: number;
  category: string;
  message: string;
};

const MAX_EVENTS = 500;
const buffer: DebugEvent[] = [];
const listeners = new Set<(events: DebugEvent[]) => void>();
let seq = 0;

export function logDebug(category: string, message: string) {
  const ev: DebugEvent = { id: ++seq, ts: Date.now(), category, message };
  buffer.push(ev);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  // eslint-disable-next-line no-console
  console.log(`[${category}] ${message}`);
  for (const cb of listeners) cb(buffer);
}

export function getDebugEvents(): DebugEvent[] {
  return buffer.slice();
}

export function subscribeDebug(cb: (events: DebugEvent[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function clearDebugEvents() {
  buffer.length = 0;
  for (const cb of listeners) cb(buffer);
}
