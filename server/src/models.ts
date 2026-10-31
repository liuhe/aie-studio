import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const DEFAULT_CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json';
const REFRESH_MS = 24 * 60 * 60 * 1000;

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export type ModelThinking = {
  type: 'effort' | 'none' | string;
  options: string[];
  default: string | null;
};

export type ModelEntry = {
  id: string;
  name: string;
  short_name?: string;
  description?: string;
  section: 'main' | 'overflow' | string;
  min_claude_code_version?: string;
  thinking: ModelThinking;
};

type CatalogModel = {
  id: string;
  name: string;
  short_name?: string;
  description?: string;
  section?: string;
  min_claude_code_version?: string;
  thinking?: { type?: string; effort_options?: Array<{ id: string; name?: string }> };
};

type Catalog = {
  version: number;
  issued_at?: string;
  expires_at?: string;
  surfaces?: {
    cc?: {
      model_selector_config?: Array<{ models?: CatalogModel[] }>;
      model_selector_state?: Array<{
        thinking_by_model?: Array<{ id: string; thinking?: { effort?: string } }>;
      }>;
    };
  };
};

type State = {
  catalog: Catalog | null;
  fetchedAt: number;
  cliVersion: string | null;
  cliError: string | null;
  fetchError: string | null;
};

const state: State = {
  catalog: null,
  fetchedAt: 0,
  cliVersion: null,
  cliError: null,
  fetchError: null,
};

// Aliases the claude CLI resolves to the latest snapshot on its own. We always
// surface these — they don't appear in the catalog's `models` list but users
// rely on them for "auto-upgrade" semantics.
// Aliases resolve to a concrete snapshot only after claude's system.init, so we
// can't know their effort options up front; offer the full set.
const ALIAS_THINKING: ModelThinking = { type: 'effort', options: [...EFFORT_LEVELS], default: null };
const ALIAS_MODELS: ModelEntry[] = [
  { id: 'opus', name: 'Opus (latest)', section: 'alias', description: 'Auto-upgrades to the newest Opus', thinking: ALIAS_THINKING },
  { id: 'sonnet', name: 'Sonnet (latest)', section: 'alias', description: 'Auto-upgrades to the newest Sonnet', thinking: ALIAS_THINKING },
  { id: 'haiku', name: 'Haiku (latest)', section: 'alias', description: 'Auto-upgrades to the newest Haiku', thinking: ALIAS_THINKING },
  { id: 'fable', name: 'Fable (latest)', section: 'alias', description: 'Auto-upgrades to the newest Fable', thinking: ALIAS_THINKING },
];

function catalogUrl(): string {
  return process.env.CLAUDE_CODE_MODEL_CATALOG_URL || DEFAULT_CATALOG_URL;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function fetchCatalog(): Promise<void> {
  try {
    const res = await fetch(catalogUrl());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Catalog;
    state.catalog = json;
    state.fetchedAt = Date.now();
    state.fetchError = null;
  } catch (e: any) {
    state.fetchError = e?.message || String(e);
  }
}

async function detectCliVersion(): Promise<void> {
  try {
    const { stdout } = await execFileP('claude', ['--version'], { timeout: 5000 });
    const m = stdout.match(/(\d+\.\d+\.\d+)/);
    state.cliVersion = m ? m[1] : null;
    state.cliError = state.cliVersion ? null : `unrecognized output: ${stdout.trim()}`;
  } catch (e: any) {
    state.cliError = e?.message || String(e);
    state.cliVersion = null;
  }
}

function extractModels(): ModelEntry[] {
  const cc = state.catalog?.surfaces?.cc;
  const raw = cc?.model_selector_config?.[0]?.models;
  if (!Array.isArray(raw)) return [];
  const defaults = new Map<string, string>();
  for (const t of cc?.model_selector_state?.[0]?.thinking_by_model ?? []) {
    if (t?.id && t.thinking?.effort) defaults.set(t.id, t.thinking.effort);
  }
  const cli = state.cliVersion;
  const out: ModelEntry[] = [];
  for (const m of raw) {
    if (!m?.id) continue;
    if (cli && m.min_claude_code_version && compareVersion(cli, m.min_claude_code_version) < 0) {
      continue;
    }
    const options = (m.thinking?.effort_options ?? []).map((o) => o.id).filter(Boolean);
    out.push({
      id: m.id,
      name: m.name || m.id,
      short_name: m.short_name,
      description: m.description,
      section: (m.section as ModelEntry['section']) || 'main',
      min_claude_code_version: m.min_claude_code_version,
      thinking: {
        type: m.thinking?.type || (options.length ? 'effort' : 'none'),
        options,
        default: defaults.get(m.id) ?? null,
      },
    });
  }
  return out;
}

export function initModelCatalog(): void {
  // Fire off both async probes; endpoint handlers will surface whatever is
  // ready. Alias-only degradation is acceptable if fetch fails.
  void fetchCatalog();
  void detectCliVersion();
  setInterval(() => {
    void fetchCatalog();
  }, REFRESH_MS).unref();
}

export function registerModelRoutes(app: FastifyInstance) {
  app.get('/api/models', async () => {
    // Lazy refresh if the endpoint is hit before init finished (shouldn't
    // happen in practice but keeps the response non-empty on cold start).
    if (!state.catalog && !state.fetchError) await fetchCatalog();
    if (!state.cliVersion && !state.cliError) await detectCliVersion();
    const models = extractModels();
    return {
      aliases: ALIAS_MODELS,
      models,
      cliVersion: state.cliVersion,
      catalogVersion: state.catalog?.version ?? null,
      catalogFetchedAt: state.fetchedAt || null,
      fetchError: state.fetchError,
      cliError: state.cliError,
    };
  });
}
