import { useCallback, useEffect, useState } from 'react';
import { listAieAgents, listAieSkills, type AieAgent, type AieSkill } from './api';

export type AieScan = { skills: AieSkill[]; agents: AieAgent[] };
const EMPTY: AieScan = { skills: [], agents: [] };

// Module-level cache so every ChatPanel of the same project shares one fetch
// and a newly opened tab shows the list instantly. `refresh()` re-fetches in
// the background (called when the picker opens) to pick up newly added skills.
const cache = new Map<string, AieScan>();
const inflight = new Map<string, Promise<AieScan>>();

function load(projectId: string): Promise<AieScan> {
  const pending = inflight.get(projectId);
  if (pending) return pending;
  const p = Promise.all([listAieSkills(projectId), listAieAgents(projectId)])
    .then(([skills, agents]) => {
      const scan = { skills, agents };
      cache.set(projectId, scan);
      return scan;
    })
    .finally(() => inflight.delete(projectId));
  inflight.set(projectId, p);
  return p;
}

// Project-scoped skills + agents from the AIE discovery API (.claude/ scan).
export function useAieCommands(projectId: string): AieScan & { refresh: () => void } {
  const [scan, setScan] = useState<AieScan>(() => cache.get(projectId) ?? EMPTY);
  const refresh = useCallback(() => {
    load(projectId).then(setScan).catch(() => {});
  }, [projectId]);
  useEffect(() => {
    setScan(cache.get(projectId) ?? EMPTY);
    refresh();
  }, [projectId, refresh]);
  return { ...scan, refresh };
}
