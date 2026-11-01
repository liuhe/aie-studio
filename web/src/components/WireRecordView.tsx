// Model: web.ObserveTab (rule-358 / rule-359) → server.ServeWireRecord.
// On-demand viewer for one raw wire record: the request as sent (headers,
// params, system blocks, tool definitions, every message block with its cache
// breakpoint) and the response as received (headers, content blocks rebuilt
// from the SSE stream, the event list). Fetched only when the user asks.
import { useEffect, useState, type ReactNode } from 'react';
import { getWireRecord, wireRecordUrl } from '../api';
import {
  blockText,
  contentBlocks,
  fmtBytes,
  fmtMs,
  fmtSec,
  fmtTokens,
  sseBlocks,
  sseEventSummary,
  truncate,
  WIRE_GLOSSARY,
  type SseEvent,
  type WireRecord,
  type WireTerm,
} from '../lib/observe';

type View = 'request' | 'response';
type Dict = Record<string, any>;
const asDict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});

/**
 * A term with its glossary explanation. Hover shows it on pointer devices;
 * click / tap toggles it (native title tooltips never show on touch and need a
 * 1s hover on desktop). The click is swallowed so a Term inside a <summary> or
 * a card head does not toggle its parent.
 */
export function Term({ k, children }: { k: WireTerm; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`observe-term ${open ? 'observe-term-open' : ''}`}>
      <button
        type="button"
        className="observe-term-btn"
        aria-label={`what is ${k}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
      >
        {children ?? k}
      </button>
      <span className="observe-tip" role="tooltip">
        <b>{k}</b> {WIRE_GLOSSARY[k]}
      </span>
    </span>
  );
}

/** Flat key / value table; nested values are shown as compact JSON. */
export function KvTable({ obj, title }: { obj: Record<string, unknown> | null | undefined; title?: string }) {
  const entries = Object.entries(obj ?? {});
  if (!entries.length) return <div className="observe-muted">{title ? `${title}: ` : ''}(empty)</div>;
  return (
    <table className="observe-table">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>
              <code>{v == null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function bpTtl(b: Dict): string | null {
  const cc = b.cache_control;
  return cc && typeof cc === 'object' ? String(cc.ttl ?? '5m') : null;
}

function Bp({ ttl }: { ttl: string | null }) {
  return ttl ? (
    <span className="observe-badge observe-badge-wire" title={`cache_control breakpoint, ttl ${ttl}: the prompt prefix up to and including this block is cached for ${ttl}`}>
      bp @{ttl}
    </span>
  ) : null;
}

function Block({ label, meta, text, open }: { label: ReactNode; meta?: ReactNode; text: string; open?: boolean }) {
  return (
    <details className="observe-block" open={open}>
      <summary>
        <span className="observe-block-label">{label}</span>
        <span className="observe-block-meta">{meta}</span>
      </summary>
      <pre className="observe-text observe-text-tall">{text || '(empty)'}</pre>
    </details>
  );
}

function RequestView({ rec }: { rec: WireRecord }) {
  const body = asDict(rec.req_body);
  const system = body.system;
  const systemBlocks: Dict[] = Array.isArray(system) ? system.map(asDict) : typeof system === 'string' ? [{ type: 'text', text: system }] : [];
  const tools: Dict[] = Array.isArray(body.tools) ? body.tools.map(asDict) : [];
  const messages: Dict[] = Array.isArray(body.messages) ? body.messages.map(asDict) : [];
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!['system', 'tools', 'messages'].includes(k)) rest[k] = v;
  const bodyIsText = typeof rec.req_body === 'string';
  return (
    <div className="observe-wire-view">
      <div className="observe-kv">
        <span>line</span>
        <code>
          {rec.method} {rec.path} · <Term k="req_bytes">{fmtBytes(rec.req_bytes)}</Term> · {body.model ?? ''}
        </code>
      </div>
      <details>
        <summary>request headers ({Object.keys(rec.req_headers ?? {}).length}) — credentials redacted at capture time</summary>
        <KvTable obj={rec.req_headers} />
      </details>
      {bodyIsText ? (
        <pre className="observe-text observe-text-tall">{String(rec.req_body)}</pre>
      ) : (
        <>
          <details open>
            <summary>
              <Term k="params">body params</Term> ({Object.keys(rest).length})
            </summary>
            <KvTable obj={rest} />
          </details>
          <details open>
            <summary>
              <Term k="system">system</Term> · {systemBlocks.length} block(s) · {fmtTokens(systemBlocks.reduce((n, b) => n + (typeof b.text === 'string' ? b.text.length : 0), 0))} chars
            </summary>
            {systemBlocks.map((b, i) => (
              <Block key={i} label={`system[${i}]`} meta={<><span>{fmtTokens(typeof b.text === 'string' ? b.text.length : 0)} chars</span><Bp ttl={bpTtl(b)} /></>} text={blockText(b)} />
            ))}
          </details>
          <details>
            <summary>
              <Term k="tools">tools</Term> · {tools.length} definition(s) · {fmtTokens(tools.length ? JSON.stringify(tools).length : 0)} chars
            </summary>
            {tools.map((t, i) => (
              <Block
                key={i}
                label={String(t.name ?? `tools[${i}]`)}
                meta={<><span>{t.type ? `${t.type} · ` : ''}{fmtTokens(typeof t.description === 'string' ? t.description.length : 0)} chars</span><Bp ttl={bpTtl(t)} /></>}
                text={`${typeof t.description === 'string' ? t.description : ''}\n\n— input_schema —\n${JSON.stringify(t.input_schema ?? {}, null, 2)}`}
              />
            ))}
          </details>
          <details open>
            <summary>
              <Term k="messages">messages</Term> · {messages.length}
            </summary>
            {messages.map((m, i) => {
              const blocks = contentBlocks(m.content);
              return (
                <div key={i} className={`observe-msg observe-msg-${String(m.role)}`}>
                  <div className="observe-msg-head">
                    <code>messages[{i}]</code> <span className="observe-badge">{String(m.role)}</span> <span className="observe-muted">{blocks.length} block(s)</span>
                  </div>
                  {blocks.map((b, j) => {
                    const text = blockText(b);
                    const label = `.${j} ${b.type}${b.type === 'tool_use' ? ` ${b.name ?? ''}` : ''}`;
                    const meta = (
                      <>
                        {b.type === 'tool_result' && <code className="observe-muted">{truncate(String(b.tool_use_id ?? ''), 24)}</code>}
                        {b.type === 'tool_use' && <code className="observe-muted">{truncate(String(b.id ?? ''), 24)}</code>}
                        {b.is_error && <span className="observe-badge observe-badge-warn">is_error</span>}
                        <span>{fmtTokens(text.length)} chars</span>
                        <Bp ttl={bpTtl(b)} />
                      </>
                    );
                    return <Block key={j} label={label} meta={meta} text={text} />;
                  })}
                </div>
              );
            })}
          </details>
        </>
      )}
    </div>
  );
}

const EVENT_PAGE = 200;

function ResponseView({ rec }: { rec: WireRecord }) {
  const events = rec.sse_events ?? [];
  const blocks = sseBlocks(events);
  const [limit, setLimit] = useState(EVENT_PAGE);
  const ratelimit: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec.resp_headers ?? {})) {
    if (k.toLowerCase().startsWith('anthropic-ratelimit-unified-')) ratelimit[k.slice('anthropic-ratelimit-unified-'.length)] = v;
    else headers[k] = v;
  }
  const firstText = events.find((e) => asDict(e.data).type === 'content_block_delta' && asDict(asDict(e.data).delta).type === 'text_delta');
  return (
    <div className="observe-wire-view">
      <div className="observe-kv">
        <span>line</span>
        <code>
          <Term k="status">HTTP {rec.status ?? '–'}</Term> · <Term k="ttfb">ttfb {fmtMs(rec.ttfb_ms)}</Term> · <Term k="ttft">ttft {firstText ? fmtMs(Math.round(firstText.t * 1000)) : '–'}</Term> · <Term k="total">total {fmtMs(rec.total_ms)}</Term> · <Term k="sse">{events.length} sse events</Term>
          {rec.upstream_error ? ` · upstream_error ${rec.upstream_error}` : ''}
          {rec.client_disconnected ? ' · client disconnected' : ''}
        </code>
      </div>
      <details>
        <summary>response headers ({Object.keys(headers).length})</summary>
        <KvTable obj={headers} />
      </details>
      <details>
        <summary>
          <Term k="ratelimit">ratelimit</Term> ({Object.keys(ratelimit).length})
        </summary>
        <KvTable obj={ratelimit} />
      </details>
      {rec.resp_body != null && (
        <details open>
          <summary>response body (non-stream)</summary>
          <pre className="observe-text observe-text-tall">{typeof rec.resp_body === 'string' ? rec.resp_body : JSON.stringify(rec.resp_body, null, 2)}</pre>
        </details>
      )}
      {blocks.length > 0 && (
        <details open>
          <summary>content blocks rebuilt from the stream · {blocks.length}</summary>
          {blocks.map((b) => (
            <Block
              key={b.index}
              label={`#${b.index} ${b.type}${b.name ? ` ${b.name}` : ''}`}
              meta={<span>{fmtTokens(b.text.length)} chars · {b.deltas} delta(s) · {fmtSec(b.t_start)} → {fmtSec(b.t_end)}</span>}
              text={b.text}
              open={b.type !== 'thinking'}
            />
          ))}
        </details>
      )}
      {events.length > 0 && (
        <details>
          <summary>
            <Term k="sse">sse events</Term> · {events.length} · t = seconds since the request was sent
          </summary>
          <table className="observe-table observe-events">
            <thead>
              <tr><th>t</th><th>event</th><th>summary</th></tr>
            </thead>
            <tbody>
              {events.slice(0, limit).map((ev, i) => <EventRow key={i} ev={ev} />)}
            </tbody>
          </table>
          {events.length > limit && (
            <button type="button" className="observe-link" onClick={() => setLimit((n) => n + EVENT_PAGE)}>
              show {Math.min(EVENT_PAGE, events.length - limit)} more of {events.length - limit} remaining
            </button>
          )}
        </details>
      )}
    </div>
  );
}

function EventRow({ ev }: { ev: SseEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="observe-event" onClick={() => setOpen((v) => !v)}>
        <td><code>{fmtSec(ev.t)}</code></td>
        <td><code>{ev.event ?? asDict(ev.data).type ?? '?'}</code></td>
        <td className="observe-event-summary">{sseEventSummary(ev)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>
            <pre className="observe-text">{JSON.stringify(ev.data, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

export function WireRecordView({ projectId, sid, wireKey }: { projectId: string; sid: string; wireKey: string }) {
  const [view, setView] = useState<View | null>(null);
  const [rec, setRec] = useState<WireRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch once per key, the first time either view is asked for. The gate is
  // `wanted`, not `loading` / `rec`: a state the effect itself sets must not be
  // a dependency, or the re-run's cleanup cancels the fetch it just started.
  const [wanted, setWanted] = useState(false);
  // Click the active button again to hide the view (the record stays cached).
  const pick = (v: View) => {
    setView((cur) => (cur === v ? null : v));
    setWanted(true);
  };

  useEffect(() => {
    setRec(null);
    setError(null);
    setView(null);
    setWanted(false);
  }, [projectId, sid, wireKey]);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWireRecord(projectId, sid, wireKey)
      .then((r) => {
        if (!cancelled) setRec(r);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, projectId, sid, wireKey]);

  return (
    <div className="observe-wire-record">
      <div className="observe-badges">
        <span className="observe-muted">raw record:</span>
        <button type="button" className={`observe-link ${view === 'request' ? 'observe-link-active' : ''}`} onClick={() => pick('request')} title="The request body exactly as the client sent it: headers, params, system blocks, tool definitions, every message block">
          request
        </button>
        <button type="button" className={`observe-link ${view === 'response' ? 'observe-link-active' : ''}`} onClick={() => pick('response')} title="The response as received: headers, content blocks rebuilt from the SSE stream, every event with its timestamp">
          response
        </button>
        <a className="observe-link" href={wireRecordUrl(projectId, sid, wireKey)} target="_blank" rel="noreferrer" title="Open the stored JSON file (wire/1) in a new tab">
          raw json ↗
        </a>
        {loading && <span className="observe-muted">loading…</span>}
        {error && <span className="observe-badge observe-badge-warn">{error}</span>}
      </div>
      {rec && view === 'request' && <RequestView rec={rec} />}
      {rec && view === 'response' && <ResponseView rec={rec} />}
    </div>
  );
}
