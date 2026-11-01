// Model: web.ObserveTab / page ObserveView. Read-only observation of one AI
// session rendered from the assembler's three-entity output (Conversation /
// Turn / Action). Polls server.AssembleObservation every 3s with the last ETag
// (304 = nothing changed) and pauses while the document is hidden.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getObservation } from '../api';
import type { TabRef } from '../types';
import { costTitle, fmtCost, fmtUsd, generationCost, turnCost } from '../lib/pricing';
import { KvTable, Term, WireRecordView } from './WireRecordView';
import {
  argsSummary,
  cacheDropIds,
  childrenByAction,
  conversationStats,
  durationMs,
  fmtMs,
  fmtPct,
  fmtTime,
  fmtTokens,
  latestRatelimit,
  seqIndex,
  TOKEN_KEYS,
  tokenSegments,
  turnRows,
  turnSeries,
  turnSummary,
  userInputText,
  wireKey,
  fmtBytes,
  type TurnPoint,
  type GenerationAction,
  type ObsAction,
  type ObsConversation,
  type ObsTurn,
  type ObservationResponse,
  type ToolCallAction,
  type UserInputAction,
  type WireRequestSummary,
  type WireResponseSummary,
} from '../lib/observe';

const POLL_MS = 3000;

/** Where to fetch raw wire records from (server.ServeWireRecord); null when the origin has no wire layer. */
const WireCtx = createContext<{ projectId: string; sid: string } | null>(null);

type Status = 'loading' | 'live' | 'paused' | 'error';

export function ObservePanel({ projectId, origin, onReveal }: { projectId: string; origin: TabRef; onReveal?: (anchor: string) => void }) {
  const [data, setData] = useState<ObservationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const etagRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await getObservation(projectId, origin.type, origin.key, force ? null : etagRef.current);
      if (r.status === 'ok') {
        etagRef.current = r.data.etag;
        setData(r.data);
        setError(null);
        setUpdatedAt(Date.now());
        setStatus('live');
      } else if (r.status === 'unchanged') {
        setStatus('live');
      } else {
        setError(
          r.code === 404
            ? 'Transcript not found yet — the session has not written anything, or it belongs to another project path.'
            : r.message,
        );
        setStatus('error');
      }
    } catch (e) {
      setError(String(e));
      setStatus('error');
    } finally {
      inFlight.current = false;
    }
  }, [projectId, origin.type, origin.key]);

  useEffect(() => {
    etagRef.current = null;
    setData(null);
    setStatus('loading');
    void refresh(true);
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void refresh(), POLL_MS);
      void refresh();
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        setStatus((s) => (s === 'error' ? s : 'paused'));
      } else start();
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  const root = data?.conversations.find((c) => c.parent === null) ?? data?.conversations[0] ?? null;

  return (
    <div className="observe">
      <div className="toolbar observe-toolbar">
        <span className="observe-toolbar-title">
          👁 {origin.type === 'devin' ? 'Devin' : 'Claude'} · <code>{origin.key.slice(0, 8)}</code>
        </span>
        <span className={`observe-status observe-status-${status}`} title={`Polling every ${POLL_MS / 1000}s with ETag`}>
          {status === 'live' ? '● live' : status === 'paused' ? '○ paused' : status === 'loading' ? '… loading' : '✗ error'}
        </span>
        {updatedAt && <span className="observe-muted">updated {fmtTime(new Date(updatedAt).toISOString())}</span>}
        <span className="observe-toolbar-spacer" />
        <button type="button" onClick={() => void refresh(true)} title="Re-fetch now">↻</button>
      </div>
      {error && <div className="observe-error">{error}</div>}
      <div className="observe-body">
        {!root && !error && <div className="observe-muted">Loading…</div>}
        {root && data && (
          <WireCtx.Provider value={origin.type === 'session' ? { projectId, sid: origin.key } : null}>
            <ConversationView conv={root} all={data.conversations} depth={0} onReveal={onReveal} />
          </WireCtx.Provider>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConversationView({ conv, all, depth, onReveal }: { conv: ObsConversation; all: ObsConversation[]; depth: number; onReveal?: (anchor: string) => void }) {
  const stats = useMemo(() => conversationStats(conv, all), [conv, all]);
  const series = useMemo(() => turnSeries(conv), [conv]);
  const quota = useMemo(() => latestRatelimit(conv), [conv]);
  const drops = useMemo(() => cacheDropIds(conv), [conv]);
  const children = useMemo(() => childrenByAction(all, conv.id), [all, conv.id]);
  // null = "auto": only the last Turn is open. Becomes a Set once the user toggles.
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const lastTurnId = conv.turns[conv.turns.length - 1]?.id;
  const isOpen = (t: ObsTurn) => (expanded ? expanded.has(t.id) : t.id === lastTurnId);
  const toggle = (t: ObsTurn) =>
    setExpanded((prev) => {
      const next = new Set(prev ?? (lastTurnId ? [lastTurnId] : []));
      if (next.has(t.id)) next.delete(t.id);
      else next.add(t.id);
      return next;
    });
  const openAll = (open: boolean) => setExpanded(open ? new Set(conv.turns.map((t) => t.id)) : new Set());

  return (
    <div className={`observe-conv observe-depth-${Math.min(depth, 3)}`}>
      <div className="observe-overview">
        <Chip label={conv.parent ? 'subagent' : conv.agent_type} value={conv.parent ? conv.subagent_type ?? conv.agent_type : conv.model ?? '–'} />
        {conv.parent && conv.model && <Chip label="model" value={conv.model} />}
        <Chip label="turns" value={String(stats.turns)} warn={stats.unfinishedTurns > 0} title={stats.unfinishedTurns ? `${stats.unfinishedTurns} without stop` : undefined} />
        <Chip label="gen" value={String(stats.generations)} />
        <Chip label="tools" value={String(stats.toolCalls)} />
        <Chip label="in / out" value={`${fmtTokens(stats.tokens.input)} / ${fmtTokens(stats.tokens.output)}`} />
        <Chip label="cache r / w" value={`${fmtTokens(stats.tokens.cacheRead)} / ${fmtTokens(stats.tokens.cacheWrite)}`} />
        <Chip label="hit" value={fmtPct(stats.cacheHitRate)} />
        {stats.cost.usd != null && <Chip label="cost" value={fmtCost(stats.cost)!} title={costTitle(stats.cost, 'this conversation')} />}
        {quota && (quota['5h-utilization'] || quota['7d-utilization']) && (
          <Chip label="quota" value={`5h ${fmtPct(Number(quota['5h-utilization']))} · 7d ${fmtPct(Number(quota['7d-utilization']))}`} title="anthropic-ratelimit-unified-*-utilization from the latest wire response: the subscription quota meter" />
        )}
        {stats.durationMs != null && <Chip label="span" value={fmtMs(stats.durationMs)} />}
        {stats.generationsWithWire > 0 && <Chip label="wire" value={`${stats.generationsWithWire}/${stats.generations}`} />}
        {conv.wire_orphans.length > 0 && <Chip label="wire orphans" value={String(conv.wire_orphans.length)} warn />}
        <Chip label="valid" value={stats.validationOk ? '✓' : `✗ ${conv.meta.validation?.issues.length ?? ''}`} warn={!stats.validationOk} />
        <span className="observe-toolbar-spacer" />
        <button type="button" className="observe-link" onClick={() => openAll(true)}>expand all</button>
        <button type="button" className="observe-link" onClick={() => openAll(false)}>collapse</button>
      </div>
      {conv.wire_orphans.length > 0 && <OrphanBar orphans={conv.wire_orphans} />}
      {series.length > 1 && <TurnChart series={series} onPick={(id) => setExpanded(new Set([id]))} />}
      <div className="observe-turns">
        {conv.turns.map((t) => (
          <TurnView key={t.id} turn={t} open={isOpen(t)} onToggle={() => toggle(t)} drops={drops} children={children} all={all} depth={depth} convModel={conv.model} onReveal={onReveal} />
        ))}
        {conv.turns.length === 0 && <div className="observe-muted">No turns yet.</div>}
      </div>
    </div>
  );
}

function Chip({ label, value, warn, title }: { label: string; value: string; warn?: boolean; title?: string }) {
  return (
    <span className={`observe-chip ${warn ? 'observe-chip-warn' : ''}`} title={title}>
      <span className="observe-chip-label">{label}</span>
      <span className="observe-chip-value">{value}</span>
    </span>
  );
}

function TurnView({
  turn, open, onToggle, drops, children, all, depth, convModel, onReveal,
}: {
  turn: ObsTurn; open: boolean; onToggle: () => void; drops: Set<string>;
  children: Map<string, ObsConversation>; all: ObsConversation[]; depth: number; convModel: string | null;
  onReveal?: (anchor: string) => void;
}) {
  const first = turn.actions[0];
  const kind = first?.type === 'user_input' ? first.payload.kind : null;
  const gens = turn.actions.filter((a) => a.type === 'generation').length;
  const tools = turn.actions.filter((a) => a.type === 'tool_call').length;
  const noStop = turn.stop_action_id === null;
  const seq = useMemo(() => seqIndex(turn), [turn]);
  const rows = useMemo(() => turnRows(turn), [turn]);
  const cost = useMemo(() => turnCost(turn, all), [turn, all]);
  return (
    <div className={`observe-turn ${noStop ? 'observe-turn-nostop' : ''}`}>
      <button type="button" className="observe-turn-head" onClick={onToggle}>
        <span className="observe-caret">{open ? '▾' : '▸'}</span>
        <span className="observe-turn-seq">T{turn.seq_no}</span>
        {kind && <span className={`observe-badge observe-badge-${kind}`}>{kind}</span>}
        <span className="observe-turn-summary">{turnSummary(turn) || <em>(empty)</em>}</span>
        <span className="observe-turn-meta">
          {gens} gen · {tools} tools · {fmtMs(durationMs(turn.started_at, turn.ended_at))}
          {cost.usd != null && <span className="observe-tok observe-tok-cost" title={costTitle(cost, 'this turn')}>{fmtCost(cost)}</span>}
          {noStop && <span className="observe-badge observe-badge-warn" title="Turn has no stop: interrupted, crashed or still running">no stop</span>}
        </span>
      </button>
      {open && (
        <div className="observe-actions">
          {rows.map((row) => (
            <div key={row[0].id} className={`observe-row ${row.length > 1 ? 'observe-row-parallel' : ''}`}>
              {row.map((a) => (
                <ActionCard key={a.id} action={a} seq={seq} drop={drops.has(a.id)} child={children.get(a.id)} all={all} depth={depth} convModel={convModel} onReveal={onReveal} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionCard({
  action, seq, drop, child, all, depth, convModel, onReveal,
}: {
  action: ObsAction; seq: Map<string, number>; drop: boolean; child?: ObsConversation;
  all: ObsConversation[]; depth: number; convModel: string | null; onReveal?: (anchor: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const inputs = action.inputs.map((i) => seq.get(i)).filter((n): n is number => n != null);
  const icon = action.type === 'user_input' ? '👤' : action.type === 'generation' ? '✦' : '🔧';
  const cls = `observe-card observe-card-${action.type} ${drop ? 'observe-card-drop' : ''} ${action.type === 'tool_call' && action.result?.status === 'error' ? 'observe-card-error' : ''}`;
  return (
    <div className={cls}>
      <button type="button" className="observe-card-head" onClick={() => setOpen((v) => !v)} title={open ? 'Collapse' : 'Expand'}>
        <span className="observe-card-seq">#{action.seq_no}</span>
        <span className="observe-card-type">{icon} {action.type}</span>
        {inputs.length > 0 && <span className="observe-card-inputs">← {inputs.map((n) => `#${n}`).join(' ')}</span>}
        {action.inputs.length > 0 && inputs.length === 0 && <span className="observe-card-inputs observe-badge-warn">← dangling</span>}
        <span className="observe-toolbar-spacer" />
        <span className="observe-card-time">{fmtTime(action.started_at)}</span>
      </button>
      {onReveal && action.ref && (
        <button type="button" className="observe-card-jump" title="Show this message in the session tab" onClick={() => onReveal(action.ref!)}>↗</button>
      )}
      {action.type === 'user_input' && <UserInputBody a={action} open={open} />}
      {action.type === 'generation' && <GenerationBody a={action} open={open} drop={drop} convModel={convModel} />}
      {action.type === 'tool_call' && <ToolCallBody a={action} open={open} child={child} all={all} depth={depth} onReveal={onReveal} />}
    </div>
  );
}

/** The per-generation wire summary (rule-358): every row explained on hover, tables instead of JSON blobs, raw record on demand. */
function WireSummary({ wq, w }: { wq: WireRequestSummary; w: WireResponseSummary }) {
  const ctx = useContext(WireCtx);
  const key = wireKey(w);
  return (
    <div className="observe-details">
      <div className="observe-kv">
        <span>request</span>
        <code>
          <Term k="req_bytes">{fmtBytes(wq.req_bytes)}</Term> · <Term k="messages">{wq.messages.count} messages</Term> · <Term k="system">{wq.system_blocks.length} system blocks ({wq.system_blocks.filter((b) => b.cached).length} cached)</Term> · <Term k="tools">{wq.tools.count} tools</Term>
          {wq.retry_count ? <> · <Term k="retry">retry {wq.retry_count}</Term></> : null}
        </code>
      </div>
      <div className="observe-kv">
        <span><Term k="bp">breakpoints</Term></span>
        <code>{wq.cache_breakpoints.map((b) => `${b.at}@${b.ttl}`).join(', ') || '–'}</code>
      </div>
      <div className="observe-kv">
        <span><Term k="params">params</Term></span>
        <KvTable obj={wq.params} />
      </div>
      <div className="observe-kv">
        <span><Term k="betas">betas</Term></span>
        <code>{wq.betas.join(', ') || '–'}</code>
      </div>
      <div className="observe-kv">
        <span>response</span>
        <code>
          <Term k="status">HTTP {w.status ?? '–'}</Term> · <Term k="ttfb">ttfb {fmtMs(w.ttfb_ms)}</Term>{w.ttft_ms != null ? <> · <Term k="ttft">ttft {fmtMs(w.ttft_ms)}</Term></> : null} · <Term k="total">total {fmtMs(w.total_ms)}</Term> · <Term k="sse">{w.sse_events} sse events</Term>
          {w.upstream_error ? ` · ${w.upstream_error}` : ''}
          {w.client_disconnected ? ' · client disconnected' : ''}
        </code>
      </div>
      {w.usage && (
        <div className="observe-kv">
          <span><Term k="usage">usage</Term></span>
          <KvTable obj={w.usage} />
        </div>
      )}
      {Object.keys(w.ratelimit).length > 0 && (
        <div className="observe-kv">
          <span><Term k="ratelimit">ratelimit</Term></span>
          <KvTable obj={w.ratelimit} />
        </div>
      )}
      {ctx && key && <WireRecordView projectId={ctx.projectId} sid={ctx.sid} wireKey={key} />}
    </div>
  );
}

function OrphanBar({ orphans }: { orphans: ObsConversation['wire_orphans'] }) {
  const ctx = useContext(WireCtx);
  return (
    <div className="observe-warnbar">
      <div>{orphans.length} wire record(s) matched no generation (failed, retried, count_tokens, or no request-id):</div>
      {orphans.map((o, i) => {
        const key = wireKey(o.response);
        return (
          <details key={i} className="observe-orphan">
            <summary>
              <code>{o.reason}{o.response.status ? ` ${o.response.status}` : ''}</code> {String(o.model ?? '')} {o.path ?? ''} {o.response.request_id ?? (o.response.seq != null ? `seq ${o.response.seq}` : '')}
            </summary>
            <WireSummary wq={o.request} w={o.response} />
            {!(ctx && key) && <div className="observe-muted">(no key to load the raw record)</div>}
          </details>
        );
      })}
    </div>
  );
}

function UserInputBody({ a, open }: { a: UserInputAction; open: boolean }) {
  const text = userInputText(a);
  return (
    <div className="observe-card-body">
      <div className="observe-badges">
        <span className={`observe-badge observe-badge-${a.payload.kind}`}>{a.payload.kind}</span>
        {a.payload.source === 'parent_agent' && <span className="observe-badge">from parent agent</span>}
        {a.payload.synthetic && <span className="observe-badge observe-badge-warn">synthetic</span>}
      </div>
      <pre className={`observe-text ${open ? '' : 'observe-clamp'}`}>{text || '(no text)'}</pre>
    </div>
  );
}

function GenerationBody({ a, open, drop, convModel }: { a: GenerationAction; open: boolean; drop: boolean; convModel: string | null }) {
  const t = a.result.tokens;
  const segs = tokenSegments(t);
  const w = a.result.wire;
  const wq = a.payload.wire;
  return (
    <div className="observe-card-body">
      <div className="observe-tokenbar" title={`output ${fmtTokens(t.output)} · cache write ${fmtTokens(t.cache_write)} · input ${fmtTokens(t.input)} · cache read ${fmtTokens(t.cache_read)} (most expensive first)`}>
        {segs.map((s) => (
          <span key={s.key} className={`observe-seg observe-seg-${s.key}`} style={{ width: `${Math.max(s.frac * 100, s.value > 0 ? 1 : 0)}%` }} />
        ))}
      </div>
      <div className="observe-badges observe-tokens">
        <span className="observe-tok observe-tok-output">out {fmtTokens(t.output)}</span>
        <span className="observe-tok observe-tok-cacheWrite">w {fmtTokens(t.cache_write)}</span>
        <span className="observe-tok observe-tok-input">in {fmtTokens(t.input)}</span>
        <span className="observe-tok observe-tok-cacheRead">r {fmtTokens(t.cache_read)}</span>
        {t.thinking ? <span className="observe-tok">think {fmtTokens(t.thinking)}</span> : null}
        {(() => {
          const c = generationCost(a);
          return c ? <span className="observe-tok observe-tok-cost" title={c.assumedTtl ? 'list price; cache write TTL assumed 1h' : 'list price'}>≈{fmtUsd(c.usd)}{c.assumedTtl ? '~' : ''}</span> : null;
        })()}
        {a.result.stop_reason && <span className={`observe-badge ${a.result.stop_reason === 'end_turn' ? 'observe-badge-ok' : ''}`}>{a.result.stop_reason}</span>}
        {a.payload.model && a.payload.model !== convModel && <span className="observe-badge">{a.payload.model}</span>}
        {a.payload.effort && <span className="observe-badge">effort {a.payload.effort}</span>}
        {drop && <span className="observe-badge observe-badge-warn" title="cache_read dropped to 0 after a cached generation: the prompt prefix was rebuilt">cache miss</span>}
        {a.result.timing && !w && (a.result.timing.ttft_ms != null || a.result.timing.total_ms != null) && (
          <span className="observe-badge" title="From the agent's own log">
            {a.result.timing.ttft_ms != null ? `ttft ${fmtMs(a.result.timing.ttft_ms)} · ` : ''}total {fmtMs(a.result.timing.total_ms)}
          </span>
        )}
        {w && (
          <>
            <span className="observe-badge observe-badge-wire"><Term k="ttfb">ttfb {fmtMs(w.ttfb_ms)}</Term></span>
            {w.ttft_ms != null && <span className="observe-badge observe-badge-wire"><Term k="ttft">ttft {fmtMs(w.ttft_ms)}</Term></span>}
            {wq && (
              <span className="observe-badge observe-badge-wire">
                <Term k="tools">{wq.tools.count} tools</Term> · <Term k="bp">{wq.cache_breakpoints.length} bp</Term>
                {wq.retry_count ? <> · <Term k="retry">retry {wq.retry_count}</Term></> : null}
              </span>
            )}
            {w.status && w.status !== 200 && <span className="observe-badge observe-badge-warn">HTTP {w.status}</span>}
          </>
        )}
      </div>
      {!open && a.result.output_text && <pre className="observe-text observe-clamp">{a.result.output_text.inline_text}</pre>}
      {open && (
        <div className="observe-details">
          {a.result.thinking && (
            <details>
              <summary>thinking ({fmtTokens(a.result.thinking.length)} chars)</summary>
              <pre className="observe-text">{a.result.thinking.inline_text}</pre>
            </details>
          )}
          {a.result.output_text ? <pre className="observe-text">{a.result.output_text.inline_text}</pre> : <div className="observe-muted">(no text output)</div>}
          {a.payload.request_id && <div className="observe-kv"><span>request_id</span><code>{a.payload.request_id}</code></div>}
          {wq && w && (
            <details>
              <summary>wire</summary>
              <WireSummary wq={wq} w={w} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallBody({ a, open, child, all, depth, onReveal }: { a: ToolCallAction; open: boolean; child?: ObsConversation; all: ObsConversation[]; depth: number; onReveal?: (anchor: string) => void }) {
  const [showChild, setShowChild] = useState(false);
  const r = a.result;
  const status = r?.status ?? 'pending';
  return (
    <div className="observe-card-body">
      <div className="observe-tool-line">
        <span className="observe-tool-name">{a.payload.name ?? '?'}</span>
        {a.payload.kind && <span className="observe-badge">{a.payload.kind}</span>}
        <code className="observe-tool-args" title={a.payload.title ?? undefined}>{a.payload.title ?? argsSummary(a.payload.args)}</code>
      </div>
      <div className="observe-badges">
        <span className={`observe-badge observe-badge-${status === 'success' ? 'ok' : status === 'error' ? 'warn' : 'pending'}`}>{status}</span>
        {r?.latency_ms != null && <span className="observe-badge">{fmtMs(r.latency_ms)}</span>}
        {r?.content && <span className="observe-muted">{fmtTokens(r.content.length)} chars</span>}
        {child && (
          <button type="button" className="observe-link" onClick={() => setShowChild((v) => !v)}>
            {showChild ? '▾' : '▸'} subagent {child.subagent_type ?? child.agent_type} · {child.turns.length} turn(s)
          </button>
        )}
        {!child && r?.spawned_conversation_id && <span className="observe-badge">spawned {r.spawned_conversation_id}</span>}
      </div>
      {open && (
        <div className="observe-details">
          {a.payload.args && (
            <details open>
              <summary>args</summary>
              <pre className="observe-text">{prettyJson(a.payload.args.inline_text)}</pre>
            </details>
          )}
          {r?.content ? (
            <details open>
              <summary>result</summary>
              <pre className="observe-text">{r.content.inline_text}</pre>
            </details>
          ) : (
            <div className="observe-muted">(no result yet)</div>
          )}
        </div>
      )}
      {child && showChild && <ConversationView conv={child} all={all} depth={depth + 1} onReveal={onReveal} />}
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Per-turn chart (dataviz: stacked bars for magnitude, one axis per row,
// categorical slots in fixed order, 2px gaps, 4px rounded data ends, hover
// tooltip per mark, legend for the 4 series, the Turn list below is the table).
// ---------------------------------------------------------------------------

const BAR_W = 14;
const BAR_GAP = 6;
const TOKENS_H = 64;
const RATE_H = 28;
// Stacked bottom → top in TOKEN_KEYS order: output (most expensive) at the
// baseline, cache read (cheapest) on top. The legend lists top → bottom.
const KEYS = TOKEN_KEYS;

function TurnChart({ series, onPick }: { series: TurnPoint[]; onPick: (turnId: string) => void }) {
  const max = Math.max(1, ...series.map((p) => p.cacheRead + p.cacheWrite + p.input + p.output));
  const width = series.length * (BAR_W + BAR_GAP) + BAR_GAP;
  const x = (i: number) => BAR_GAP + i * (BAR_W + BAR_GAP);
  return (
    <div className="observe-chart" role="img" aria-label="Tokens per turn and cache hit rate per turn">
      <div className="observe-chart-scroll">
        <svg width={width} height={TOKENS_H + 6} className="observe-chart-svg">
          <line x1={0} x2={width} y1={TOKENS_H + 0.5} y2={TOKENS_H + 0.5} className="observe-axis" />
          {series.map((p, i) => {
            const total = p.cacheRead + p.cacheWrite + p.input + p.output;
            let y = TOKENS_H;
            const segs = KEYS.map(({ key }) => {
              const h = total ? ((p[key] / max) * TOKENS_H) : 0;
              y -= h;
              return { key, h, y };
            });
            const tip = `T${p.seq} · ${p.generations} gen · read ${fmtTokens(p.cacheRead)} · write ${fmtTokens(p.cacheWrite)} · in ${fmtTokens(p.input)} · out ${fmtTokens(p.output)}${p.hitRate != null ? ` · hit ${fmtPct(p.hitRate)}` : ''}${p.noStop ? ' · no stop' : ''}`;
            return (
              <g key={p.id} className="observe-bar" onClick={() => onPick(p.id)} tabIndex={0}>
                <title>{tip}</title>
                <rect x={x(i) - BAR_GAP / 2} y={0} width={BAR_W + BAR_GAP} height={TOKENS_H + 6} className="observe-bar-hit" />
                {segs.map((s2, k) => s2.h > 0 && (
                  <rect key={s2.key} x={x(i)} y={s2.y + (k < segs.length - 1 ? 1 : 0)} width={BAR_W} height={Math.max(0, s2.h - (k < segs.length - 1 ? 2 : 0))} rx={k === segs.length - 1 ? 0 : 0} className={`observe-seg-${s2.key}`} />
                ))}
                {p.noStop && <text x={x(i) + BAR_W / 2} y={TOKENS_H + 6} textAnchor="middle" className="observe-bar-warn">⚠</text>}
              </g>
            );
          })}
        </svg>
        <svg width={width} height={RATE_H + 4} className="observe-chart-svg">
          <line x1={0} x2={width} y1={RATE_H + 0.5} y2={RATE_H + 0.5} className="observe-axis" />
          <polyline
            className="observe-rate-line"
            points={series.filter((p) => p.hitRate != null).map((p) => `${x(series.indexOf(p)) + BAR_W / 2},${RATE_H - p.hitRate! * (RATE_H - 4) + 2}`).join(' ')}
          />
          {series.map((p, i) => p.hitRate != null && (
            <circle key={p.id} cx={x(i) + BAR_W / 2} cy={RATE_H - p.hitRate * (RATE_H - 4) + 2} r={4} className="observe-rate-dot" onClick={() => onPick(p.id)}>
              <title>{`T${p.seq} cache hit ${fmtPct(p.hitRate)}`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="observe-chart-legend">
        {[...KEYS].reverse().map((k) => (
          <span key={k.key}><i className={`observe-swatch observe-seg-${k.key}`} />{k.label}</span>
        ))}
        <span><i className="observe-swatch observe-rate-swatch" />cache hit rate</span>
        <span className="observe-muted">click a bar to open that turn</span>
      </div>
    </div>
  );
}
