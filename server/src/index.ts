import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import compress from '@fastify/compress';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFsRoutes } from './fs.js';
import { registerSessionRoutes } from './session.js';
import { registerDevinRoutes } from './devin.js';
import { registerDevinUsageRoutes } from './devin-usage.js';
import { registerProjectRoutes } from './projects.js';
import { registerExportRoutes } from './export-routes.js';
import { registerAieRoutes } from './aie.js';
import { registerModelRoutes, initModelCatalog } from './models.js';
import { registerAuth, authRequired } from './auth.js';
import { migrateLegacyIfNeeded, sanitizeAllWorkspaces } from './store.js';

// Load .env from repo root (server/ cwd → ../.env) before reading any env var.
function loadEnvFile(file: string) {
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
loadEnvFile(nodePath.resolve(process.cwd(), '.env'));
loadEnvFile(nodePath.resolve(process.cwd(), '../.env'));

const PORT = Number(process.env.PORT || 9991);
const HOST = process.env.HOST || '0.0.0.0';

const __dirname = nodePath.dirname(fileURLToPath(import.meta.url));
// src/index.ts → server/src → server → repo → repo/web/dist
const WEB_DIST = nodePath.resolve(__dirname, '../../web/dist');

const app = Fastify({ logger: { level: 'info' } });

// Puppeteer's CDP CallbackRegistry rejects every pending callback when Chrome
// disconnects (e.g. tab/renderer crash mid-screenshot). The awaited promise is
// caught at the route, but the other pending callbacks become unhandled
// rejections which crash Node by default. Log and continue instead so a single
// failed export doesn't take the whole service down.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
});

await migrateLegacyIfNeeded();
{
  const { rewritten } = await sanitizeAllWorkspaces();
  if (rewritten > 0) app.log.info({ rewritten }, 'sanitized legacy workspace.json files');
}

await app.register(cors, { origin: true, credentials: true });
await app.register(cookie);
// gzip/br for transcript and other large JSON; default threshold 1KB.
await app.register(compress, { encodings: ['gzip', 'deflate'] });
await app.register(websocket);
await registerAuth(app);

registerProjectRoutes(app);
registerFsRoutes(app);
registerSessionRoutes(app);
registerDevinRoutes(app);
registerDevinUsageRoutes(app);
registerExportRoutes(app, WEB_DIST);
registerAieRoutes(app);
registerModelRoutes(app);
initModelCatalog();

app.get('/api/health', async () => ({ ok: true, authRequired: authRequired() }));

// Static hosting of the built SPA. Only registered when dist exists so
// `pnpm dev` (no build) still works via the Vite proxy as before.
if (nodeFs.existsSync(WEB_DIST)) {
  await app.register(staticPlugin, {
    root: WEB_DIST,
    prefix: '/',
    // wildcard:true (default) recurses into /assets/* — Vite emits hashed
    // bundles there. Setting false breaks subdirectory access.
    cacheControl: false, // we set Cache-Control manually below
    setHeaders(res, p) {
      // Hashed assets (Vite emits /assets/index-<hash>.{js,css}) are
      // content-addressed: cache forever. index.html must revalidate so a
      // deploy that changes asset hashes propagates immediately.
      if (p.endsWith('/index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (p.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?', 1)[0];
    if (url.startsWith('/api/') || url.startsWith('/ws/')) {
      return reply.code(404).send({ error: 'not found' });
    }
    // Don't fallback for asset-shaped paths: returning index.html as HTML for a
    // missing /assets/x.js makes the browser blow up with a MIME-type error.
    const tail = url.slice(url.lastIndexOf('/') + 1);
    if (tail.includes('.')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply
      .type('text/html')
      .header('Cache-Control', 'no-cache, must-revalidate')
      .sendFile('index.html');
  });
  app.log.info(`serving web/dist from ${WEB_DIST}`);
} else {
  app.log.warn(`web/dist not found at ${WEB_DIST} — run \`pnpm --filter web build\` to enable static hosting`);
}

app.listen({ port: PORT, host: HOST }).then((addr) => {
  app.log.info(`remote-ide server listening on ${addr}`);
});
