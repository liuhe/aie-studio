import { useEffect, useState } from 'react';
import { listClaudeModels, type ClaudeModel } from './api';

// Alias fallback shown when the catalog fetch fails. The claude CLI accepts
// these as first-class model ids and resolves them to the latest snapshot,
// so an alias-only UI still works.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const ALIAS_THINKING = { type: 'effort', options: [...EFFORT_LEVELS], default: null };
const FALLBACK_ALIASES: ClaudeModel[] = [
  { id: 'opus', name: 'Opus (latest)', section: 'alias', description: 'Auto-upgrades to the newest Opus', thinking: ALIAS_THINKING },
  { id: 'sonnet', name: 'Sonnet (latest)', section: 'alias', description: 'Auto-upgrades to the newest Sonnet', thinking: ALIAS_THINKING },
  { id: 'haiku', name: 'Haiku (latest)', section: 'alias', description: 'Auto-upgrades to the newest Haiku', thinking: ALIAS_THINKING },
  { id: 'fable', name: 'Fable (latest)', section: 'alias', description: 'Auto-upgrades to the newest Fable', thinking: ALIAS_THINKING },
];

// Resolve the effort options for whatever id the status bar currently shows.
// Aliases and unknown ids (e.g. before the catalog loads) get the full set;
// `[1m]` context suffixes are stripped before lookup.
export function effortOptionsFor(models: ClaudeModel[], modelId: string | null): { supported: boolean; options: string[]; default: string | null } {
  const bare = (modelId ?? '').replace(/\[1m\]$/, '');
  const m = models.find((x) => x.id === bare);
  if (!m) return { supported: true, options: [...EFFORT_LEVELS], default: null };
  if (m.thinking.type === 'none' || m.thinking.options.length === 0) {
    return { supported: false, options: [], default: null };
  }
  return { supported: true, options: m.thinking.options, default: m.thinking.default };
}

export type ClaudeModelsState = {
  loading: boolean;
  aliases: ClaudeModel[];
  models: ClaudeModel[];
  cliVersion: string | null;
  error: string | null;
};

let cached: ClaudeModelsState | null = null;
let inFlight: Promise<ClaudeModelsState> | null = null;

async function loadOnce(): Promise<ClaudeModelsState> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const r = await listClaudeModels();
      cached = {
        loading: false,
        aliases: r.aliases?.length ? r.aliases : FALLBACK_ALIASES,
        models: r.models ?? [],
        cliVersion: r.cliVersion,
        error: r.fetchError || null,
      };
    } catch (e: any) {
      cached = {
        loading: false,
        aliases: FALLBACK_ALIASES,
        models: [],
        cliVersion: null,
        error: e?.message || String(e),
      };
    }
    inFlight = null;
    return cached;
  })();
  return inFlight;
}

export function useClaudeModels(): ClaudeModelsState {
  const [state, setState] = useState<ClaudeModelsState>(
    cached ?? { loading: true, aliases: FALLBACK_ALIASES, models: [], cliVersion: null, error: null }
  );
  useEffect(() => {
    let alive = true;
    loadOnce().then((s) => {
      if (alive) setState(s);
    });
    return () => { alive = false; };
  }, []);
  return state;
}
