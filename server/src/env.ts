// Loads .env into process.env. MUST be the first import of every entry point
// (index.ts, cli/*.ts).
//
// Why a separate module: store.ts / users.ts / auth.ts / session.ts / devin.ts /
// devin-versions.ts all resolve REMOTE_IDE_CONFIG_DIR (and friends) in a
// top-level `const`. ESM evaluates static imports before the importing module's
// body, so loading .env inside index.ts's body ran *after* those constants were
// fixed — .env values for them were silently ignored and the server fell back
// to ~/.config/remote-ide. Putting the loader in its own module imported first
// guarantees it runs before any of them.
import nodeFs from 'node:fs';
import nodePath from 'node:path';

export function loadEnvFile(file: string): void {
  if (!nodeFs.existsSync(file)) return;
  for (const line of nodeFs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// Repo root .env: server/ cwd → ../.env; also accept cwd/.env when run from root.
loadEnvFile(nodePath.resolve(process.cwd(), '.env'));
loadEnvFile(nodePath.resolve(process.cwd(), '../.env'));
