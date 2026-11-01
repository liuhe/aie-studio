import type { FastifyInstance } from 'fastify';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';
import { getSettings } from './store.js';
import { getUserId } from './auth.js';

// Which `devin` binary to spawn (model: Settings.devinVersion, rule-306;
// server.ListDevinVersions). The CLI self-updates into
// ~/.local/share/devin/cli/_versions/<v>/ and points `current` at the newest.
// Resolution happens on every spawn — never cached at module load — so a CLI
// update or a Settings change takes effect for the next session.

export const VERSIONS_DIR =
  process.env.REMOTE_IDE_DEVIN_VERSIONS_DIR
  || nodePath.join(nodeOs.homedir(), '.local', 'share', 'devin', 'cli', '_versions');

export type DevinVersion = { version: string; current: boolean };

function binIn(dir: string): string {
  return nodePath.join(VERSIONS_DIR, dir, 'bin', 'devin');
}

// Numeric-aware descending compare: "3000.11.228" > "3000.6.7" > "2026.5.6-12".
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (!Number.isNaN(d) && d !== 0) return d;
  }
  return b.localeCompare(a);
}

function currentTarget(): string | null {
  try {
    const link = nodePath.join(VERSIONS_DIR, 'current');
    return nodePath.basename(nodeFs.readlinkSync(link));
  } catch { return null; }
}

export function listDevinVersions(): DevinVersion[] {
  let entries: string[] = [];
  try { entries = nodeFs.readdirSync(VERSIONS_DIR); } catch { return []; }
  const current = currentTarget();
  return entries
    .filter((d) => !d.startsWith('_') && d !== 'current' && nodeFs.existsSync(binIn(d)))
    .sort(compareVersionsDesc)
    .map((version) => ({ version, current: version === current }));
}

// Resolve the binary for a spawn. `pinned` is Settings.devinVersion ('' = auto).
// Auto = `current` symlink → highest installed → `devin` on PATH.
export function resolveDevinBin(pinned: string | undefined, warn?: (msg: string) => void): string {
  if (pinned) {
    const bin = binIn(pinned);
    if (nodeFs.existsSync(bin)) return bin;
    warn?.(`devin version ${pinned} not installed under ${VERSIONS_DIR}; falling back to auto`);
  }
  const cur = currentTarget();
  if (cur && nodeFs.existsSync(binIn(cur))) return binIn(cur);
  const [newest] = listDevinVersions();
  if (newest) return binIn(newest.version);
  return 'devin';
}

export async function resolveDevinBinForUser(uid: string, warn?: (msg: string) => void): Promise<string> {
  const settings = await getSettings(uid);
  return resolveDevinBin(settings.devinVersion, warn);
}

export function registerDevinVersionRoutes(app: FastifyInstance) {
  app.get('/api/devin/versions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    return { versions: listDevinVersions(), versionsDir: VERSIONS_DIR };
  });
}
