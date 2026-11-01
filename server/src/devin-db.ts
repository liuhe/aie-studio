// Devin CLI's local SQLite store (~/.local/share/devin/cli/sessions.db).
// Shared by devin.ts (session list / transcript) and observe/devin-adapter.ts
// (observation assembly). Always opened read-only: devin itself may be writing.
import { DatabaseSync } from 'node:sqlite';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

export function devinDbPath(home = nodeOs.homedir()): string {
  return nodePath.join(home, '.local', 'share', 'devin', 'cli', 'sessions.db');
}

/** null when the store does not exist (devin never ran on this machine). */
export function openDevinDb(dbPath = devinDbPath()): DatabaseSync | null {
  if (!nodeFs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath, { readOnly: true });
}
