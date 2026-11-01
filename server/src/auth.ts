import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findUserByName, findUserById, listUsers, verifyPassword } from './users.js';

const COOKIE_NAME = 'ride_session';
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

// token → { userId, expiresAt }. Survives launchd restarts so users don't get
// kicked out every time the service bounces.
type SessionRecord = { userId: string; expiresAt: number };
let sessions: Record<string, SessionRecord> = {};

// Cached presence of at least one user. Used to gate the auth flow — if no
// users have been provisioned yet, /api/auth/login can't possibly succeed and
// the server should refuse protected routes with a clearer hint.
let anyUserCached = false;

async function refreshUserCache() {
  anyUserCached = (await listUsers()).length > 0;
}

async function loadSessions() {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Tolerate the legacy single-user format (token → expiresAt number) by
    // dropping it — anyone holding such a token has to log in again, which
    // is what the multi-user upgrade demands anyway.
    if (parsed && typeof parsed === 'object') {
      sessions = {};
      for (const [token, val] of Object.entries(parsed)) {
        if (val && typeof val === 'object' && 'userId' in (val as any)) {
          sessions[token] = val as SessionRecord;
        }
      }
    }
  } catch {
    sessions = {};
  }
  const now = Date.now();
  for (const [t, r] of Object.entries(sessions)) {
    if (r.expiresAt < now) delete sessions[t];
  }
}

let writeTimer: NodeJS.Timeout | null = null;
async function persistSessions() {
  // Debounce so a burst of requests doesn't fsync repeatedly.
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const tmp = SESSIONS_FILE + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(sessions));
      await fs.rename(tmp, SESSIONS_FILE);
    } catch {}
  }, 250);
}

function readCookie(req: FastifyRequest): string | undefined {
  const c = (req as any).cookies?.[COOKIE_NAME];
  if (c) return c;
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v;
  }
  return undefined;
}

export function authRequired(): boolean {
  // Always required in multi-user mode. Even if there are zero users we still
  // want to block protected routes — they just can't be unlocked until the
  // operator runs `adduser`.
  return true;
}

function userIdForToken(token: string | undefined): string | null {
  if (!token) return null;
  const rec = sessions[token];
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    delete sessions[token];
    persistSessions();
    return null;
  }
  return rec.userId;
}

export function getUserId(req: FastifyRequest): string | null {
  return userIdForToken(readCookie(req));
}

export function isAuthed(req: FastifyRequest): boolean {
  return getUserId(req) !== null;
}

export async function registerAuth(app: FastifyInstance) {
  await loadSessions();
  await refreshUserCache();

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (url.startsWith('/api/auth/') || url === '/api/health') return;
    if (
      !url.startsWith('/api/') &&
      !url.startsWith('/ws/') &&
      !url.startsWith('/raw/')
    ) return;
    if (!anyUserCached) {
      return reply.code(503).send({
        error: 'no users configured — run `pnpm --filter server adduser <name>`',
      });
    }
    if (!isAuthed(req)) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/api/auth/status', async (req) => {
    const uid = getUserId(req);
    let username: string | undefined;
    if (uid) {
      const u = await findUserById(uid);
      username = u?.name;
    }
    return {
      required: authRequired(),
      authenticated: uid !== null,
      configured: anyUserCached,
      username,
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    // Deliberately uniform error message — don't leak whether the username
    // exists vs the password is wrong.
    const fail = () => reply.code(401).send({ error: 'invalid credentials' });
    if (!username || !password) return fail();
    const user = await findUserByName(username);
    if (!user) return fail();
    if (!verifyPassword(password, user)) return fail();
    const token = randomBytes(32).toString('hex');
    sessions[token] = { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS };
    persistSessions();
    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { ok: true, username: user.name };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readCookie(req);
    if (token) {
      delete sessions[token];
      persistSessions();
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  // Re-check the user cache periodically in case the operator runs adduser
  // while the server is running. Cheap and avoids requiring a restart.
  setInterval(() => { refreshUserCache().catch(() => {}); }, 30_000).unref();
}
