import type { FastifyInstance } from 'fastify';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';
import { getUserId } from './auth.js';

// Devin subscription usage (model: server.GetDevinUsage → cognition-api.GetUserStatus).
//
// The CLI's `/usage` panel is not exposed over ACP, so we call the same
// backend RPC the CLI does — SeatManagementService/GetUserStatus on the
// Connect-protocol API server — using the credentials `devin auth login`
// left on disk. No devin process is spawned and the key never leaves this
// module.

const CREDENTIALS_PATH = nodePath.join(nodeOs.homedir(), '.local', 'share', 'devin', 'credentials.toml');
const USER_STATUS_RPC = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const CACHE_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

type Quota = { remainingPercent: number; resetAt: string | null };
export type DevinUsage = {
  ok: true;
  planName: string | null;
  planEnd: string | null;
  daily: Quota | null;
  weekly: Quota | null;
  overageBalance: number | null;
  acu: { consumed: number; limit: number | null } | null;
  fetchedAt: string;
};
type DevinUsageError = { ok: false; error: string };

// Minimal TOML reader: the file is flat `key = "value"` lines.
function readCredentials(): { apiKey: string; apiServerUrl: string } | null {
  let text: string;
  try { text = nodeFs.readFileSync(CREDENTIALS_PATH, 'utf8'); } catch { return null; }
  const kv: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*"([^"]*)"/.exec(line);
    if (m) kv[m[1]] = m[2];
  }
  const apiKey = kv.windsurf_api_key;
  if (!apiKey) return null;
  return { apiKey, apiServerUrl: kv.api_server_url || 'https://server.codeium.com' };
}

function unixToIso(v: unknown): string | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}
function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function mapUserStatus(body: any): DevinUsage {
  const ps = body?.userStatus?.planStatus ?? {};
  const info = ps.planInfo ?? body?.planInfo ?? {};
  const devinInfo = info.devinInfo ?? {};
  const dailyPct = num(ps.dailyQuotaRemainingPercent);
  const weeklyPct = num(ps.weeklyQuotaRemainingPercent);
  const overageMicros = num(ps.overageBalanceMicros);
  const acuConsumed = num(ps.acuConsumed ?? devinInfo.acuConsumed);
  return {
    ok: true,
    planName: info.planName ?? null,
    planEnd: ps.planEnd ?? null,
    daily: dailyPct === null ? null : { remainingPercent: dailyPct, resetAt: unixToIso(ps.dailyQuotaResetAtUnix) },
    weekly: weeklyPct === null || info.hideWeeklyQuota
      ? null
      : { remainingPercent: weeklyPct, resetAt: unixToIso(ps.weeklyQuotaResetAtUnix) },
    overageBalance: overageMicros === null ? null : overageMicros / 1_000_000,
    acu: acuConsumed === null ? null : { consumed: acuConsumed, limit: num(ps.acuLimit ?? devinInfo.acuLimit) },
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchUserStatus(creds: { apiKey: string; apiServerUrl: string }): Promise<DevinUsage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(creds.apiServerUrl.replace(/\/$/, '') + USER_STATUS_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify({
        metadata: { api_key: creds.apiKey, ide_name: 'remote-ide', ide_version: '1.0.0', extension_version: '1.0.0' },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return mapUserStatus(await r.json());
  } finally {
    clearTimeout(timer);
  }
}

// Process-wide cache: the credentials file is per-host, so every remote-ide
// user sees the same account's quota. One upstream call per minute is plenty.
let cache: { value: DevinUsage; at: number } | null = null;
let inFlight: Promise<DevinUsage> | null = null;

export async function getDevinUsage(refresh = false): Promise<DevinUsage | DevinUsageError> {
  const creds = readCredentials();
  if (!creds) return { ok: false, error: 'not_logged_in' };
  if (!refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!inFlight) {
    inFlight = fetchUserStatus(creds)
      .then((v) => { cache = { value: v, at: Date.now() }; return v; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function registerDevinUsageRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { refresh?: string } }>('/api/devin/usage', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    try {
      return await getDevinUsage(req.query.refresh === '1');
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
