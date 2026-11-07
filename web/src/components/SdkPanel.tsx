// Model: web.SdkChatPanel (page SdkChatView). The Agent-SDK Claude tab. A
// separate panel on purpose — it shares leaf components with ChatPanel
// (ChatInput, ElicitationHost, ImageAttachments, MarkdownLink, pickers) but
// none of ChatPanel's own code, so the `session` kind cannot regress from
// anything done here. Wire protocol: server ClaudeSdkSessionBridge
// (projects/claude-sdk-session/design.md).
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SendKey, Theme } from '../types';
import type { SessionPanelApi, TabActivity } from '../registry/tabRegistry';
import { CommentComposer, flashMessage, sleep, type NewComment } from './CommentComposer';
import type { PromptInsertion } from './ChatInput';
import { composeComment, type CommentMark } from '../lib/review';
import { applyQuoteHighlights } from '../lib/quoteHighlight';
import { RichCopyButton, useRichCopy } from './RichCopy';
import type { ExportMessage } from '../lib/export/types';

// Lazy like ChatPanel: the export pipeline only loads when ⤓ is clicked.
const ExportDialog = lazy(() => import('./ExportDialog').then((m) => ({ default: m.ExportDialog })));
import { ChatInput } from './ChatInput';
import { ImageAttachmentStrip, useImageAttachments, type ImageAttachment } from './ImageAttachments';
import { useElicitationHost } from './ElicitationHost';
import { MarkdownLink } from './MarkdownLink';
import { claudeAnswersFrom, parseAskUserQuestion } from '../lib/elicitation';
import { isSendKeyTrigger } from '../lib/sendKey';
import { toWireImages } from '../lib/imageAttachments';
import { makeRelPath } from '../lib/relPath';
import { toCommandItems } from '../lib/commandPicker';
import type { ClaudeCliCatalog } from '../lib/claudeCatalog';
import { useAieCommands } from '../useAieCommands';
import { useClaudeModels, effortOptionsFor } from '../useClaudeModels';

// ----- message model ------------------------------------------------------

type Msg =
  | { id: string; role: 'user'; text: string; images?: string[]; uuid?: string }
  // uuid / blockIdx: the jsonl record + content block this text came from —
  // the comment anchor (model: Comment.anchor = a:<uuid>:<blockIdx>).
  | { id: string; role: 'assistant'; text: string; uuid?: string; blockIdx?: number }
  | { id: string; role: 'system'; text: string }
  | { id: string; role: 'tool'; name: string; input: any; toolUseId?: string; output?: string };

type Status = 'connecting' | 'replaying' | 'ready' | 'thinking' | 'reconnecting' | 'closed';

function shortId() { return Math.random().toString(36).slice(2, 9); }

// Stable per-message anchor for Review comments — same shape as ChatPanel so
// a comment made in either Claude tab kind resolves in the other.
function msgAnchor(m: Msg): string | null {
  if (m.role === 'user') return m.uuid ? `u:${m.uuid}` : null;
  if (m.role === 'assistant') return m.uuid ? `a:${m.uuid}:${m.blockIdx ?? 0}` : null;
  if (m.role === 'tool') return m.toolUseId ? `t:${m.toolUseId}` : null;
  return null;
}

function toExport(msgs: Msg[]): ExportMessage[] {
  return msgs.map((m): ExportMessage => {
    if (m.role === 'user') return { kind: 'user', text: m.text, images: m.images };
    if (m.role === 'assistant') return { kind: 'assistant', text: m.text };
    if (m.role === 'system') return { kind: 'system', text: m.text };
    return { kind: 'tool', name: m.name, input: m.input, output: m.output };
  });
}

type Delta = { kind: 'append'; msg: Msg } | { kind: 'tool_result'; toolUseId: string; output: string };

// One transcript / SDK message → message deltas. Both ReadSdkTranscript
// events and live SDKMessages have {type, uuid, message}.
function renderEvent(ev: any): Delta[] {
  const out: Delta[] = [];
  const uuid = typeof ev?.uuid === 'string' ? ev.uuid : undefined;
  if (ev?.type === 'assistant' && ev.message) {
    (ev.message.content ?? []).forEach((block: any, blockIdx: number) => {
      if (block?.type === 'text' && block.text) {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'assistant', text: block.text, uuid, blockIdx } });
      } else if (block?.type === 'tool_use') {
        out.push({ kind: 'append', msg: { id: shortId(), role: 'tool', name: block.name, input: block.input, toolUseId: block.id } });
      }
    });
  } else if (ev?.type === 'user' && ev.message) {
    const texts: string[] = [];
    const images: string[] = [];
    const raw = ev.message.content;
    const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : [];
    for (const block of blocks) {
      if (block?.type === 'text') texts.push(block.text ?? '');
      else if (block?.type === 'image') {
        const src = block.source;
        if (src?.type === 'base64' && src.data && src.media_type) images.push(`data:${src.media_type};base64,${src.data}`);
      } else if (block?.type === 'tool_result') {
        const text = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text || '').join('\n') : JSON.stringify(block.content);
        out.push({ kind: 'tool_result', toolUseId: block.tool_use_id, output: text });
      }
    }
    if (texts.length || images.length) {
      out.push({ kind: 'append', msg: { id: shortId(), role: 'user', text: texts.join('\n'), images: images.length ? images : undefined, uuid } });
    }
  }
  return out;
}

function buildFromEvents(events: any[], orphanResults: Map<string, string>): Msg[] {
  const msgs: Msg[] = [];
  const pendingTools = new Map<string, Msg & { role: 'tool' }>();
  for (const ev of events) {
    for (const d of renderEvent(ev)) {
      if (d.kind === 'append') {
        if (d.msg.role === 'tool' && d.msg.toolUseId) {
          const cached = orphanResults.get(d.msg.toolUseId);
          if (cached !== undefined) { d.msg.output = cached; orphanResults.delete(d.msg.toolUseId); }
          else pendingTools.set(d.msg.toolUseId, d.msg);
        }
        msgs.push(d.msg);
      } else {
        const target = pendingTools.get(d.toolUseId);
        if (target && target.output === undefined) { target.output = d.output; pendingTools.delete(d.toolUseId); }
        else orphanResults.set(d.toolUseId, d.output);
      }
    }
  }
  return msgs;
}

function applyDeltas(prev: Msg[], deltas: Delta[]): Msg[] {
  let arr = prev;
  for (const d of deltas) {
    if (d.kind === 'append') arr = [...arr, d.msg];
    else arr = arr.map((m) => (m.role === 'tool' && m.toolUseId === d.toolUseId && m.output === undefined ? { ...m, output: d.output } : m));
  }
  return arr;
}

// ----- small presentational helpers --------------------------------------

const MarkdownText = memo(function MarkdownText({ text, theme, projectPath, onOpenFile }: {
  text: string;
  theme: Theme;
  projectPath?: string;
  onOpenFile?: (relPath: string) => void;
}) {
  const style = theme === 'light' ? oneLight : vscDarkPlus;
  const codeStyle = { margin: '4px 0', borderRadius: 4, fontSize: 11, padding: '6px 8px' };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a(props) { return <MarkdownLink {...props} projectPath={projectPath} onOpenFile={onOpenFile} />; },
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!match) return <code className={className} {...props}>{children}</code>;
          return (
            <SyntaxHighlighter PreTag="div" language={match[1]} style={style as any} customStyle={codeStyle}>
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
  if (!input || typeof input !== 'object') return <pre className="tool-field-value">{String(input ?? '')}</pre>;
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className="tool-field">
          <div className="tool-field-key">{k}</div>
          <pre className="tool-field-value">{typeof v === 'string' ? rel(v) : JSON.stringify(v, null, 2)}</pre>
        </div>
      ))}
    </>
  );
}

function summarizeTool(name: string, input: any, rel: (s: string) => string): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (keys: string[]) => {
    for (const k of keys) { const v = input[k]; if (typeof v === 'string' && v) return v; }
    return '';
  };
  let s = '';
  switch (name) {
    case 'Bash': s = pick(['description', 'command']); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick(['file_path', 'notebook_path']); break;
    case 'Glob': case 'Grep': s = pick(['pattern']); break;
    case 'WebFetch': s = pick(['url']); break;
    case 'WebSearch': s = pick(['query']); break;
    case 'Task': case 'Agent': s = pick(['description', 'prompt']); break;
    case 'AskUserQuestion': s = Array.isArray(input.questions) ? input.questions.map((q: any) => q?.header || '').filter(Boolean).join(', ') : ''; break;
    default: s = pick(['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']);
  }
  s = rel(s).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

function sendKeyHint(k: SendKey): string {
  switch (k) {
    case 'cmd-enter': return 'Ask Claude (SDK)… (⌘/Ctrl+Enter to send)';
    case 'shift-enter': return 'Ask Claude (SDK)… (Shift+Enter to send)';
    case 'enter': return 'Ask Claude (SDK)… (Enter to send)';
  }
}

type Catalog = {
  commands: Array<{ name: string; description: string; argumentHint?: string }>;
  agents: string[];
  models: Array<{ value: string; displayName: string; description?: string }>;
};

// ----- the panel ----------------------------------------------------------

export function SdkPanel({
  projectId,
  projectPath,
  resumeId,
  wire,
  initialPrompt,
  sendKey,
  theme,
  showStderr,
  richCopy,
  onTitle,
  onSessionId,
  onInitialPromptConsumed,
  onOpenFile,
  onActivity,
  onExportApi,
  onComment,
  commentMarks,
  onFocusComment,
  onBatchSent,
  onPanelApi,
}: {
  projectId: string;
  projectPath?: string;
  resumeId?: string;
  // Model: Tab.wire / web.WireCaptureSession — sent as wire=1 on every
  // handshake so the server routes this session through its wire proxy.
  wire?: boolean;
  // One-shot first message for a fresh session (Tab.initialPrompt); never on resume.
  initialPrompt?: string;
  sendKey: SendKey;
  theme: Theme;
  showStderr?: boolean;
  richCopy?: boolean;
  onTitle?: (title: string) => void;
  onSessionId?: (uuid: string) => void;
  onInitialPromptConsumed?: () => void;
  onOpenFile?: (relPath: string) => void;
  onActivity?: (a: TabActivity | null) => void;
  onExportApi?: (api: { open: () => void; canExport: boolean } | null) => void;
  // Review integration — same contract as ChatPanel (omitted when settings.review is off).
  onComment?: (c: NewComment) => string | null;
  commentMarks?: readonly CommentMark[];
  onFocusComment?: (commentId: string) => void;
  onBatchSent?: (batchId: string) => void;
  onPanelApi?: (api: SessionPanelApi | null) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toolPopout, setToolPopout] = useState<Msg | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [oldestIdx, setOldestIdx] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState('');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [wireOn, setWireOn] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [insertion, setInsertion] = useState<PromptInsertion | null>(null);
  const pendingInitialPromptRef = useRef<string | null>(initialPrompt?.trim() || null);
  const oldestIdxRef = useRef(0);
  const statusRef = useRef<Status>('connecting');
  const wireRef = useRef(!!wire); wireRef.current = !!wire;
  const [editingUuid, setEditingUuid] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [rewinding, setRewinding] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadOlderRef = useRef<HTMLButtonElement | null>(null);
  const stickyBottomRef = useRef(true);
  const beforePrependRef = useRef<{ height: number; top: number } | null>(null);
  const loadingMoreRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  oldestIdxRef.current = oldestIdx;
  statusRef.current = status;

  const wsRef = useRef<WebSocket | null>(null);
  const activeSessionIdRef = useRef<string | null>(resumeId ?? null);
  const closedByUsRef = useRef(false);
  const sessionExitedRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // Give up after this many connects that never reached `started` (parity
  // with ChatPanel): a dead server shouldn't keep a tab retrying forever.
  const failedConnectsRef = useRef(0);
  const gotStartedRef = useRef(false);
  const MAX_FAILED_CONNECTS = 3;
  const lastMessageAtRef = useRef(Date.now());
  const heartbeatTimerRef = useRef<number | null>(null);
  const PING_INTERVAL_MS = 25_000;
  const HEARTBEAT_DEAD_MS = 60_000;
  const VISIBILITY_STALE_MS = 30_000;

  // Streaming bookkeeping (rule-369): text/tool blocks created from
  // stream_event, matched to the complete `assistant` echo by message.id.
  const orphanResultsRef = useRef(new Map<string, string>());
  const currentAssistantIdRef = useRef<string | null>(null);
  const streamedAssistantIdsRef = useRef(new Set<string>());
  const streamBlocksRef = useRef(new Map<string, { ourMsgId: string; kind: 'text' | 'tool_use'; jsonBuf?: string; uuidAssigned?: boolean }>());

  // Latest callbacks for the mount-time WS handlers.
  const onTitleRef = useRef(onTitle); onTitleRef.current = onTitle;
  const onSessionIdRef = useRef(onSessionId); onSessionIdRef.current = onSessionId;
  const onActivityRef = useRef(onActivity); onActivityRef.current = onActivity;
  const onOpenFileRef = useRef(onOpenFile); onOpenFileRef.current = onOpenFile;
  const openFile = useCallback((p: string) => onOpenFileRef.current?.(p), []);
  const showStderrRef = useRef(showStderr); showStderrRef.current = showStderr;

  const rel = useMemo(() => makeRelPath(projectPath), [projectPath]);
  const attachments = useImageAttachments();
  const pendingImages = attachments.images;
  const modelCatalog = useClaudeModels();
  const { skills: aieSkills, agents: aieAgents, refresh: refreshCommands } = useAieCommands(projectId);
  const cliCatalog = useMemo<ClaudeCliCatalog | null>(
    () => (catalog ? { slashCommands: catalog.commands.map((c) => c.name), skills: [], agents: catalog.agents, terminalSlashCommands: [] } : null),
    [catalog],
  );
  const commands = useMemo(() => toCommandItems(aieSkills, aieAgents, cliCatalog), [aieSkills, aieAgents, cliCatalog]);

  // Export (⋮ → Export session). Same stale-closure note as ChatPanel: App
  // hands a fresh arrow per render, the underlying registerExportApi is stable.
  useEffect(() => {
    if (!onExportApi) return;
    onExportApi({ open: () => setExportOpen(true), canExport: msgs.length > 0 });
    return () => onExportApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);
  useEffect(() => {
    if (!onPanelApi) return;
    onPanelApi({
      reveal,
      insertPrompt: (text, batchId) => setInsertion((prev) => ({ seq: (prev?.seq ?? 0) + 1, text, batchId })),
    });
    return () => onPanelApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Review (model: web.CommentOnSelection / HighlightQuotes) — only when enabled.
  const canComment = !!onComment;
  const commentedAnchors = useMemo(() => new Set((commentMarks ?? []).map((m) => m.anchor)), [commentMarks]);
  const highlightOwner = useRef({}).current;
  useEffect(() => { applyQuoteHighlights(highlightOwner, scrollRef.current, canComment ? commentMarks ?? [] : []); });
  useEffect(() => () => applyQuoteHighlights(highlightOwner, null, []), [highlightOwner]);
  function submitComment(c: NewComment) {
    const note = onComment?.(c);
    if (note) showToast(note);
  }
  function sendComment(c: NewComment) {
    setInsertion((prev) => ({ seq: (prev?.seq ?? 0) + 1, text: composeComment(c) }));
  }

  // Model: web.RichCopy — 🍚 on assistant messages when the setting is on.
  const showRichCopy = !!richCopy;
  const { copy: copyRich, source: richCopySource } = useRichCopy(
    (text) => <MarkdownText text={text} theme={theme} projectPath={projectPath} onOpenFile={openFile} />,
    (ok) => showToast(ok ? 'Copied ✓' : 'Copy failed'),
  );

  // Escape closes the lightbox / tool popout (parity with ChatPanel).
  useEffect(() => {
    if (!lightbox && !toolPopout) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setLightbox(null); setToolPopout(null); } }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox, toolPopout]);

  function showToast(text: string, durationMs = 2500) {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
  }

  function append(m: Msg) { setMsgs((prev) => [...prev, m]); }

  function wsSend(payload: unknown) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  // ----- AskUserQuestion forms (rule-372) --------------------------------
  const toolCards = useMemo(
    () => msgs.flatMap((m) => (m.role === 'tool' && m.toolUseId ? [{ toolCallId: m.toolUseId, rawInput: m.input }] : [])),
    [msgs],
  );
  const forms = useElicitationHost({
    agentName: 'Claude',
    sendKey,
    scrollRef,
    cards: toolCards,
    showToast,
    respond: (req, content) => {
      wsSend(content
        ? { type: 'elicitation_response', id: req.id, action: 'accept', content: claudeAnswersFrom(req, content) }
        : { type: 'elicitation_response', id: req.id, action: 'decline' });
    },
    sendFollowUp: (text, images) => sendPrompt(text, images),
  });

  const generating = status === 'thinking';
  const awaitingInput = forms.elicitations.some((e) => !e.recap);
  useEffect(() => { onActivityRef.current?.({ generating, awaitingInput }); }, [generating, awaitingInput]);
  useEffect(() => () => onActivityRef.current?.(null), []);

  // ----- transcript ------------------------------------------------------
  async function refetchTranscript(sid: string) {
    try {
      const r = await fetch(`/api/projects/${projectId}/sdk-sessions/${sid}/transcript?limit=20`);
      if (!r.ok) return;
      const { events, startIndex } = await r.json();
      orphanResultsRef.current = new Map();
      setMsgs(buildFromEvents(events, orphanResultsRef.current));
      setOldestIdx(startIndex ?? 0);
    } catch {}
  }

  function loadOlder() { return loadOlderFrom(oldestIdxRef.current); }

  async function loadOlderFrom(before: number) {
    const sid = activeSessionIdRef.current;
    if (!sid || loadingMoreRef.current || before <= 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/sdk-sessions/${sid}/transcript?before=${before}&limit=20`);
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

  // Model: web.RevealMessage — scroll the anchored message into view, paging
  // back until it turns up; false = not in this session.
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

  // ----- WS lifecycle (rule-368 / rule-376) ------------------------------
  useEffect(() => {
    let aborted = false;
    closedByUsRef.current = false;
    sessionExitedRef.current = false;

    function openWs() {
      if (aborted || closedByUsRef.current) return;
      const params = new URLSearchParams({ project: projectId });
      const sid = activeSessionIdRef.current;
      if (sid) params.set('resume', sid);
      if (wireRef.current) params.set('wire', '1');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/sdk-session?${params.toString()}`);
      wsRef.current = ws;
      gotStartedRef.current = false;
      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        lastMessageAtRef.current = Date.now();
        if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = window.setInterval(() => {
          if (Date.now() - lastMessageAtRef.current > HEARTBEAT_DEAD_MS) { try { ws.close(); } catch {} return; }
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
        }, PING_INTERVAL_MS);
      };
      ws.onmessage = (ev) => {
        lastMessageAtRef.current = Date.now();
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        handleWsMsg(data);
      };
      ws.onclose = () => {
        if (heartbeatTimerRef.current) { window.clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
        if (wsRef.current === ws) wsRef.current = null;
        if (aborted || closedByUsRef.current || sessionExitedRef.current) { if (!sessionExitedRef.current) setStatus('closed'); return; }
        if (!gotStartedRef.current) {
          failedConnectsRef.current++;
          if (failedConnectsRef.current >= MAX_FAILED_CONNECTS) {
            append({ id: shortId(), role: 'system', text: 'Could not reach the session — refresh the tab (↻) to retry.' });
            setStatus('closed');
            return;
          }
        } else {
          failedConnectsRef.current = 0;
        }
        scheduleReconnect();
      };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }

    function scheduleReconnect() {
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      setStatus('reconnecting');
      reconnectTimerRef.current = window.setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (aborted) return;
        const sid = activeSessionIdRef.current;
        if (sid) await refetchTranscript(sid);
        if (aborted) return;
        openWs();
      }, delay);
    }

    async function start() {
      const sid = activeSessionIdRef.current;
      if (sid) {
        setStatus('replaying');
        await refetchTranscript(sid);
        if (aborted) return;
      }
      openWs();
    }

    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      if (!ws || sessionExitedRef.current) return;
      const stale = Date.now() - lastMessageAtRef.current > VISIBILITY_STALE_MS;
      if (stale || ws.readyState !== WebSocket.OPEN) { try { ws.close(); } catch {} }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    void start();
    return () => {
      aborted = true;
      closedByUsRef.current = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (heartbeatTimerRef.current) window.clearInterval(heartbeatTimerRef.current);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Read through refs by the mount-time handlers above.
  const handleWsMsgRef = useRef<(m: any) => void>(() => {});
  function handleWsMsg(m: any) { handleWsMsgRef.current(m); }
  handleWsMsgRef.current = (m: any) => {
    if (m.type === 'pong') return;
    if (m.type === 'started') {
      gotStartedRef.current = true;
      failedConnectsRef.current = 0;
      if (m.resumed) pendingInitialPromptRef.current = null;
      setStatus(m.thinking ? 'thinking' : 'ready');
      if (typeof m.sessionId === 'string' && m.sessionId) {
        activeSessionIdRef.current = m.sessionId;
        onSessionIdRef.current?.(m.sessionId);
      }
      if (m.model) setModel(m.model);
      else if (m.requestedModel) setModel((cur) => cur ?? m.requestedModel);
      if (typeof m.effort === 'string') setEffort(m.effort);
      setWireOn(m.wire === true);
      if (typeof m.title === 'string' && m.title) onTitleRef.current?.(m.title);
      if (Array.isArray(m.commands)) setCatalog({ commands: m.commands, agents: m.agents ?? [], models: m.models ?? [] });
      showToast(m.resumed ? (m.attached ? 'Attached to live session' : 'Resumed session') : 'Session started');
      return;
    }
    if (m.type === 'catalog') { setCatalog({ commands: m.commands ?? [], agents: m.agents ?? [], models: m.models ?? [] }); return; }
    if (m.type === 'title') { if (typeof m.title === 'string' && m.title) onTitleRef.current?.(m.title); return; }
    if (m.type === 'model') { if (typeof m.model === 'string') setModel(m.model); return; }
    if (m.type === 'effort') { const lvl = typeof m.effort === 'string' ? m.effort : ''; setEffort(lvl); showToast(lvl ? `Effort: ${lvl}` : 'Effort: default'); return; }
    if (m.type === 'effort_error' || m.type === 'rewind_error') { showToast(String(m.message ?? 'Request failed')); setRewinding(false); return; }
    if (m.type === 'stderr') {
      const text = String(m.data ?? '');
      if (showStderrRef.current || /^(ERROR|PANIC)/i.test(text)) append({ id: shortId(), role: 'system', text: `[stderr] ${text.trim()}` });
      return;
    }
    if (m.type === 'error') { append({ id: shortId(), role: 'system', text: `error: ${m.message}` }); return; }
    if (m.type === 'external_change') {
      showToast('External change detected, refreshing');
      if (activeSessionIdRef.current) void refetchTranscript(activeSessionIdRef.current);
      return;
    }
    if (m.type === 'exit') {
      sessionExitedRef.current = true;
      append({ id: shortId(), role: 'system', text: m.code === 'open-elsewhere' ? 'This session is open in another tab — closed here.' : 'session exited' });
      setStatus('closed');
      forms.clear();
      return;
    }
    if (m.type === 'user_echo') {
      // rule-370: our own (or another client's) prompt with its jsonl uuid.
      const deltas = renderEvent({ type: 'user', uuid: m.uuid, message: m.message });
      const bubble = deltas.find((d): d is Extract<Delta, { kind: 'append' }> => d.kind === 'append');
      if (!bubble || bubble.msg.role !== 'user') return;
      const msgId = typeof m.msgId === 'string' ? m.msgId : null;
      setMsgs((prev) => {
        if (msgId && prev.some((x) => x.role === 'user' && x.id === msgId)) {
          return prev.map((x) => (x.role === 'user' && x.id === msgId ? { ...x, uuid: m.uuid } : x));
        }
        return [...prev, bubble.msg];
      });
      setStatus('thinking');
      return;
    }
    if (m.type === 'ask') {
      const req = parseAskUserQuestion(m.data);
      if (req) forms.add(req);
      return;
    }
    if (m.type === 'ask_timeout') { forms.expire(m.id); return; }
    if (m.type === 'ask_cancel' || m.type === 'ask_done') { forms.settle(m.id, m.type === 'ask_done' ? 'Answered' : 'Cancelled'); return; }
    if (m.type === 'rewound') {
      currentAssistantIdRef.current = null;
      streamBlocksRef.current.clear();
      orphanResultsRef.current = new Map();
      setMsgs([]);
      forms.clear();
      setRewinding(false);
      setEditingUuid(null);
      setEditingText('');
      setStatus('thinking');
      if (typeof m.sessionId === 'string' && m.sessionId) {
        activeSessionIdRef.current = m.sessionId;
        onSessionIdRef.current?.(m.sessionId);
        void refetchTranscript(m.sessionId);
      }
      return;
    }
    if (m.type !== 'message') return;
    const ev = m.data;
    if (ev?.type === 'stream_event') { processStreamEvent(ev.event); return; }
    if (ev?.type === 'system' && ev.subtype === 'init') {
      if (ev.model) setModel(ev.model);
      if (typeof ev.session_id === 'string' && ev.session_id) {
        activeSessionIdRef.current = ev.session_id;
        onSessionIdRef.current?.(ev.session_id);
      }
      return;
    }
    if (ev?.type === 'result') {
      setStatus('ready');
      currentAssistantIdRef.current = null;
      return;
    }
    if (ev?.type === 'assistant' && ev.message?.id && streamedAssistantIdsRef.current.has(ev.message.id)) {
      patchStreamedUuid(ev.message.id, ev.uuid, ev.message.content);
      return;
    }
    if (ev?.type === 'assistant' || ev?.type === 'user') {
      setMsgs((prev) => applyDeltas(prev, renderEvent(ev)));
    }
  };

  // ----- streaming (rule-369) --------------------------------------------
  function blockKey(assistantId: string, idx: number) { return `${assistantId}#${idx}`; }

  function patchStreamedUuid(assistantId: string, uuid: unknown, content: unknown) {
    if (typeof uuid !== 'string') return;
    const streamedText = [...streamBlocksRef.current.entries()]
      .filter(([k, b]) => k.startsWith(`${assistantId}#`) && b.kind === 'text')
      .sort((a, b) => Number(a[0].split('#')[1]) - Number(b[0].split('#')[1]))
      .map(([, b]) => b);
    (Array.isArray(content) ? content : []).forEach((block: any, blockIdx: number) => {
      if (block?.type !== 'text') return;
      const blk = streamedText.find((b) => !b.uuidAssigned);
      if (!blk) return;
      blk.uuidAssigned = true;
      setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, uuid, blockIdx } : m)));
    });
  }

  function processStreamEvent(streamEv: any) {
    const t = streamEv?.type;
    if (t === 'message_start') {
      const msgId = streamEv.message?.id;
      if (msgId) {
        currentAssistantIdRef.current = msgId;
        for (const k of [...streamBlocksRef.current.keys()]) if (!k.startsWith(`${msgId}#`)) streamBlocksRef.current.delete(k);
        const set = streamedAssistantIdsRef.current;
        set.add(msgId);
        if (set.size > 256) { const first = set.values().next().value; if (first !== undefined) set.delete(first); }
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
        streamBlocksRef.current.set(blockKey(assistantId, idx), { ourMsgId, kind: 'tool_use', jsonBuf: '' });
        setMsgs((prev) => [...prev, { id: ourMsgId, role: 'tool', name: cb.name, input: {}, toolUseId: cb.id }]);
      }
      return;
    }
    if (t === 'content_block_delta') {
      const blk = streamBlocksRef.current.get(blockKey(assistantId, streamEv.index));
      if (!blk) return;
      const delta = streamEv.delta;
      if (delta?.type === 'text_delta' && blk.kind === 'text') {
        const piece: string = delta.text ?? '';
        setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'assistant' ? { ...m, text: m.text + piece } : m)));
      } else if (delta?.type === 'input_json_delta' && blk.kind === 'tool_use') {
        blk.jsonBuf = (blk.jsonBuf ?? '') + (delta.partial_json ?? '');
      }
      return;
    }
    if (t === 'content_block_stop') {
      const key = blockKey(assistantId, streamEv.index);
      const blk = streamBlocksRef.current.get(key);
      if (!blk) return;
      if (blk.kind === 'tool_use') {
        if (blk.jsonBuf) {
          try {
            const parsed = JSON.parse(blk.jsonBuf);
            setMsgs((prev) => prev.map((m) => (m.id === blk.ourMsgId && m.role === 'tool' ? { ...m, input: parsed } : m)));
          } catch {}
        }
        streamBlocksRef.current.delete(key);
      }
      return;
    }
    if (t === 'message_stop') currentAssistantIdRef.current = null;
  }

  // ----- sending (rule-371) ----------------------------------------------
  function sendPrompt(text: string, images: readonly ImageAttachment[]) {
    const msgId = shortId();
    append({ id: msgId, role: 'user', text, images: images.length ? images.map((p) => p.dataUrl) : undefined });
    wsSend({ type: 'user', text, images: toWireImages(images), msgId });
    setStatus('thinking');
  }

  function send(raw: string) {
    if (!wsRef.current || status === 'closed' || status === 'connecting' || status === 'reconnecting') return;
    const text = raw.trim();
    if (!text && pendingImages.length === 0) return;
    sendPrompt(text, pendingImages);
    attachments.clear();
  }

  function stop() { wsSend({ type: 'stop' }); }

  // Fire the one-shot initialPrompt once a fresh session is ready (rule-071).
  useEffect(() => {
    if (status !== 'ready') return;
    const text = pendingInitialPromptRef.current;
    if (!text) return;
    pendingInitialPromptRef.current = null;
    send(text);
    onInitialPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function switchModel(alias: string) {
    wsSend({ type: 'set_model', model: alias });
    setModel(alias);
    showToast(`Switching to ${alias}…`);
    setModelPickerOpen(false);
  }

  function switchEffort(level: string) {
    wsSend({ type: 'set_effort', effort: level });
    showToast('Applying effort…');
    setModelPickerOpen(false);
  }

  // ----- rewind (rule-373) -----------------------------------------------
  function startEditUser(m: Msg & { role: 'user' }) {
    if (!m.uuid) return;
    setEditingUuid(m.uuid);
    setEditingText(m.text);
  }
  function cancelEditUser() { setEditingUuid(null); setEditingText(''); }
  function submitRewind(orig: Msg & { role: 'user' }) {
    if (!orig.uuid || rewinding) return;
    const newText = editingText.trim();
    if (!newText) { showToast('Message cannot be empty'); return; }
    const images: { mediaType: string; data: string }[] = [];
    for (const dataUrl of orig.images ?? []) {
      const mm = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (mm) images.push({ mediaType: mm[1], data: mm[2] });
    }
    setRewinding(true);
    if (!wsSend({ type: 'rewind', messageUuid: orig.uuid, newText, images })) { setRewinding(false); showToast('Not connected'); }
  }

  // ----- scrolling -------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (beforePrependRef.current) {
      const { height, top } = beforePrependRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      beforePrependRef.current = null;
      return;
    }
    if (stickyBottomRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [msgs, forms.elicitations]);

  useEffect(() => {
    const el = loadOlderRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void loadOlder(); }, { root: scrollRef.current, threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oldestIdx, loadingMore]);

  function onMessagesScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickyBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  // ----- render ----------------------------------------------------------
  return (
    <div className="chat">
      <div className="chat-messages" ref={scrollRef} onScroll={onMessagesScroll}>
        {oldestIdx > 0 && (
          <button ref={loadOlderRef} className="load-older" onClick={() => void loadOlder()} disabled={loadingMore} type="button">
            {loadingMore ? 'Loading…' : `↑ Load older (${oldestIdx} above)`}
          </button>
        )}
        {msgs.map((m) => {
          const anchor = msgAnchor(m);
          const bmCls = canComment && !!anchor && commentedAnchors.has(anchor) ? ' commented' : '';
          if (m.role === 'user') {
            const isEditing = !!m.uuid && editingUuid === m.uuid;
            return (
              <div key={m.id} className={`msg msg-user${bmCls}`} data-anchor={anchor ?? undefined}>
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, i) => <img key={i} src={src} className="msg-image" alt="" onClick={() => setLightbox(src)} />)}
                  </div>
                )}
                {isEditing ? (
                  <div className="msg-user-edit">
                    <textarea
                      className="msg-user-edit-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        if (isSendKeyTrigger(sendKey, { ...e, isComposing: e.nativeEvent.isComposing })) {
                          e.preventDefault();
                          if (!rewinding && editingText.trim()) submitRewind(m);
                        }
                      }}
                      autoFocus
                      rows={Math.max(2, Math.min(10, editingText.split('\n').length))}
                    />
                    <div className="msg-user-edit-actions">
                      <button type="button" className="msg-user-edit-cancel" onClick={cancelEditUser} disabled={rewinding}>Cancel</button>
                      <button type="button" className="msg-user-edit-send" onClick={() => submitRewind(m)} disabled={rewinding || !editingText.trim()}>
                        {rewinding ? 'Rewinding…' : 'Resend'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {m.text && <div>{m.text}</div>}
                    {m.uuid && (
                      <button
                        type="button"
                        className="msg-user-edit-btn"
                        title="Revert to this point — discards later turns and rolls back any files claude changed since"
                        onClick={() => startEditUser(m)}
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
                {showRichCopy && <RichCopyButton onClick={() => copyRich(m.text)} />}
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
                onClick={() => setExpanded((prev) => { const next = new Set(prev); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next; })}
              >
                <span className="tool-chevron">{isOpen ? '▾' : '▸'}</span>
                <span className="tool-name">{m.name}</span>
                {summary && <span className="tool-summary">{summary}</span>}
                {m.output === undefined && <span className="tool-pending">…</span>}
                <button className="tool-popout-btn" onClick={(e) => { e.stopPropagation(); setToolPopout(m); }} title="Open full details" aria-label="Open full details">⛶</button>
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
              {forms.renderFor(m.toolUseId)}
            </div>
          );
        })}
        {forms.renderOrphans()}
        {status === 'thinking' && (
          <div className="msg msg-thinking" aria-label="Claude is thinking">
            <span className="thinking-dot" /><span className="thinking-dot" /><span className="thinking-dot" />
          </div>
        )}
      </div>
      {(() => {
        if (status === 'thinking' && !toast && !model) return null;
        const label = toast ?? (
          status === 'ready' ? 'Ready'
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
                <span className="chat-status-wire" title="This tab drives Claude through the Agent SDK bridge">sdk</span>
                {wireOn && (
                  <span className="chat-status-wire" title="Wire capture on: API requests/responses of this session are recorded under .aie/observations/wire/ (plaintext)">wire</span>
                )}
                {modelPickerOpen && (
                  <>
                    <div className="model-picker-backdrop" onClick={() => setModelPickerOpen(false)} />
                    <div className="model-picker">
                      {(() => {
                        const groups: { label: string; items: typeof modelCatalog.models }[] = [
                          { label: 'Aliases (auto-latest)', items: modelCatalog.aliases },
                          { label: 'Latest', items: modelCatalog.models.filter((mm) => mm.section === 'main') },
                          { label: 'Previous', items: modelCatalog.models.filter((mm) => mm.section !== 'main') },
                        ];
                        return groups.filter((g) => g.items.length > 0).map((g) => (
                          <div key={g.label} className="model-picker-group">
                            <div className="model-picker-group-label">{g.label}</div>
                            {g.items.map((mm) => (
                              <button key={mm.id} className={`model-picker-item ${mm.id === model ? 'current' : ''}`} onClick={() => switchModel(mm.id)} type="button" title={mm.description || ''}>
                                <span>{mm.name}</span>
                                <code className="model-picker-id">{mm.id}</code>
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
                              <div className="model-picker-group-label" style={{ padding: '4px 10px', opacity: 0.6 }}>Not supported by this model</div>
                            ) : (
                              <>
                                <button className={`model-picker-item ${effort === '' ? 'current' : ''}`} onClick={() => switchEffort('')} type="button" title="Let claude pick the per-model default">
                                  <span>Default</span>
                                  {eo.default && <code className="model-picker-id">{eo.default}</code>}
                                </button>
                                {eo.options.map((lvl) => (
                                  <button key={lvl} className={`model-picker-item ${effort === lvl ? 'current' : ''}`} onClick={() => switchEffort(lvl)} type="button"><span>{lvl}</span></button>
                                ))}
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}
      <ImageAttachmentStrip images={pendingImages} onRemove={attachments.remove} onOpen={setLightbox} />
      <ChatInput
        status={status}
        sendKey={sendKey}
        pendingImagesCount={pendingImages.length}
        readyPlaceholder={sendKeyHint(sendKey)}
        thinkingPlaceholder="Claude is working — type to queue / send another"
        commands={commands}
        onCommandsOpen={refreshCommands}
        onSend={send}
        insertion={insertion}
        onBatchSent={onBatchSent}
        onAddFiles={attachments.addFiles}
        onStop={stop}
        lock={forms.inputLock}
      />
      {canComment && <CommentComposer containerRef={scrollRef} onComment={submitComment} onSend={sendComment} highlightOwner={highlightOwner} onFocusComment={(id) => onFocusComment?.(id)} />}
      {richCopySource}
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportDialog projectId={projectId} messages={toExport(msgs)} source="claude" theme={theme} onClose={() => setExportOpen(false)} />
        </Suspense>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">×</button>
        </div>
      )}
      {toolPopout && toolPopout.role === 'tool' && (
        <div className="tool-popout-backdrop" onClick={() => setToolPopout(null)}>
          <div className="tool-popout-modal" onClick={(e) => e.stopPropagation()}>
            <div className="tool-popout-header">
              <span className="tool-name">{toolPopout.name}</span>
              <span className="tool-summary">{summarizeTool(toolPopout.name, toolPopout.input, rel)}</span>
              <button className="tool-popout-close" onClick={() => setToolPopout(null)} aria-label="Close">×</button>
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
    </div>
  );
}
