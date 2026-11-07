// Model: server.ClaudeSdkSessionBridge / ListSdkSessions / ReadSdkTranscript /
// RenameSession (package "Claude SDK Session"). The second Claude bridge: the
// same jsonl sessions as session.ts, but driven through the official Agent
// SDK instead of a hand-rolled stream-json subprocess. Deliberately shares no
// code with session.ts — projects/claude-sdk-session/design.md.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
  type Query,
  type SDKUserMessage,
  type CanUseTool,
  type PermissionResult,
  type SlashCommand,
  type ModelInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { getProject, getSettings } from './store.js';
import { getUserId } from './auth.js';
import { isEffortLevel } from './models.js';
import { markLive, unmarkLive, liveBridge } from './live-sessions.js';
import { registerWireSession, wireBaseUrl } from './observe/wire-proxy.js';
import { encodeCwd } from './observe/transcript.js';

// ----- input queue: one always-open async iterable per live query ---------

type InputQueue = {
  iterable: () => AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  close: () => void;
};

function makeInputQueue(): InputQueue {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* iterable() {
    while (!closed) {
      if (buf.length) {
        yield buf.shift()!;
        continue;
      }
      await new Promise<void>((r) => { wake = r; });
    }
  }
  return {
    iterable,
    push(m) { buf.push(m); const w = wake; wake = null; w?.(); },
    close() { closed = true; const w = wake; wake = null; w?.(); },
  };
}

// ----- entry ---------------------------------------------------------------

type PendingAsk = {
  input: Record<string, unknown>;
  toolUseID: string;
  resolve: (r: PermissionResult) => void;
  // Counts down only while no client is attached (rule: same as session.ts).
  timer: NodeJS.Timeout | null;
};

type SdkEntry = {
  cwd: string;
  sessionId: string | null; // claude's session_id (null until system.init)
  q: Query | null;
  queue: InputQueue;
  // Bumped on every re-create (effort change, rewind, kill) so the pump of
  // a replaced query ignores its tail.
  generation: number;
  clients: Set<WebSocket>;
  thinking: boolean;
  model: string | null;
  requestedModel: string;
  effort: string;
  // Model: Claude Session.observeWire — route this session's API calls
  // through the built-in wire proxy (env ANTHROPIC_BASE_URL). Carried over on
  // every re-create (effort change, rewind).
  observeWire: boolean;
  title: string | null;
  commands: SlashCommand[];
  agents: string[];
  models: ModelInfo[];
  pendingAsks: Map<string, PendingAsk>;
  killTimer?: NodeJS.Timeout;
  titleTimers: NodeJS.Timeout[];
  // External-change detection (rule-406): any SDK message or user input is
  // "our" activity; a jsonl write outside the quiet window is someone else's.
  lastActivity: number;
  externalNotified: boolean;
  watcher?: nodeFs.FSWatcher;
  externalTimer?: NodeJS.Timeout;
};

const byId = new Map<string, SdkEntry>();
// Fresh sessions between query() and system.init.
const pending = new Set<SdkEntry>();

const CLIENT_DRAIN_GRACE_MS = 5 * 60_000;
const ASK_IDLE_TIMEOUT_MS = 5 * 60_000;
const PING_INTERVAL_MS = 30_000;
const EXTERNAL_QUIET_MS = 30_000;

function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

function startWatcher(entry: SdkEntry) {
  if (entry.watcher || !entry.sessionId) return;
  const file = jsonlPathFor(entry.cwd, entry.sessionId);
  try {
    entry.watcher = nodeFs.watch(file, () => {
      if (Date.now() - entry.lastActivity < EXTERNAL_QUIET_MS) return;
      if (entry.externalNotified) return;
      if (entry.externalTimer) clearTimeout(entry.externalTimer);
      entry.externalTimer = setTimeout(() => {
        if (entry.externalNotified) return;
        entry.externalNotified = true;
        broadcast(entry, { type: 'external_change', sessionId: entry.sessionId });
      }, 400);
    });
  } catch {
    setTimeout(() => { if (!entry.watcher && entry.q) startWatcher(entry); }, 1000);
  }
}

function stopWatcher(entry: SdkEntry) {
  if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = undefined; }
  if (entry.externalTimer) { clearTimeout(entry.externalTimer); entry.externalTimer = undefined; }
}

function touchActivity(entry: SdkEntry) {
  entry.lastActivity = Date.now();
  entry.externalNotified = false;
}

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

function broadcast(entry: SdkEntry, msg: unknown, except?: WebSocket) {
  const raw = JSON.stringify(msg);
  for (const c of entry.clients) {
    if (c === except) continue;
    try { c.send(raw); } catch {}
  }
}

function sdkEnv(observeWire: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  // Same as session.ts: non-interactive runs only checkpoint files with this set.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1';
  // Model: server.ObserveWireSession — the SDK runs the same claude binary,
  // which honours ANTHROPIC_BASE_URL like the cli bridge's spawn does.
  const wire = observeWire ? wireBaseUrl() : null;
  if (wire) env.ANTHROPIC_BASE_URL = wire;
  return env;
}

function makeCanUseTool(entry: SdkEntry): CanUseTool {
  return async (toolName, input, opts) => {
    // bypassPermissions already auto-allows everything else; the SDK still
    // consults us for AskUserQuestion because it needs a human.
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const id = opts.requestId;
    return new Promise<PermissionResult>((resolve) => {
      const ask: PendingAsk = { input, toolUseID: opts.toolUseID, resolve, timer: null };
      entry.pendingAsks.set(id, ask);
      if (entry.clients.size === 0) armAsk(entry, id);
      opts.signal.addEventListener('abort', () => {
        if (entry.pendingAsks.delete(id)) {
          if (ask.timer) clearTimeout(ask.timer);
          broadcast(entry, { type: 'ask_cancel', id });
          resolve({ behavior: 'deny', message: 'Interrupted' });
        }
      });
      broadcast(entry, { type: 'ask', data: askEvent(id, ask) });
    });
  };
}

// Shaped like the CLI's control_request so the web side can parse both
// bridges with the same lib/elicitation.parseAskUserQuestion.
function askEvent(id: string, ask: PendingAsk) {
  return {
    type: 'control_request',
    request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: ask.input, tool_use_id: ask.toolUseID },
  };
}

function armAsk(entry: SdkEntry, id: string) {
  const ask = entry.pendingAsks.get(id);
  if (!ask || ask.timer) return;
  ask.timer = setTimeout(() => {
    if (!entry.pendingAsks.delete(id)) return;
    ask.resolve({ behavior: 'deny', message: 'No one answered the question in time. Stop and wait for the next user message.' });
    broadcast(entry, { type: 'ask_timeout', id });
  }, ASK_IDLE_TIMEOUT_MS);
}

function armAllAsks(entry: SdkEntry) { for (const id of entry.pendingAsks.keys()) armAsk(entry, id); }
function disarmAllAsks(entry: SdkEntry) {
  for (const a of entry.pendingAsks.values()) { if (a.timer) { clearTimeout(a.timer); a.timer = null; } }
}
function denyAllAsks(entry: SdkEntry, message: string) {
  for (const [id, a] of entry.pendingAsks) {
    if (a.timer) clearTimeout(a.timer);
    a.resolve({ behavior: 'deny', message });
    entry.pendingAsks.delete(id);
  }
}

// ----- query lifecycle -----------------------------------------------------

function startQuery(entry: SdkEntry, opts: { resume?: string; resumeSessionAt?: string }) {
  entry.generation++;
  const gen = entry.generation;
  entry.queue = makeInputQueue();
  const q = query({
    prompt: entry.queue.iterable(),
    options: {
      cwd: entry.cwd,
      model: entry.requestedModel || undefined,
      effort: isEffortLevel(entry.effort) ? entry.effort : undefined,
      resume: opts.resume,
      resumeSessionAt: opts.resumeSessionAt,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      enableFileCheckpointing: true,
      env: sdkEnv(entry.observeWire),
      pathToClaudeCodeExecutable: process.env.REMOTE_IDE_SDK_CLAUDE_PATH || undefined,
      stderr: (data) => broadcast(entry, { type: 'stderr', data }),
      canUseTool: makeCanUseTool(entry),
    },
  });
  entry.q = q;
  void q.initializationResult().then((init) => {
    if (gen !== entry.generation) return;
    entry.commands = init.commands ?? [];
    entry.agents = (init.agents ?? []).map((a: any) => String(a?.name ?? '')).filter(Boolean);
    entry.models = init.models ?? [];
    broadcast(entry, { type: 'catalog', ...catalogOf(entry) });
  }).catch(() => {});
  void pump(entry, q, gen);
}

async function pump(entry: SdkEntry, q: Query, gen: number) {
  try {
    for await (const m of q) {
      if (gen !== entry.generation) return;
      onSdkMessage(entry, m as any);
    }
  } catch (e) {
    if (gen !== entry.generation) return;
    broadcast(entry, { type: 'error', message: String(e) });
  }
  if (gen !== entry.generation) return;
  // Streaming input never ends on its own — reaching here means the process
  // died under us.
  broadcast(entry, { type: 'exit' });
  teardown(entry);
}

function onSdkMessage(entry: SdkEntry, m: any) {
  touchActivity(entry);
  if (m?.type === 'system' && m?.subtype === 'init') {
    const sid: string | undefined = m.session_id;
    if (sid && entry.sessionId !== sid) {
      if (entry.sessionId) { byId.delete(entry.sessionId); unmarkLive(entry.sessionId, 'sdk'); }
      entry.sessionId = sid;
      byId.set(sid, entry);
      markLive(sid, 'sdk');
      pending.delete(entry);
      if (entry.observeWire) registerWireSession(sid, entry.cwd);
      stopWatcher(entry);
      startWatcher(entry);
    }
    if (typeof m.model === 'string') entry.model = m.model;
  }
  if (m?.type === 'result') {
    entry.thinking = false;
    scheduleTitleRefresh(entry);
    if (entry.clients.size === 0) scheduleKillIfIdle(entry);
  }
  broadcast(entry, { type: 'message', data: m });
}

function catalogOf(entry: SdkEntry) {
  return {
    commands: entry.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
    agents: entry.agents,
    models: entry.models.map((mm) => ({ value: mm.value, displayName: mm.displayName, description: mm.description })),
  };
}

// AI title (SDKSessionInfo.summary) lands a few seconds after the first
// result; re-check twice. Manual renames come through the same field.
function scheduleTitleRefresh(entry: SdkEntry) {
  for (const t of entry.titleTimers) clearTimeout(t);
  entry.titleTimers = [2500, 8000].map((ms) => setTimeout(() => void refreshTitle(entry), ms));
}

async function refreshTitle(entry: SdkEntry) {
  if (!entry.sessionId) return;
  try {
    const info = await getSessionInfo(entry.sessionId, { dir: entry.cwd });
    const t = info?.summary?.trim();
    if (t && t !== entry.title) {
      entry.title = t;
      broadcast(entry, { type: 'title', title: t });
    }
  } catch {}
}

function scheduleKillIfIdle(entry: SdkEntry) {
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined;
    if (entry.clients.size > 0) return;
    if (entry.thinking || entry.pendingAsks.size > 0) { scheduleKillIfIdle(entry); return; }
    destroy(entry);
  }, CLIENT_DRAIN_GRACE_MS);
}

function teardown(entry: SdkEntry) {
  stopWatcher(entry);
  denyAllAsks(entry, 'Session ended');
  for (const t of entry.titleTimers) clearTimeout(t);
  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
  if (entry.sessionId) { byId.delete(entry.sessionId); unmarkLive(entry.sessionId, 'sdk'); }
  pending.delete(entry);
  for (const c of entry.clients) { try { c.close(); } catch {} }
  entry.clients.clear();
}

function destroy(entry: SdkEntry) {
  entry.generation++;
  try { entry.q?.close(); } catch {}
  entry.queue.close();
  entry.q = null;
  teardown(entry);
}

function userMessage(uuid: string, text: string, images: Array<{ mediaType?: string; data?: string }> | undefined): SDKUserMessage {
  const content: any[] = [];
  if (text) content.push({ type: 'text', text });
  for (const img of images ?? []) {
    if (!img?.mediaType || !img?.data) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  return { type: 'user', uuid: uuid as any, message: { role: 'user', content }, parent_tool_use_id: null };
}

// Poll until the CLI has persisted the user record with this uuid (so a
// client refetch after `rewound` sees the new prompt).
async function waitForUserRecord(entry: SdkEntry, uuid: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.sessionId) {
      try {
        const msgs = await getSessionMessages(entry.sessionId, { dir: entry.cwd });
        if (msgs.some((m) => m.uuid === uuid)) return;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ----- WS client handling --------------------------------------------------

function attachClient(entry: SdkEntry, socket: WebSocket) {
  if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
  entry.clients.add(socket);
  disarmAllAsks(entry);

  let alive = true;
  const pingTimer = setInterval(() => {
    if (!alive) { try { socket.terminate(); } catch {} return; }
    alive = false;
    try { socket.ping(); } catch {}
  }, PING_INTERVAL_MS);
  socket.on('pong', () => { alive = true; });

  socket.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { send(socket, { type: 'error', message: 'invalid json' }); return; }
    void handleClientMessage(entry, socket, msg);
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    entry.clients.delete(socket);
    if (entry.clients.size === 0) {
      armAllAsks(entry);
      scheduleKillIfIdle(entry);
    }
  });
}

async function handleClientMessage(entry: SdkEntry, socket: WebSocket, msg: any) {
  if (msg.type === 'ping') { send(socket, { type: 'pong' }); return; }
  if (!entry.q) { send(socket, { type: 'error', message: 'session is not live' }); return; }

  if (msg.type === 'user') {
    const text = String(msg.text ?? '');
    const images = Array.isArray(msg.images) ? msg.images : [];
    if (!text && images.length === 0) return;
    const uuid = randomUUID();
    const um = userMessage(uuid, text, images);
    entry.thinking = true;
    touchActivity(entry);
    // The SDK does not echo our own prompts back; every client (sender
    // included) learns the uuid from this frame.
    broadcast(entry, { type: 'user_echo', msgId: typeof msg.msgId === 'string' ? msg.msgId : null, uuid, message: um.message });
    entry.queue.push(um);
    return;
  }
  if (msg.type === 'stop') {
    try { await entry.q.interrupt(); } catch (e) { send(socket, { type: 'error', message: `interrupt failed: ${String(e)}` }); }
    return;
  }
  if (msg.type === 'set_model') {
    const model = String(msg.model ?? '').trim();
    if (!model) return;
    try {
      await entry.q.setModel(model);
      entry.model = model;
      entry.requestedModel = model;
      broadcast(entry, { type: 'model', model });
    } catch (e) {
      send(socket, { type: 'error', message: `set_model failed: ${String(e)}` });
    }
    return;
  }
  if (msg.type === 'set_effort') {
    // No setEffort in the SDK control protocol: re-create the query on the
    // same session (same approach as session.ts' respawn).
    const effort = String(msg.effort ?? '').trim();
    if (effort && !isEffortLevel(effort)) { send(socket, { type: 'effort_error', message: `invalid effort level: ${effort}` }); return; }
    if (entry.thinking) { send(socket, { type: 'effort_error', message: 'wait for the current turn to finish before changing effort' }); return; }
    if (!entry.sessionId) { send(socket, { type: 'effort_error', message: 'session not initialized yet — send a message first' }); return; }
    replaceQuery(entry, { resume: entry.sessionId });
    entry.effort = effort;
    // effort is read by startQuery, so set it before the re-create.
    broadcast(entry, { type: 'effort', effort });
    return;
  }
  if (msg.type === 'elicitation_response') {
    const id = String(msg.id ?? '');
    const ask = entry.pendingAsks.get(id);
    if (!ask) return;
    entry.pendingAsks.delete(id);
    if (ask.timer) clearTimeout(ask.timer);
    if (msg.action === 'accept' && msg.content && typeof msg.content === 'object') {
      ask.resolve({ behavior: 'allow', updatedInput: { ...ask.input, answers: msg.content } });
    } else {
      ask.resolve({ behavior: 'deny', message: 'The user chose to reply in chat instead of answering the form. Stop and wait for their next message.' });
    }
    broadcast(entry, { type: 'ask_done', id });
    return;
  }
  if (msg.type === 'rewind') {
    await handleRewind(entry, socket, msg);
    return;
  }
}

// Close the live query and start another on the same entry. Clients stay
// attached; pending asks are denied (their tool call died with the process).
function replaceQuery(entry: SdkEntry, opts: { resume?: string; resumeSessionAt?: string }) {
  stopWatcher(entry);
  denyAllAsks(entry, 'Session restarted');
  const old = entry.q;
  entry.generation++;
  entry.queue.close();
  try { old?.close(); } catch {}
  entry.thinking = false;
  startQuery(entry, opts);
  touchActivity(entry);
  startWatcher(entry);
}

// Model: rewind on the SDK bridge — rewindFiles() for the working tree, then
// resume the same session truncated at the entry before the edited message
// (resumeSessionAt keeps the transcript file; getSessionMessages follows the
// new chain). Editing the first message starts a fresh session instead.
async function handleRewind(entry: SdkEntry, socket: WebSocket, msg: any) {
  const messageUuid = String(msg.messageUuid ?? '').trim();
  const newText = String(msg.newText ?? '').trim();
  const images = Array.isArray(msg.images) ? msg.images : [];
  const fail = (message: string) => send(socket, { type: 'rewind_error', message });
  if (!messageUuid) return fail('messageUuid required');
  if (!newText && images.length === 0) return fail('newText or images required');
  const sid = entry.sessionId;
  const q = entry.q;
  if (!sid || !q) return fail('session not initialized yet');
  if (entry.thinking) return fail('wait for the current turn to finish before rewinding');

  let msgs;
  try { msgs = await getSessionMessages(sid, { dir: entry.cwd }); } catch (e) { return fail(`transcript unavailable: ${String(e)}`); }
  const idx = msgs.findIndex((m) => m.type === 'user' && m.uuid === messageUuid);
  if (idx < 0) return fail('messageUuid not found among user messages');
  const pred = idx > 0 ? msgs[idx - 1].uuid : null;

  try {
    const r = await q.rewindFiles(messageUuid);
    if (r.error) return fail(`file rewind failed: ${r.error}`);
  } catch (e) {
    return fail(`file rewind failed: ${String(e)}`);
  }

  if (pred) {
    replaceQuery(entry, { resume: sid, resumeSessionAt: pred });
  } else {
    byId.delete(sid);
    unmarkLive(sid, 'sdk');
    entry.sessionId = null;
    entry.title = null;
    pending.add(entry);
    replaceQuery(entry, {});
  }
  const uuid = randomUUID();
  const um = userMessage(uuid, newText, images);
  entry.thinking = true;
  entry.queue.push(um);
  await waitForUserRecord(entry, uuid, 8000);
  broadcast(entry, { type: 'rewound', sessionId: entry.sessionId, uuid });
}

function startedFrame(entry: SdkEntry, attached: boolean) {
  return {
    type: 'started',
    sessionId: entry.sessionId,
    resumed: !!entry.sessionId,
    attached,
    clients: entry.clients.size,
    thinking: entry.thinking,
    model: entry.model,
    requestedModel: entry.requestedModel || null,
    effort: entry.effort,
    wire: entry.observeWire,
    title: entry.title,
    ...catalogOf(entry),
  };
}

// ----- routes --------------------------------------------------------------

export function registerSdkSessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project?: string; resume?: string; wire?: string } }>(
    '/ws/sdk-session',
    { websocket: true },
    async (socket, req) => {
      const uid = getUserId(req as any);
      if (!uid) { send(socket, { type: 'error', message: 'unauthorized' }); try { socket.close(); } catch {} return; }
      const projectId = req.query.project;
      const resumeId = req.query.resume || undefined;
      const project = projectId ? await getProject(uid, projectId) : null;
      if (!project) { send(socket, { type: 'error', message: 'project required or not found' }); try { socket.close(); } catch {} return; }

      // Attach to the live entry when the session is already running.
      if (resumeId && byId.has(resumeId)) {
        const entry = byId.get(resumeId)!;
        attachClient(entry, socket);
        send(socket, startedFrame(entry, true));
        for (const [id, ask] of entry.pendingAsks) send(socket, { type: 'ask', data: askEvent(id, ask) });
        return;
      }

      // Claude Session invariant (rule-394): refuse a session the cli bridge
      // is driving — two processes would interleave writes to one jsonl.
      if (resumeId && liveBridge(resumeId) === 'cli') {
        send(socket, { type: 'error', message: 'This session is open in a Claude tab — use that tab, or close it first.' });
        send(socket, { type: 'exit', code: 'open-elsewhere' });
        try { socket.close(); } catch {}
        return;
      }

      const settings = await getSettings(uid);
      // Model: web.WireCaptureSession → server.ObserveWireSession. Honoured
      // only while the proxy is listening; `started.wire` tells the client.
      const observeWire = req.query.wire === '1' && wireBaseUrl() !== null;
      if (observeWire && resumeId) registerWireSession(resumeId, project.path);
      const entry: SdkEntry = {
        cwd: project.path,
        sessionId: resumeId ?? null,
        q: null,
        queue: makeInputQueue(),
        generation: 0,
        clients: new Set(),
        thinking: false,
        model: null,
        requestedModel: settings.model || '',
        effort: isEffortLevel(settings.effort) ? settings.effort : '',
        observeWire,
        title: null,
        commands: [],
        agents: [],
        models: [],
        pendingAsks: new Map(),
        titleTimers: [],
        lastActivity: Date.now(),
        externalNotified: false,
      };
      if (resumeId) { byId.set(resumeId, entry); markLive(resumeId, 'sdk'); }
      else pending.add(entry);
      if (resumeId) {
        try { entry.title = (await getSessionInfo(resumeId, { dir: project.path }))?.summary?.trim() || null; } catch {}
      }
      startQuery(entry, { resume: resumeId });
      if (resumeId) startWatcher(entry);
      attachClient(entry, socket);
      send(socket, startedFrame(entry, false));
    },
  );

  // Model: server.ListSdkSessions — the same jsonl directory as ListSessions,
  // read through the SDK so the row title is its summary (custom title → AI
  // title → first prompt).
  app.get<{ Params: { id: string } }>('/api/projects/:id/sdk-sessions', async (req, reply) => {
    const uid = getUserId(req);
    if (!uid) return reply.code(401).send({ error: 'unauthorized' });
    const project = await getProject(uid, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const list = await listSessions({ dir: project.path, includeWorktrees: false });
    return {
      sessions: list.map((s) => ({
        sessionId: s.sessionId,
        title: s.summary,
        customTitle: s.customTitle ?? null,
        firstPrompt: s.firstPrompt ?? null,
        lastModified: s.lastModified,
        liveIn: liveBridge(s.sessionId),
      })),
    };
  });

  // Model: server.ReadSdkTranscript — getSessionMessages() paged the same
  // way as ReadTranscript: events + startIndex/endIndex/total.
  app.get<{ Params: { id: string; sid: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/projects/:id/sdk-sessions/:sid/transcript',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      let msgs;
      try { msgs = await getSessionMessages(req.params.sid, { dir: project.path }); }
      catch { return reply.code(404).send({ error: 'session transcript not found' }); }
      const total = msgs.length;
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const before = req.query.before != null ? Number(req.query.before) : total;
      const endIndex = Math.max(0, Math.min(total, Number.isFinite(before) ? before : total));
      const startIndex = Math.max(0, endIndex - limit);
      const events = msgs.slice(startIndex, endIndex).map((m) => ({ type: m.type, uuid: m.uuid, message: m.message }));
      return { events, startIndex, endIndex, total };
    },
  );

  // Model: server.RenameSession — appends a custom-title record; the resume
  // list and any live tab pick it up as the session's summary.
  app.post<{ Params: { id: string; sid: string }; Body: { title?: string } }>(
    '/api/projects/:id/sdk-sessions/:sid/rename',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const title = String(req.body?.title ?? '').trim();
      if (!title) return reply.code(400).send({ error: 'title required' });
      try { await renameSession(req.params.sid, title, { dir: project.path }); }
      catch (e) { return reply.code(500).send({ error: `rename failed: ${String(e)}` }); }
      const entry = byId.get(req.params.sid);
      if (entry) { entry.title = title; broadcast(entry, { type: 'title', title }); }
      return { ok: true, title };
    },
  );
}
