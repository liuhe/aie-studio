import { BookmarkButton, bookmarkLabel, flashMessage, sleep } from './BookmarkButton';
import { RichCopyButton, RichCopySheet } from './RichCopyEditor';
import { useIsDesktop } from '../useIsDesktop';
import type { MessageLocator } from '../registry/tabRegistry';
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SendKey, Theme } from '../types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { ExportMessage } from '../lib/export/types';
import { makeRelPath } from '../lib/relPath';
import { MarkdownLink } from './MarkdownLink';
import { ChatInput } from './ChatInput';
import { useAieCommands } from '../useAieCommands';
import { toCommandItems } from '../lib/commandPicker';
import type { ClaudeCliCatalog } from '../lib/claudeCatalog';
import { useClaudeModels, effortOptionsFor } from '../useClaudeModels';

// Lazy: the export pipeline (dialog, view, markdown serialiser) is only needed
// when the user actually clicks ⤓. Splitting it out shaves the main bundle.
const ExportDialog = lazy(() =>
  import('./ExportDialog').then((m) => ({ default: m.ExportDialog })),
);

// Links follow web.OpenChatLink: external URLs → new browser window,
// in-project paths → file Tab (onOpenFile), the rest → inert text.
const MarkdownText = memo(function MarkdownText({ text, theme, projectPath, onOpenFile }: {
  text: string;
  theme: Theme;
  projectPath?: string;
  onOpenFile?: (relPath: string) => void;
}) {
  const style = theme === 'light' ? oneLight : vscDarkPlus;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) {
          return <MarkdownLink {...props} projectPath={projectPath} onOpenFile={onOpenFile} />;
        },
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!match) return <code className={className} {...props}>{children}</code>;
          return (
            <SyntaxHighlighter
              PreTag="div"
              language={match[1]}
              style={style as any}
              customStyle={{ margin: '4px 0', borderRadius: 4, fontSize: 11, padding: '6px 8px' }}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

function ToolFields({ input, rel }: { input: any; rel: (s: string) => string }) {
  if (!input || typeof input !== 'object') {
    return <pre className="tool-field-value">{rel(String(input))}</pre>;
  }
  return (
    <>
      {Object.entries(input).map(([k, v]) => (
        <div key={k} className="tool-field">
          <div className="tool-field-key">{k}</div>
          <pre className="tool-field-value">
            {typeof v === 'string' ? rel(v) : rel(JSON.stringify(v, null, 2))}
          </pre>
        </div>
      ))}
    </>
  );
}

function summarizeTool(name: string, input: any, rel: (s: string) => string): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Read':
      return rel(input.file_path ?? input.notebook_path ?? '');
    case 'Bash': {
      const cmd: string = rel(input.command ?? '');
      const first = cmd.split('\n')[0];
      const desc = input.description ? ` — ${input.description}` : '';
      return (first.length > 80 ? first.slice(0, 80) + '…' : first) + desc;
    }
    case 'Grep':
      return `"${input.pattern ?? ''}"${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob':
      return input.pattern ?? '';
    case 'Task':
      return input.subagent_type ? `[${input.subagent_type}] ${input.description ?? ''}` : (input.description ?? '');
    case 'WebFetch':
      return input.url ?? '';
    case 'WebSearch':
      return input.query ?? '';
    case 'TodoWrite':
      return `${(input.todos ?? []).length} todos`;
    default: {
      const k = Object.keys(input)[0];
      if (!k) return '';
      const v = input[k];
      if (typeof v === 'string') {
        const s = rel(v);
        return `${k}: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
      }
      return k;
    }
  }
}

type Msg =
  | { id: string; role: 'user'; text: string; images?: string[]; uuid?: string }
  // uuid / blockIdx: the JSONL record this text block came from — the
  // bookmark anchor (model: Pin.anchor = a:<uuid>:<blockIdx>).
  | { id: string; role: 'assistant'; text: string; uuid?: string; blockIdx?: number }
  | { id: string; role: 'system'; text: string }
  | { id: string; role: 'tool'; name: string; input: any; toolUseId?: string; output?: string };

// Stable per-message anchor for bookmarks (model: entity Pin.anchor). null
// while the message has no persisted identity yet: a just-sent user message
// before user_uuid arrives, or a streamed assistant block before the complete
// `assistant` event echoes its uuid. Messages without an anchor show no ☆.
function msgAnchor(m: Msg): string | null {
  if (m.role === 'user') return m.uuid ? `u:${m.uuid}` : null;
  if (m.role === 'assistant') return m.uuid ? `a:${m.uuid}:${m.blockIdx ?? 0}` : null;
  if (m.role === 'tool') return m.toolUseId ? `t:${m.toolUseId}` : null;
  return null;
}

type PendingImage = { id: string; dataUrl: string; mediaType: string; base64: string };

type Status = 'connecting' | 'replaying' | 'ready' | 'thinking' | 'reconnecting' | 'closed';

function shortId() { return Math.random().toString(36).slice(2, 9); }

// Mid-session model list is loaded dynamically from /api/models, which pulls
// Anthropic's signed catalog and filters by the local claude CLI's version.
// See projects/model-catalog/overview.md.

function sendKeyHint(k: SendKey): string {
  switch (k) {
    case 'cmd-enter': return 'Ask Claude… (⌘/Ctrl+Enter to send)';
    case 'shift-enter': return 'Ask Claude… (Shift+Enter to send)';
    case 'enter': return 'Ask Claude… (Enter to send)';
  }
}

// Pure: convert a single claude stream-json / JSONL event into Msg deltas.
// Returns either a list of new messages, or a tool_result patch by toolUseId.
function renderEvent(ev: any): Array<{ kind: 'append'; msg: Msg } | { kind: 'tool_result'; toolUseId: string; output: string }> {
  const out: Array<{ kind: 'append'; msg: Msg } | { kind: 'tool_result'; toolUseId: string; output: string }> = [];
  if (ev?.type === 'assistant' && ev.message) {
    const uuid = typeof ev.uuid === 'string' ? ev.uuid : undefined;
    (ev.message.content || []).forEach((block: any, blockIdx: number) => {
      if (block.type === 'text') {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'assistant', text: block.text, uuid, blockIdx } });
      } else if (block.type === 'tool_use') {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'tool', name: block.name, input: block.input, toolUseId: block.id } });
      }
    });
  } else if (ev?.type === 'user' && ev.message) {
    const texts: string[] = [];
    const images: string[] = [];
    const rawContent = ev.message.content;
    // claude persists user records two ways: TUI/SDK string sends use a plain
    // string for `content`, while content-block sends (e.g. from this app)
    // use an array of blocks. Treat strings as a single text block, otherwise
    // walk the blocks normally.
    const blocks = typeof rawContent === 'string'
      ? [{ type: 'text', text: rawContent }]
      : Array.isArray(rawContent) ? rawContent : [];
    for (const block of blocks) {
      if (block.type === 'text') {
        texts.push(block.text);
      } else if (block.type === 'image') {
        const src = block.source;
        if (src?.type === 'base64' && src.data && src.media_type) {
          images.push(`data:${src.media_type};base64,${src.data}`);
        }
      } else if (block.type === 'tool_result') {
        const text =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || '').join('\n')
              : JSON.stringify(block.content);
        out.push({ kind: 'tool_result', toolUseId: block.tool_use_id, output: text });
      }
    }
    if (texts.length || images.length) {
      out.push({
        kind: 'append',
        msg: {
          id: shortId(),
          role: 'user',
          text: texts.join('\n'),
          images: images.length ? images : undefined,
          // ev.uuid is the JSONL record's stable id — needed to target this
          // message via the rewind endpoint. Live-sent (not-yet-replayed)
          // messages won't have it; their ✎ button stays hidden until a
          // refetch picks up the persisted record.
          uuid: typeof ev?.uuid === 'string' ? ev.uuid : undefined,
        },
      });
    }
  }
  return out;
}

function applyDeltas(prev: Msg[], deltas: ReturnType<typeof renderEvent>): Msg[] {
  let arr = prev;
  for (const d of deltas) {
    if (d.kind === 'append') {
      arr = [...arr, d.msg];
    } else {
      arr = arr.map((m) =>
        m.role === 'tool' && m.toolUseId === d.toolUseId && !m.output ? { ...m, output: d.output } : m,
      );
    }
  }
  return arr;
}

// Replay path: build the full message list in one mutable pass. The immutable
// applyDeltas above is O(N²) on long transcripts.
// `orphanResults` carries tool_result outputs across batches: with pagination
// the older slice (containing a tool_use) may be loaded after the newer slice
// (containing its tool_result), so the result is stashed by toolUseId and
// applied when the matching tool_use arrives in a later batch.
function buildFromEvents(events: any[], orphanResults: Map<string, string>): Msg[] {
  const msgs: Msg[] = [];
  const pendingByToolUseId = new Map<string, Msg & { role: 'tool' }>();
  for (const ev of events) {
    for (const d of renderEvent(ev)) {
      if (d.kind === 'append') {
        if (d.msg.role === 'tool' && d.msg.toolUseId) {
          const cached = orphanResults.get(d.msg.toolUseId);
          if (cached !== undefined) {
            d.msg.output = cached;
            orphanResults.delete(d.msg.toolUseId);
          } else {
            pendingByToolUseId.set(d.msg.toolUseId, d.msg);
          }
        }
        msgs.push(d.msg);
      } else {
        const target = pendingByToolUseId.get(d.toolUseId);
        if (target && target.output === undefined) {
          target.output = d.output;
          pendingByToolUseId.delete(d.toolUseId);
        } else {
          orphanResults.set(d.toolUseId, d.output);
        }
      }
    }
  }
  return msgs;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function ChatPanel({
  projectId,
  projectPath,
  resumeId,
  initialPrompt,
  sendKey,
  theme,
  showStderr,
  richCopy,
  onTitle,
  onSessionId,
  onInitialPromptConsumed,
  onExportApi,
  onBookmark,
  bookmarked,
  onLocator,
  onOpenFile,
}: {
  projectId: string;
  projectPath?: string;
  resumeId?: string;
  // One-shot first message for a fresh session (Tab.initialPrompt). Sent once
  // the spawned session reports ready; never on resume/attach.
  initialPrompt?: string;
  sendKey: SendKey;
  theme: Theme;
  showStderr?: boolean;
  // Model: web.RichCopyEditor — settings.richCopy; desktop-only at render time.
  richCopy?: boolean;
  onTitle?: (title: string) => void;
  onSessionId?: (uuid: string) => void;
  onInitialPromptConsumed?: () => void;
  onExportApi?: (api: { open: () => void; canExport: boolean } | null) => void;
  // Model: web.BookmarkMessage — ☆ toggle handler; returns a status to toast or null.
  onBookmark?: (anchor: string, label: string) => string | null;
  // Anchors already bookmarked in this session (rendered as ★ + outline).
  bookmarked?: ReadonlySet<string>;
  // Model: web.RevealMessage — register our scroll-to-anchor locator.
  onLocator?: (api: MessageLocator | null) => void;
  // Model: web.OpenChatLink — in-project file link clicked in assistant text.
  onOpenFile?: (relPath: string) => void;
}) {
  const { skills: aieSkills, agents: aieAgents, refresh: refreshCommands } = useAieCommands(projectId);
  // What the CLI reported in system.init (skills / agents / slash commands).
  // Arrives via the init event on a fresh spawn, or via started.cliCatalog
  // when attaching to a live session.
  const [cliCatalog, setCliCatalog] = useState<ClaudeCliCatalog | null>(null);
  const commands = useMemo(
    () => toCommandItems(aieSkills, aieAgents, cliCatalog),
    [aieSkills, aieAgents, cliCatalog],
  );
  // Captured at mount: the prop is cleared by the parent right after we send.
  const pendingInitialPromptRef = useRef<string | null>(initialPrompt?.trim() || null);
  const rel = useMemo(() => makeRelPath(projectPath), [projectPath]);
  // Stable identity so memoised MarkdownText doesn't re-render per message on
  // every parent render (the registry passes a fresh closure each time).
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const openFile = useCallback((p: string) => onOpenFileRef.current?.(p), []);
  // Model: web.RichCopyEditor — 🍚 only on desktop with the setting on. The
  // sheet holds a snapshot of the text taken at click time.
  const isDesktop = useIsDesktop();
  const showRichCopy = !!richCopy && isDesktop;
  const [richCopyText, setRichCopyText] = useState<string | null>(null);
  const closeRichCopy = useCallback(() => setRichCopyText(null), []);
  useEffect(() => { if (!showRichCopy) setRichCopyText(null); }, [showRichCopy]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toolPopout, setToolPopout] = useState<Msg | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [oldestIdx, setOldestIdx] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelCatalog = useClaudeModels();
  // '' = claude's per-model default. Server-owned; updated via `started` and
  // `effort` WS messages (system.init doesn't report it).
  const [effort, setEffort] = useState<string>('');
  // Rewind: which user message is currently being edited (by JSONL uuid), and
  // the draft text. Only one editor open at a time.
  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [rewinding, setRewinding] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // App re-creates onExportApi as a new inline arrow on every render, so
  // including it in deps causes an infinite loop: this effect re-fires →
  // registerExportApi bumps a version state → App re-renders → new onExportApi
  // → repeat. The underlying registerExportApi is stable (useCallback), so the
  // stale closure is fine.
  useEffect(() => {
    if (!onExportApi) return;
    onExportApi({ open: () => setExportOpen(true), canExport: msgs.length > 0 });
    return () => onExportApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);
  const toastTimer = useRef<number | null>(null);
  const loadOlderRef = useRef<HTMLButtonElement>(null);
  // Mirrors for reveal() (model: web.RevealMessage), which loops across
  // awaits and can't trust one render's closure.
  const loadingMoreRef = useRef(false);
  const oldestIdxRef = useRef(0);
  oldestIdxRef.current = oldestIdx;
  const statusRef = useRef<Status>('connecting');
  statusRef.current = status;
  // Same stale-closure caveat as onExportApi: App hands us a fresh arrow per
  // render but the underlying registerLocator is stable.
  useEffect(() => {
    if (!onLocator) return;
    onLocator({ reveal });
    return () => onLocator(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tool outputs whose tool_use lives in a not-yet-loaded older slice.
  // Carried across pagination loads so the result gets stitched in when the
  // matching tool_use eventually arrives.
  const orphanResultsRef = useRef<Map<string, string>>(new Map());
  // Captures scroll state before a prepend so we can restore the user's
  // viewport position after older messages render at the top.
  const beforePrependRef = useRef<{ height: number; top: number } | null>(null);
  // Default scroll-to-bottom only when user is currently anchored near bottom;
  // when they've scrolled up to read history we leave them alone.
  const stickyBottomRef = useRef(true);

  // ----- streaming context (partial-messages) -----
  // Anthropic message_id of the assistant turn currently being streamed. Set on
  // `message_start`, cleared on `message_stop` / `result`. Only one in flight
  // per session since claude generates serially.
  const currentAssistantIdRef = useRef<string | null>(null);
  // Per-(assistantId, blockIndex) state. For text blocks we track the our-msg
  // id to mutate. For tool_use blocks we additionally buffer the partial JSON
  // input string until content_block_stop.
  const streamBlocksRef = useRef<
    Map<string, { ourMsgId: string; kind: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; jsonBuf?: string; uuidAssigned?: boolean }>
  >(new Map());
  // Anthropic message_ids whose complete `assistant` event should be ignored
  // because we already rendered them via stream_event deltas.
  const streamedAssistantIdsRef = useRef<Set<string>>(new Set());

  function showToast(text: string, durationMs = 2500) {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), durationMs);
  }

  useEffect(() => {
    if (!lightbox && !toolPopout) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setLightbox(null); setToolPopout(null); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox, toolPopout]);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const titleSetFromMsg = useRef(false);
  const initialResumeIdRef = useRef(resumeId);
  const activeSessionIdRef = useRef<string | undefined>(resumeId);
  const closedByUsRef = useRef(false);
  const sessionExitedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const isReconnectingRef = useRef(false);
  const failedConnectsRef = useRef(0);
  const MAX_FAILED_CONNECTS = 3;
  // Heartbeat liveness — see DevinPanel for the full rationale. Without these,
  // a TCP connection silently dropped during a long idle leaves a zombie WS
  // that never triggers onclose, so reconnect never fires.
  const lastMessageAtRef = useRef(Date.now());
  const heartbeatTimerRef = useRef<number | null>(null);
  const PING_INTERVAL_MS = 25_000;
  const HEARTBEAT_DEAD_MS = 60_000;
  const VISIBILITY_STALE_MS = 30_000;

  async function refetchTranscript(uuid: string) {
    try {
      const r = await fetch(`/api/projects/${projectId}/sessions/${uuid}/transcript?limit=20`);
      if (!r.ok) return;
      const { events, startIndex } = await r.json();
      // Reset orphan map: we're rebuilding from scratch.
      orphanResultsRef.current = new Map();
      setMsgs(buildFromEvents(events, orphanResultsRef.current));
      setOldestIdx(startIndex ?? 0);
    } catch {}
  }

  function loadOlder() { return loadOlderFrom(oldestIdx); }

  async function loadOlderFrom(before: number) {
    const uuid = activeSessionIdRef.current ?? initialResumeIdRef.current;
    if (!uuid || loadingMoreRef.current || before <= 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/projects/${projectId}/sessions/${uuid}/transcript?before=${before}&limit=20`,
      );
      if (!r.ok) return;
      const { events, startIndex } = await r.json();
      const el = scrollRef.current;
      if (el) beforePrependRef.current = { height: el.scrollHeight, top: el.scrollTop };
      const older = buildFromEvents(events, orphanResultsRef.current);
      setMsgs((prev) => [...older, ...prev]);
      setOldestIdx(startIndex ?? 0);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }

  // Model: web.RevealMessage. Scroll the message with this anchor into view,
  // paging back through history until it turns up. Waits while the panel is
  // hidden (tab not yet displayed) or still loading; false = not in session.
  async function reveal(anchor: string): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      const root = scrollRef.current;
      const visible = !!root && root.clientHeight > 0;
      const el = root?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`) ?? null;
      if (el && visible) {
        el.scrollIntoView({ block: 'center' });
        flashMessage(el);
        return true;
      }
      const busy = loadingMoreRef.current || statusRef.current === 'connecting' || statusRef.current === 'replaying';
      if (!visible || busy) { await sleep(150); continue; }
      if (oldestIdxRef.current > 0) {
        await loadOlderFrom(oldestIdxRef.current);
        await sleep(50);
        continue;
      }
      return false;
    }
    return false;
  }

  function bookmark(anchor: string, label: string) {
    if (!onBookmark) return;
    const note = onBookmark(anchor, label);
    if (note) showToast(note);
  }
  // Model: web.BookmarkMessage — ☆ only when the Pinboard is enabled
  // (builtinTabKinds omits onBookmark when settings.pinboard is off).
  const canBookmark = !!onBookmark;

  useEffect(() => {
    let aborted = false;
    closedByUsRef.current = false;
    sessionExitedRef.current = false;
    reconnectAttemptRef.current = 0;

    function openWs() {
      const resume = activeSessionIdRef.current ?? initialResumeIdRef.current;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const params = new URLSearchParams({ project: projectId });
      if (resume) params.set('resume', resume);
      const ws = new WebSocket(`${proto}://${location.host}/ws/session?${params}`);
      wsRef.current = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        failedConnectsRef.current = 0;
        reconnectAttemptRef.current = 0;
        lastMessageAtRef.current = Date.now();
        if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = window.setInterval(() => {
          if (Date.now() - lastMessageAtRef.current > HEARTBEAT_DEAD_MS) {
            try { ws.close(); } catch {}
            return;
          }
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, PING_INTERVAL_MS);
        if (isReconnectingRef.current) {
          isReconnectingRef.current = false;
          showToast('Reconnected');
        }
      };
      ws.onmessage = (ev) => {
        lastMessageAtRef.current = Date.now();
        const data = JSON.parse(ev.data);
        if (data?.type === 'pong') return;
        handleWsMsg(data);
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (heartbeatTimerRef.current) {
          window.clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        if (closedByUsRef.current || sessionExitedRef.current) {
          setStatus('closed');
          return;
        }
        if (!opened) {
          failedConnectsRef.current++;
          if (failedConnectsRef.current >= MAX_FAILED_CONNECTS) {
            setStatus('closed');
            setMsgs((prev) => [...prev, {
              id: shortId(),
              role: 'system' as const,
              text: 'Connection failed — session may have expired. Please refresh the page.',
            }]);
            return;
          }
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      setStatus('reconnecting');
      isReconnectingRef.current = true;
      reconnectTimerRef.current = window.setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (closedByUsRef.current) return;
        const sid = activeSessionIdRef.current;
        if (sid) await refetchTranscript(sid);
        if (closedByUsRef.current) return;
        openWs();
      }, delay);
    }

    async function start() {
      const initialResume = initialResumeIdRef.current;
      if (initialResume) {
        setStatus('replaying');
        try {
          const r = await fetch(
            `/api/projects/${projectId}/sessions/${initialResume}/transcript?limit=20`,
          );
          if (r.ok) {
            const { events, startIndex } = await r.json();
            if (aborted) return;
            orphanResultsRef.current = new Map();
            const arr = buildFromEvents(events, orphanResultsRef.current);
            setMsgs(arr);
            setOldestIdx(startIndex ?? 0);
            // Best-effort: surface the last model id from the transcript before
            // WS attaches. Avoids a blank model field on resume.
            for (let i = events.length - 1; i >= 0; i--) {
              const ev = events[i];
              if (ev?.type === 'assistant' && ev.message?.model) {
                setModel(ev.message.model);
                break;
              }
            }
            const firstUser = arr.find((m) => m.role === 'user');
            if (firstUser && !titleSetFromMsg.current && onTitle) {
              onTitle(firstUser.text.slice(0, 40));
              titleSetFromMsg.current = true;
            }
          }
        } catch {}
        if (aborted) return;
      }
      openWs();
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws) return;
      if (closedByUsRef.current || sessionExitedRef.current) return;
      const stale = Date.now() - lastMessageAtRef.current > VISIBILITY_STALE_MS;
      if (stale || ws.readyState !== WebSocket.OPEN) {
        try { ws.close(); } catch {}
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    start();
    return () => {
      aborted = true;
      closedByUsRef.current = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      try { wsRef.current?.close(); } catch {}
    };
  }, [projectId]);

  function append(m: Msg) {
    setMsgs((prev) => [...prev, m]);
  }

  function blockKey(assistantId: string, idx: number) { return `${assistantId}#${idx}`; }

  // Incrementally apply a `stream_event` (Anthropic-SDK-shaped event nested
  // inside the claude stream-json envelope). Mutates streaming refs + setMsgs.
  // claude writes one JSONL record per content block (same message.id,
  // distinct uuid, content[0] = the block) and echoes the same records as
  // complete `assistant` events, so match text blocks to the streamed ones in
  // stream order rather than by content index.
  function patchStreamedUuid(assistantId: string, uuid: string, content: unknown) {
    const streamedText = [...streamBlocksRef.current.entries()]
      .filter(([k, b]) => k.startsWith(`${assistantId}#`) && b.kind === 'text')
      .sort((a, b) => Number(a[0].split('#')[1]) - Number(b[0].split('#')[1]))
      .map(([, b]) => b);
    (Array.isArray(content) ? content : []).forEach((block: any, blockIdx: number) => {
      if (block?.type !== 'text') return;
      const blk = streamedText.find((b) => !b.uuidAssigned);
      if (!blk) return;
      blk.uuidAssigned = true;
      setMsgs((prev) => prev.map((m) =>
        m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, uuid, blockIdx } : m,
      ));
    });
  }

  function processStreamEvent(streamEv: any) {
    const t = streamEv?.type;
    if (t === 'message_start') {
      const msgId = streamEv.message?.id;
      if (msgId) {
        currentAssistantIdRef.current = msgId;
        // Drop the previous turn's text-block bookkeeping (kept past
        // content_block_stop so the uuid echo could still be matched).
        for (const k of [...streamBlocksRef.current.keys()]) {
          if (!k.startsWith(`${msgId}#`)) streamBlocksRef.current.delete(k);
        }
        // Claim ownership of this message_id immediately. The complete
        // `assistant` event for the same id often arrives BEFORE message_stop,
        // so deduping must already be armed by then or we double-render.
        const set = streamedAssistantIdsRef.current;
        set.add(msgId);
        // Bound the set so a long-running session doesn't leak; we only need
        // to suppress the immediate complete-event echo per turn.
        if (set.size > 256) {
          const first = set.values().next().value;
          if (first !== undefined) set.delete(first);
        }
        setStatus('thinking');
      }
      return;
    }
    const assistantId = currentAssistantIdRef.current;
    if (!assistantId) return;
    if (t === 'content_block_start') {
      const idx: number = streamEv.index;
      const cb = streamEv.content_block;
      const ourMsgId = shortId();
      if (cb?.type === 'text') {
        streamBlocksRef.current.set(blockKey(assistantId, idx), { ourMsgId, kind: 'text' });
        setMsgs((prev) => [...prev, { id: ourMsgId, role: 'assistant', text: cb.text ?? '' }]);
      } else if (cb?.type === 'tool_use') {
        streamBlocksRef.current.set(blockKey(assistantId, idx), {
          ourMsgId,
          kind: 'tool_use',
          toolName: cb.name,
          toolUseId: cb.id,
          jsonBuf: '',
        });
        setMsgs((prev) => [
          ...prev,
          { id: ourMsgId, role: 'tool', name: cb.name, input: {}, toolUseId: cb.id },
        ]);
      }
      return;
    }
    if (t === 'content_block_delta') {
      const idx: number = streamEv.index;
      const blk = streamBlocksRef.current.get(blockKey(assistantId, idx));
      if (!blk) return;
      const delta = streamEv.delta;
      if (delta?.type === 'text_delta' && blk.kind === 'text') {
        const piece: string = delta.text ?? '';
        setMsgs((prev) =>
          prev.map((m) =>
            m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, text: m.text + piece } : m,
          ),
        );
      } else if (delta?.type === 'input_json_delta' && blk.kind === 'tool_use') {
        blk.jsonBuf = (blk.jsonBuf ?? '') + (delta.partial_json ?? '');
      }
      return;
    }
    if (t === 'content_block_stop') {
      const idx: number = streamEv.index;
      const blk = streamBlocksRef.current.get(blockKey(assistantId, idx));
      if (!blk) return;
      if (blk.kind === 'tool_use' && blk.jsonBuf) {
        try {
          const parsed = JSON.parse(blk.jsonBuf);
          setMsgs((prev) =>
            prev.map((m) =>
              m.id === blk.ourMsgId && m.role === 'tool' ? { ...m, input: parsed } : m,
            ),
          );
        } catch {}
      }
      // Text entries stay until the next message_start: the complete
      // `assistant` echo that carries their JSONL uuid (patchStreamedUuid)
      // can land after content_block_stop.
      if (blk.kind === 'tool_use') streamBlocksRef.current.delete(blockKey(assistantId, idx));
      return;
    }
    if (t === 'message_stop') {
      currentAssistantIdRef.current = null;
    }
  }

  function handleWsMsg(m: any) {
    if (m.type === 'started') {
      // Only a freshly spawned session may consume an initialPrompt; a
      // resumed/attached one already has history and must not re-send.
      if (m.resumed) pendingInitialPromptRef.current = null;
      setStatus(m.thinking ? 'thinking' : 'ready');
      // Prefer confirmed model from claude's init; otherwise show the model
      // we asked claude to use (settings.model) as an immediate hint.
      if (m.model) setModel(m.model);
      else if (m.requestedModel) setModel((cur) => cur ?? m.requestedModel);
      if (typeof m.effort === 'string') setEffort(m.effort);
      if (m.cliCatalog && typeof m.cliCatalog === 'object') setCliCatalog(m.cliCatalog);
      showToast(m.resumed ? 'Resumed session' : 'Session started');
      return;
    }
    if (m.type === 'effort') {
      const level = typeof m.effort === 'string' ? m.effort : '';
      setEffort(level);
      showToast(level ? `Effort: ${level}` : 'Effort: default');
      return;
    }
    if (m.type === 'effort_error') {
      showToast(String(m.message ?? 'Could not change effort'));
      return;
    }
    if (m.type === 'stderr') {
      const text = String(m.data ?? '');
      // If showStderr is enabled, show all stderr; otherwise only show actual errors (ERROR/PANIC level, not WARN/INFO)
      if (showStderr || /^(ERROR|PANIC)/i.test(text)) {
        append({ id: shortId(), role: 'system', text: `[stderr] ${text.trim()}` });
      }
      return;
    }
    if (m.type === 'exit') {
      sessionExitedRef.current = true;
      append({ id: shortId(), role: 'system', text: `session exited (code=${m.code})` });
      setStatus('closed');
      return;
    }
    if (m.type === 'error') { append({ id: shortId(), role: 'system', text: `error: ${m.message}` }); return; }
    if (m.type === 'external_change') {
      showToast('External change detected, refreshing');
      if (activeSessionIdRef.current) refetchTranscript(activeSessionIdRef.current);
      return;
    }
    if (m.type === 'rewind') {
      // Server has truncated the JSONL and started a fresh turn. Drop our
      // local view so the next refetch + WS stream rebuild from scratch.
      currentAssistantIdRef.current = null;
      orphanResultsRef.current = new Map();
      setMsgs([]);
      setStatus('thinking');
      if (activeSessionIdRef.current) refetchTranscript(activeSessionIdRef.current);
      return;
    }
    if (m.type === 'user_uuid') {
      // Server resolved the JSONL uuid for a recently-sent user message.
      // Patch the matching msg by msgId; fall back to the most recent user
      // bubble without a uuid (covers non-sender clients whose local msg id
      // wasn't generated from msgId).
      const targetMsgId = m.msgId;
      const targetUuid = m.uuid;
      if (!targetUuid) return;
      setMsgs((prev) => {
        if (targetMsgId) {
          let matched = false;
          const arr = prev.map((msg) => {
            if (matched) return msg;
            if (msg.role === 'user' && msg.id === targetMsgId) {
              matched = true;
              return { ...msg, uuid: targetUuid };
            }
            return msg;
          });
          if (matched) return arr;
        }
        for (let i = prev.length - 1; i >= 0; i--) {
          const msg = prev[i];
          if (msg.role === 'user' && !msg.uuid) {
            const copy = prev.slice();
            copy[i] = { ...msg, uuid: targetUuid };
            return copy;
          }
        }
        return prev;
      });
      return;
    }
    if (m.type !== 'event') return;
    const ev = m.data;

    if (ev.type === 'stream_event') {
      processStreamEvent(ev.event);
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.model) setModel(ev.model);
      setCliCatalog({
        slashCommands: strList(ev.slash_commands),
        skills: strList(ev.skills),
        agents: strList(ev.agents),
        terminalSlashCommands: strList(ev.terminal_slash_commands),
      });
      if (ev.session_id) {
        activeSessionIdRef.current = ev.session_id;
        if (onSessionId) onSessionId(ev.session_id);
      }
      return;
    }
    if (ev.type === 'result') {
      setStatus('ready');
      currentAssistantIdRef.current = null;
      return;
    }
    // Skip complete assistant events whose content was already streamed.
    // Keep the id in the set: any re-broadcast or replay path must stay
    // suppressed. The set is bounded by trim below.
    if (ev.type === 'assistant') {
      const aid = ev.message?.id;
      if (aid && streamedAssistantIdsRef.current.has(aid)) {
        // Already rendered via deltas — but this echo carries the JSONL
        // uuid the streamed text blocks need as their bookmark anchor.
        if (typeof ev.uuid === 'string') patchStreamedUuid(aid, ev.uuid, ev.message?.content);
        return;
      }
    }
    const deltas = renderEvent(ev);
    if (deltas.length) setMsgs((prev) => applyDeltas(prev, deltas));
  }

  function addFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.includes(',') ? dataUrl.split(',', 2)[1] : '';
        if (!base64) return;
        setPendingImages((prev) => [
          ...prev,
          { id: shortId(), dataUrl, mediaType: f.type, base64 },
        ]);
      };
      reader.readAsDataURL(f);
    }
  }

  function send(raw: string) {
    if (!wsRef.current || status === 'closed' || status === 'connecting' || status === 'reconnecting') return;
    const text = raw.trim();
    if (!text && pendingImages.length === 0) return;
    // The local msg id doubles as the wire-level msgId — the server echoes it
    // back in a user_uuid event once claude flushes this prompt to JSONL, so
    // we can patch in the real uuid (needed for the rewind ✎ button) without
    // a page reload.
    const msgId = shortId();
    append({
      id: msgId,
      role: 'user',
      text,
      images: pendingImages.length ? pendingImages.map((p) => p.dataUrl) : undefined,
    });
    wsRef.current.send(JSON.stringify({
      type: 'user',
      text,
      images: pendingImages.map((p) => ({ mediaType: p.mediaType, data: p.base64 })),
      msgId,
    }));
    setPendingImages([]);
    setStatus('thinking');
    if (!titleSetFromMsg.current && onTitle && text) {
      onTitle(text.slice(0, 40));
      titleSetFromMsg.current = true;
    }
  }

  function stop() { wsRef.current?.send(JSON.stringify({ type: 'stop' })); }

  // Fire the one-shot initialPrompt as soon as the new session is ready.
  // `send` reads status from this render's closure, which is 'ready' here.
  useEffect(() => {
    if (status !== 'ready') return;
    const text = pendingInitialPromptRef.current;
    if (!text) return;
    pendingInitialPromptRef.current = null;
    send(text);
    onInitialPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function startEditUser(m: Msg & { role: 'user' }) {
    if (!m.uuid) return;
    setEditingUuid(m.uuid);
    setEditingText(m.text);
  }

  function cancelEditUser() {
    setEditingUuid(null);
    setEditingText('');
  }

  async function submitRewind(orig: Msg & { role: 'user' }) {
    const sid = activeSessionIdRef.current;
    if (!sid || !orig.uuid) return;
    const newText = editingText.trim();
    if (!newText) {
      showToast('Message cannot be empty');
      return;
    }
    // Re-send any images that were on the original message so the new turn
    // has the same visual context. Convert data URLs back to {mediaType, data}.
    const images: { mediaType: string; data: string }[] = [];
    for (const dataUrl of orig.images ?? []) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (m) images.push({ mediaType: m[1], data: m[2] });
    }
    setRewinding(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/sessions/${sid}/rewind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageUuid: orig.uuid, newText, images }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        showToast(`Rewind failed: ${body?.error ?? r.status}`);
        return;
      }
      // Success — clear the editor. The WS `rewind` broadcast will rebuild
      // the message list and start streaming the new response.
      setEditingUuid(null);
      setEditingText('');
    } catch (e: any) {
      showToast(`Rewind failed: ${e?.message ?? 'network error'}`);
    } finally {
      setRewinding(false);
    }
  }

  function switchModel(alias: string) {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'set_model', model: alias }));
    // Optimistic: claude won't emit a fresh system.init until the next turn,
    // so without this the status bar would keep showing the old model until
    // the user types again. The real id (full snapshot) will overwrite when
    // the next system.init arrives.
    setModel(alias);
    showToast(`Switched to ${alias}`);
    setModelPickerOpen(false);
  }

  function switchEffort(level: string) {
    if (!wsRef.current) return;
    // Not optimistic: the server has to respawn claude with --effort, and it
    // broadcasts `effort` once the new proc is wired up.
    wsRef.current.send(JSON.stringify({ type: 'set_effort', effort: level }));
    showToast('Applying effort…');
    setModelPickerOpen(false);
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Just prepended older messages: restore the user's viewport position by
    // accounting for the height added at the top.
    if (beforePrependRef.current) {
      const { height, top } = beforePrependRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      beforePrependRef.current = null;
      return;
    }
    // Normal append: only auto-scroll if user was already anchored at bottom.
    if (stickyBottomRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [msgs]);

  // Auto-load older messages when the button scrolls into view.
  useEffect(() => {
    const el = loadOlderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadOlder();
    }, { root: scrollRef.current, threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [oldestIdx, loadingMore]);

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef} onScroll={onMessagesScroll}>
        {oldestIdx > 0 && (
          <button
            ref={loadOlderRef}
            className="load-older"
            onClick={loadOlder}
            disabled={loadingMore}
            type="button"
          >
            {loadingMore ? 'Loading…' : `↑ Load older (${oldestIdx} above)`}
          </button>
        )}
        {msgs.map((m) => {
          const anchor = msgAnchor(m);
          const isBookmarked = !!anchor && !!bookmarked?.has(anchor);
          const bmCls = isBookmarked ? ' bookmarked' : '';
          if (m.role === 'user') {
            const isEditing = !!m.uuid && editingUuid === m.uuid;
            return (
              <div key={m.id} className={`msg msg-user${bmCls}`} data-anchor={anchor ?? undefined}>
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, i) => (
                      <img key={i} src={src} className="msg-image" alt="" onClick={() => setLightbox(src)} />
                    ))}
                  </div>
                )}
                {isEditing ? (
                  <div className="msg-user-edit">
                    <textarea
                      className="msg-user-edit-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      autoFocus
                      rows={Math.max(2, Math.min(10, editingText.split('\n').length))}
                    />
                    <div className="msg-user-edit-actions">
                      <button
                        type="button"
                        className="msg-user-edit-cancel"
                        onClick={cancelEditUser}
                        disabled={rewinding}
                      >Cancel</button>
                      <button
                        type="button"
                        className="msg-user-edit-send"
                        onClick={() => submitRewind(m as Msg & { role: 'user' })}
                        disabled={rewinding || !editingText.trim()}
                      >{rewinding ? 'Rewinding…' : 'Resend'}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {m.text && <div>{m.text}</div>}
                    {anchor && canBookmark && (
                      <BookmarkButton active={isBookmarked} className="msg-bookmark-btn-2nd" onClick={() => bookmark(anchor, bookmarkLabel(m.text))} />
                    )}
                    {m.uuid && (
                      <button
                        type="button"
                        className="msg-user-edit-btn"
                        title="Revert to this point — discards later turns and rolls back any files claude changed since"
                        onClick={() => startEditUser(m as Msg & { role: 'user' })}
                        aria-label="Revert to this message"
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="9 14 4 9 9 4" />
                          <path d="M4 9 h 11 a 5 5 0 0 1 0 10 h -4" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          }
          if (m.role === 'assistant') {
            return (
              <div key={m.id} className={`msg msg-assistant${bmCls}`} data-anchor={anchor ?? undefined}>
                <MarkdownText text={m.text} theme={theme} projectPath={projectPath} onOpenFile={openFile} />
                {showRichCopy && <RichCopyButton onClick={() => setRichCopyText(m.text)} />}
                {anchor && canBookmark && <BookmarkButton active={isBookmarked} onClick={() => bookmark(anchor, bookmarkLabel(m.text))} />}
              </div>
            );
          }
          if (m.role === 'system') return <div key={m.id} className="msg msg-system">{m.text}</div>;
          const isOpen = expanded.has(m.id);
          const summary = summarizeTool(m.name, m.input, rel);
          return (
            <div key={m.id} className={`msg msg-tool ${isOpen ? 'open' : ''}${bmCls}`} data-anchor={anchor ?? undefined}>
              <div
                className="tool-header"
                onClick={() => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                    return next;
                  });
                }}
              >
                <span className="tool-chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="tool-name">{m.name}</span>
                {summary && <span className="tool-summary">{summary}</span>}
                {m.output === undefined && <span className="tool-pending">…</span>}
                {anchor && canBookmark && (
                  <BookmarkButton
                    active={isBookmarked}
                    className="tool-bookmark-btn"
                    onClick={() => bookmark(anchor, bookmarkLabel(summary ? `${m.name} · ${summary}` : m.name))}
                  />
                )}
                <button
                  className="tool-popout-btn"
                  onClick={(e) => { e.stopPropagation(); setToolPopout(m); }}
                  title="Open full details"
                  aria-label="Open full details"
                >⛶</button>
              </div>
              {isOpen && (
                <div className="tool-detail">
                  <ToolFields input={m.input} rel={rel} />
                  {m.output !== undefined && (
                    <div className="tool-field">
                      <div className="tool-field-key">output</div>
                      <pre className="tool-field-value">{rel(m.output)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {status === 'thinking' && (
          <div className="msg msg-thinking" aria-label="Claude is thinking">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </div>
        )}
      </div>
      {(() => {
        // Keep the bar visible whenever we have anything to show. `thinking`
        // has its own bottom-of-flow indicator, so the left label is dropped
        // in that state — but the model id on the right should still render.
        if (status === 'thinking' && !toast && !model) return null;
        const label =
          toast ??
          (status === 'ready' ? 'Ready'
            : status === 'connecting' ? 'Connecting…'
            : status === 'reconnecting' ? 'Reconnecting…'
            : status === 'replaying' ? 'Loading history…'
            : status === 'closed' ? 'Disconnected'
            : status);
        const showLabel = status !== 'thinking' || !!toast;
        return (
          <div className={`chat-status status-${status}`}>
            <span>{showLabel ? label : ''}</span>
            {model && (
              <div className="chat-status-model-wrap">
                <button
                  className="chat-status-model"
                  title={`${model}${effort ? ` · effort ${effort}` : ''} — click to switch`}
                  onClick={() => setModelPickerOpen((v) => !v)}
                  type="button"
                >{model}{effort ? ` · ${effort}` : ''}</button>
                {modelPickerOpen && (
                  <>
                    <div className="model-picker-backdrop" onClick={() => setModelPickerOpen(false)} />
                    <div className="model-picker">
                      {(() => {
                        const groups: { label: string; items: typeof modelCatalog.models }[] = [
                          { label: 'Aliases (auto-latest)', items: modelCatalog.aliases },
                          { label: 'Latest', items: modelCatalog.models.filter((m) => m.section === 'main') },
                          { label: 'Previous', items: modelCatalog.models.filter((m) => m.section !== 'main') },
                        ];
                        return groups.filter((g) => g.items.length > 0).map((g) => (
                          <div key={g.label} className="model-picker-group">
                            <div className="model-picker-group-label">{g.label}</div>
                            {g.items.map((m) => (
                              <button
                                key={m.id}
                                className={`model-picker-item ${m.id === model ? 'current' : ''}`}
                                onClick={() => switchModel(m.id)}
                                type="button"
                                title={m.description || ''}
                              >
                                <span>{m.name}</span>
                                <code className="model-picker-id">{m.id}</code>
                              </button>
                            ))}
                          </div>
                        ));
                      })()}
                      {(() => {
                        const eo = effortOptionsFor(modelCatalog.models, model);
                        return (
                          <div className="model-picker-group">
                            <div className="model-picker-group-label">Effort</div>
                            {!eo.supported ? (
                              <div className="model-picker-group-label" style={{ padding: '4px 10px', opacity: 0.6 }}>
                                Not supported by this model
                              </div>
                            ) : (
                              <>
                                <button
                                  className={`model-picker-item ${effort === '' ? 'current' : ''}`}
                                  onClick={() => switchEffort('')}
                                  type="button"
                                  title="Let claude pick the per-model default"
                                >
                                  <span>Default</span>
                                  {eo.default && <code className="model-picker-id">{eo.default}</code>}
                                </button>
                                {eo.options.map((lvl) => (
                                  <button
                                    key={lvl}
                                    className={`model-picker-item ${effort === lvl ? 'current' : ''}`}
                                    onClick={() => switchEffort(lvl)}
                                    type="button"
                                  >
                                    <span>{lvl}</span>
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })()}
                      {modelCatalog.loading && (
                        <div className="model-picker-group-label" style={{ padding: '6px 10px', opacity: 0.6 }}>
                          Loading catalog…
                        </div>
                      )}
                      {modelCatalog.error && (
                        <div className="model-picker-group-label" style={{ padding: '6px 10px', color: 'var(--color-error, #d33)' }}>
                          Catalog unavailable — aliases only
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}
      {pendingImages.length > 0 && (
        <div className="chat-pending-images">
          {pendingImages.map((img) => (
            <div key={img.id} className="pending-thumb">
              <img src={img.dataUrl} alt="" onClick={() => setLightbox(img.dataUrl)} />
              <button
                className="pending-thumb-del"
                onClick={() => setPendingImages((prev) => prev.filter((p) => p.id !== img.id))}
                title="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}
      <ChatInput
        status={status}
        sendKey={sendKey}
        pendingImagesCount={pendingImages.length}
        readyPlaceholder={sendKeyHint(sendKey)}
        thinkingPlaceholder="Claude is working — type to queue / send another"
        commands={commands}
        onCommandsOpen={refreshCommands}
        onSend={send}
        onAddFiles={addFiles}
        onStop={stop}
      />

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
        </div>
      )}
      {showRichCopy && richCopyText != null && (
        <RichCopySheet onClose={closeRichCopy}>
          <MarkdownText text={richCopyText} theme={theme} projectPath={projectPath} onOpenFile={openFile} />
        </RichCopySheet>
      )}
      {toolPopout && toolPopout.role === 'tool' && (
        <div className="tool-popout-backdrop" onClick={() => setToolPopout(null)}>
          <div className="tool-popout-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tool-popout-header">
              <span className="tool-name">{toolPopout.name}</span>
              <span className="tool-summary">{summarizeTool(toolPopout.name, toolPopout.input, rel)}</span>
              <button
                className="tool-popout-close"
                onClick={() => setToolPopout(null)}
                aria-label="Close"
              >×</button>
            </div>
            <div className="tool-popout-body">
              <ToolFields input={toolPopout.input} rel={rel} />
              {toolPopout.output !== undefined && (
                <div className="tool-field">
                  <div className="tool-field-key">output</div>
                  <pre className="tool-field-value tool-field-value-full">{rel(toolPopout.output)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportDialog
            projectId={projectId}
            messages={claudeMsgsToExport(msgs)}
            source="claude"
            theme={theme}
            onClose={() => setExportOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

// Map ChatPanel's internal Msg variants to the normalized ExportMessage shape
// used by the export pipeline. Keep this private to the panel — the export lib
// shouldn't need to know about Claude-specific fields.
function claudeMsgsToExport(msgs: Msg[]): ExportMessage[] {
  return msgs.map((m): ExportMessage => {
    if (m.role === 'user') return { kind: 'user', text: m.text, images: m.images };
    if (m.role === 'assistant') return { kind: 'assistant', text: m.text };
    if (m.role === 'system') return { kind: 'system', text: m.text };
    return { kind: 'tool', name: m.name, input: m.input, output: m.output };
  });
}
