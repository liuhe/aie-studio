// Model: web.ObserveTab cost estimate. Anthropic API list prices in USD per
// million tokens, cached 2026-10-06 from the claude-api skill (design §1.5).
// Subscription (OAuth) usage is not billed this way — the number is a relative
// weight, not an invoice. Unknown models (Devin's gpt-*/swe-*) → null.
import type { GenerationAction, ObsConversation, ObsTurn, Tokens } from './observe';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// Longest-prefix match on the lowercased model id, so Devin's
// "claude-fable-5-1-medium" and "claude-opus-4-6-thinking" resolve too.
const PRICES: Array<[prefix: string, p: ModelPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  ['claude-opus-4', { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 }],
  ['claude-sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }],
  ['claude-haiku-5-5', { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 }],
  ['claude-haiku-4', { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 }],
];

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase();
  let best: [string, ModelPrice] | null = null;
  for (const row of PRICES) if (id.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  return best ? best[1] : null;
}

export interface CostEstimate {
  usd: number;
  /** cache_write had no TTL split, so the 1h price was assumed (Claude Code's default) */
  assumedTtl: boolean;
}

/** List-price cost of one generation; null when the model is unknown. */
export function estimateCost(tokens: Tokens, model: string | null | undefined): CostEstimate | null {
  const p = priceFor(model);
  if (!p) return null;
  const M = 1_000_000;
  let usd = ((tokens.input ?? 0) * p.input + (tokens.cache_read ?? 0) * p.cacheRead + (tokens.output ?? 0) * p.output) / M;
  let assumedTtl = false;
  if (tokens.cache_write_5m != null || tokens.cache_write_1h != null) {
    usd += ((tokens.cache_write_5m ?? 0) * p.cacheWrite5m + (tokens.cache_write_1h ?? 0) * p.cacheWrite1h) / M;
  } else if (tokens.cache_write) {
    usd += (tokens.cache_write * p.cacheWrite1h) / M;
    assumedTtl = true;
  }
  return { usd, assumedTtl };
}

export function generationCost(g: GenerationAction): CostEstimate | null {
  return estimateCost(g.result.tokens, g.payload.model);
}

export interface TurnCost {
  /** own generations + every conversation spawned from this turn (recursive); null when nothing was priced */
  usd: number | null;
  assumedTtl: boolean;
  /** generations skipped because the model has no list price (own + spawned) */
  unpriced: number;
  /** share of `usd` that came from spawned conversations; null when none was priced */
  subUsd: number | null;
  /** spawned conversations rolled in, grandchildren included */
  subagents: number;
}

function addCost(into: TurnCost, c: TurnCost): void {
  if (c.usd != null) into.usd = (into.usd ?? 0) + c.usd;
  if (c.assumedTtl) into.assumedTtl = true;
  into.unpriced += c.unpriced;
}

/**
 * List-price cost of one Turn (rule-353): its generations plus the full cost of
 * every conversation spawned by its tool_calls, found through
 * Conversation.parent back-pointers in `all`. `seen` guards against cycles.
 */
export function turnCost(turn: ObsTurn, all: ObsConversation[] = [], seen: Set<string> = new Set()): TurnCost {
  const t: TurnCost = { usd: null, assumedTtl: false, unpriced: 0, subUsd: null, subagents: 0 };
  for (const a of turn.actions) {
    if (a.type !== 'generation') continue;
    const c = generationCost(a);
    if (!c) { t.unpriced++; continue; }
    t.usd = (t.usd ?? 0) + c.usd;
    if (c.assumedTtl) t.assumedTtl = true;
  }
  for (const child of all) {
    const p = child.parent;
    if (!p || !turn.actions.some((a) => a.id === p.action_id && a.type === 'tool_call')) continue;
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const c = conversationCost(child, all, seen);
    addCost(t, c);
    if (c.usd != null) t.subUsd = (t.subUsd ?? 0) + c.usd;
    t.subagents += 1 + c.subagents;
  }
  return t;
}

/** Sum of turnCost over a conversation's turns, so it includes spawned conversations too. */
export function conversationCost(conv: ObsConversation, all: ObsConversation[] = [], seen: Set<string> = new Set([conv.id])): TurnCost {
  const t: TurnCost = { usd: null, assumedTtl: false, unpriced: 0, subUsd: null, subagents: 0 };
  for (const turn of conv.turns) {
    const c = turnCost(turn, all, seen);
    addCost(t, c);
    if (c.subUsd != null) t.subUsd = (t.subUsd ?? 0) + c.subUsd;
    t.subagents += c.subagents;
  }
  return t;
}

/** "≈$1.23~ (+1 unpriced, incl. 2 subagents $0.40)" — shared by the Turn row and the overview chip. */
export function fmtCost(c: TurnCost): string | null {
  if (c.usd == null) return null;
  const notes: string[] = [];
  if (c.unpriced) notes.push(`+${c.unpriced} unpriced`);
  if (c.subagents) notes.push(`incl. ${c.subagents} subagent${c.subagents > 1 ? 's' : ''}${c.subUsd != null ? ` ${fmtUsd(c.subUsd)}` : ''}`);
  return `≈${fmtUsd(c.usd)}${c.assumedTtl ? '~' : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

export function costTitle(c: TurnCost, scope: string): string {
  return `Anthropic list-price estimate for ${scope} (design §1.5). Subscription usage is not billed per token — read it as relative weight.` +
    (c.subagents ? ` Includes ${c.subagents} spawned conversation(s).` : '') +
    (c.assumedTtl ? ' ~ = cache writes had no TTL split, 1h price assumed.' : '') +
    (c.unpriced ? ` ${c.unpriced} generation(s) on an unpriced model were skipped.` : '');
}

export function fmtUsd(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
