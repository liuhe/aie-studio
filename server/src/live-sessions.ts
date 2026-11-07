// Model: entity Claude Session invariant — one live bridge per sessionId.
// Both bridges (session.ts = cli, sdk-session.ts = sdk) register the
// sessions they hold a process for, so neither resumes a session the other
// is already driving (two processes would interleave writes to one jsonl).
export type Bridge = 'cli' | 'sdk';

const live = new Map<string, Bridge>();

export function markLive(sessionId: string, bridge: Bridge): void {
  live.set(sessionId, bridge);
}

// Only the owning bridge may clear an entry (a stale unmark from the other
// bridge must not drop a session that was just claimed).
export function unmarkLive(sessionId: string, bridge: Bridge): void {
  if (live.get(sessionId) === bridge) live.delete(sessionId);
}

export function liveBridge(sessionId: string): Bridge | null {
  return live.get(sessionId) ?? null;
}
