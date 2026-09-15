import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { WebSocket } from '@fastify/websocket';
import { getProject } from './store.js';
import { getUserId } from './auth.js';

// Devin ACP integration. Kept fully independent of session.ts (Claude
// stream-json) so the two agents don't share state or code paths — a bug in
// one bridge can't take down the other.

type DevinSessionEntry = {
  proc: ChildProcessWithoutNullStreams;
  cwd: string;
  // ACP sessionId — slug like "purrfect-opinion". Null until session/new (or
  // session/load) response arrives.
  sessionId: string | null;
  clients: Set<WebSocket>;
  // Has the agent's initialize response come back? Other requests must wait.
  initialized: boolean;
  // Buffered client requests that arrived before initialize completed.
  pendingClientReqs: Array<{ socket: WebSocket; msg: any }>;
  // Most recently observed mode and model — cached so re-attaching clients
  // get current state without waiting for a fresh notification.
  currentModeId: string | null;
  configOptions: any[] | null;
  // Slash commands the agent advertised via `available_commands_update`
  // (built-ins + skills). Sent before session/new completes, so a client
  // that attaches later would never see it — replayed in `started`.
  availableCommands: any[] | null;
  // Auto-incrementing JSON-RPC id pool for client→agent messages we generate
  // on behalf of websocket clients.
  rpcSeq: number;
  // True while a session/prompt RPC is pending. Mirrors session.ts.thinking
  // so a re-attaching client can restore the spinner.
  promptPending: boolean;
  // Agent→client RPCs awaiting a response. Keyed by the agent-generated id.
  // Currently only session/request_permission is forwarded; everything else
  // (fs/*, terminal/*) is auto-rejected inline.
  pendingAgentRpcs: Map<number | string, NodeJS.Timeout>;
  killTimer?: NodeJS.Timeout;
};

// How long we'll wait for a client to answer a permission prompt before
// auto-rejecting on its behalf. Long enough that a user has time to read,
// short enough that the agent doesn't hang forever if the tab was closed.
const PERMISSION_TIMEOUT_MS = 5 * 60_000;

const CLIENT_DRAIN_GRACE_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 30_000;

// WS heartbeat: send a ping every PING_INTERVAL_MS; if the previous round's
// pong never arrived, terminate the socket so the entry can drain. Without
// this a TCP connection silently dropped by NAT/OS sleep leaves a zombie
// client in entry.clients forever.
const PING_INTERVAL_MS = 30_000;

// Live sessions keyed by ACP sessionId. New sessions (no id yet) live in
// `pending`. Same pattern as session.ts.
const bySessionId = new Map<string, DevinSessionEntry>();
const pending = new Set<DevinSessionEntry>();

// Persisted session config — survives subprocess kill *and* server restart so
// we can restore model/mode when a new process loads the same session.
// In-memory map is the hot path; a JSON file on disk is the durable backing.
type SavedConfig = { model?: string; modeId?: string };
const savedSessionConfig = new Map<string, SavedConfig>();

const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || nodePath.join(nodeOs.homedir(), '.config', 'remote-ide');
const SAVED_CONFIG_PATH = nodePath.join(CONFIG_DIR, 'devin-config-cache.json');

function loadSavedConfigFromDisk() {
  try {
    const raw = nodeFs.readFileSync(SAVED_CONFIG_PATH, 'utf8');
    const obj = JSON.parse(raw) as Record<string, SavedConfig>;
    for (const [k, v] of Object.entries(obj)) {
      if (v) savedSessionConfig.set(k, v);
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
}
loadSavedConfigFromDisk();

function flushSavedConfigToDisk() {
  const obj: Record<string, SavedConfig> = Object.fromEntries(savedSessionConfig);
  try {
    nodeFs.mkdirSync(nodePath.dirname(SAVED_CONFIG_PATH), { recursive: true });
    nodeFs.writeFileSync(SAVED_CONFIG_PATH, JSON.stringify(obj, null, 2));
  } catch {
    // Best-effort — don't crash if disk write fails.
  }
}

function extractCurrentModel(configOptions: any[] | null): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const opt = configOptions.find((c: any) => c.id === 'model');
  return opt?.currentValue || undefined;
}

function persistSessionConfig(entry: DevinSessionEntry) {
  if (!entry.sessionId) return;
  const model = extractCurrentModel(entry.configOptions);
  const modeId = entry.currentModeId || undefined;
  if (model || modeId) {
    savedSessionConfig.set(entry.sessionId, { model, modeId });
    flushSavedConfigToDisk();
  }
}

// devin lives in ~/.local/bin on this host but the launchd plist has a
// minimal PATH (/usr/local/bin:/usr/bin:/bin). Prepend likely user-bin
// locations so the spawn finds it regardless of how the parent was started.
function devinEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '';
  const extras = [`${home}/.local/bin`, `${home}/bin`].filter(Boolean);
  const path = [...extras, process.env.PATH ?? ''].filter(Boolean).join(':');
  return { ...process.env, PATH: path };
}

// Pin to a specific devin version to avoid migration mismatch issues.
// Update this when upgrading to a new stable version.
const DEVIN_BIN = (() => {
  const pinned = nodePath.join(
    nodeOs.homedir(), '.local', 'share', 'devin', 'cli', '_versions', '3000.6.7', 'bin', 'devin',
  );
  if (nodeFs.existsSync(pinned)) return pinned;
  return 'devin'; // fall back to PATH
})();

function spawnDevin(cwd: string): ChildProcessWithoutNullStreams {
  // --permission-mode dangerous auto-approves every tool call so we never get
  // session/request_permission requests (we don't have UI for them yet).
  return spawn(DEVIN_BIN, ['--permission-mode', 'dangerous', 'acp'], {
    cwd,
    env: devinEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

function broadcast(entry: DevinSessionEntry, msg: unknown, except?: WebSocket) {
  const payload = JSON.stringify(msg);
  for (const c of entry.clients) {
    if (c === except) continue;
    try { c.send(payload); } catch {}
  }
}

function writeRpc(entry: DevinSessionEntry, obj: unknown) {
  try { entry.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
}

function nextRpcId(entry: DevinSessionEntry): number {
  // Positive integers only — the ACP Rust SDK rejects negative ids with
  // "Transport parse error" and drops the whole line. Start at 100 to leave
  // room for the bootstrap ids (0 = initialize, 1 = session/new|load).
  if (entry.rpcSeq < 100) entry.rpcSeq = 100;
  return entry.rpcSeq++;
}

function scheduleKillIfIdle(entry: DevinSessionEntry) {
  if (entry.clients.size > 0) return;
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined;
    if (entry.clients.size > 0) return;
    if (entry.promptPending) return;
    persistSessionConfig(entry);
    try { entry.proc.kill('SIGTERM'); } catch {}
    if (entry.sessionId) bySessionId.delete(entry.sessionId);
    pending.delete(entry);
  }, CLIENT_DRAIN_GRACE_MS);
}

// Forward an inbound client message to the ACP subprocess. Only valid after
// initialize has returned and session has been opened (sessionId known).
// `sender` (when present) is excluded from broadcasts so the originating
// client's optimistic local-append isn't duplicated.
function handleClientMessage(entry: DevinSessionEntry, msg: any, sender?: WebSocket) {
  if (!entry.sessionId) return; // shouldn't happen — buffered before init

  if (msg.type === 'user') {
    const text = typeof msg.text === 'string' ? msg.text : '';
    const images: Array<{ mediaType: string; data: string }> = Array.isArray(msg.images) ? msg.images : [];
    const content: any[] = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images) {
      if (!img?.mediaType || !img?.data) continue;
      // ACP image content block — base64 data, mimeType (not media_type as in
      // Anthropic's stream-json). promptCapabilities.image is advertised as
      // true on initialize.
      content.push({ type: 'image', mimeType: img.mediaType, data: img.data });
    }
    if (content.length === 0) return;

    // Devin's session/update stream only emits user_message_chunk during a
    // session/load replay — it does NOT echo the current turn's prompts back.
    // Synthesize one chunk per content block so (a) the history buffer used
    // for re-attach replay includes the user's own messages, and (b) any
    // additional attached clients see them. The originating client is excluded
    // because it has already optimistically rendered the message locally.
    for (const block of content) {
      const note = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: entry.sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: block },
        },
      };
      broadcast(entry, { type: 'acp', data: note }, sender);
    }

    entry.promptPending = true;
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: nextRpcId(entry),
      method: 'session/prompt',
      params: { sessionId: entry.sessionId, prompt: content },
    });
    return;
  }

  if (msg.type === 'cancel') {
    writeRpc(entry, {
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: entry.sessionId },
    });
    return;
  }

  if (msg.type === 'set_mode') {
    const modeId = typeof msg.modeId === 'string' ? msg.modeId : '';
    if (!modeId) return;
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: nextRpcId(entry),
      method: 'session/set_mode',
      params: { sessionId: entry.sessionId, modeId },
    });
    return;
  }

  if (msg.type === 'set_config') {
    const configId = typeof msg.configId === 'string' ? msg.configId : '';
    if (!configId) return;
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: nextRpcId(entry),
      method: 'session/set_config_option',
      params: { sessionId: entry.sessionId, configId, value: msg.value },
    });
    return;
  }

  if (msg.type === 'permission_response') {
    // Client picked an option for a pending session/request_permission. Look
    // up the RPC, cancel its timeout, write the reply back to the agent.
    const id = msg.id;
    const pending = entry.pendingAgentRpcs.get(id);
    if (!pending) return; // already answered or expired
    clearTimeout(pending);
    entry.pendingAgentRpcs.delete(id);
    const optionId = typeof msg.optionId === 'string' ? msg.optionId : null;
    const outcome = optionId
      ? { outcome: 'selected', optionId }
      : { outcome: 'cancelled' };
    writeRpc(entry, { jsonrpc: '2.0', id, result: { outcome } });
    return;
  }
}

function attachClientHandlers(entry: DevinSessionEntry, socket: WebSocket) {
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = undefined;
  }
  entry.clients.add(socket);

  // Per-socket WS-level heartbeat. The browser auto-replies to ping frames
  // with pong, so we don't need any client-side help to detect dead TCP.
  let isAlive = true;
  const pingTimer = setInterval(() => {
    if (!isAlive) {
      try { socket.terminate(); } catch {}
      return;
    }
    isAlive = false;
    try { socket.ping(); } catch {}
  }, PING_INTERVAL_MS);
  socket.on('pong', () => { isAlive = true; });

  socket.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch {
      send(socket, { type: 'error', message: 'invalid json' });
      return;
    }
    // App-level ping from the client (browser JS can't send WS ping frames,
    // so the client uses a JSON message). Answer inline regardless of init
    // state so the heartbeat works during bootstrap too.
    if (msg?.type === 'ping') {
      send(socket, { type: 'pong' });
      return;
    }
    if (!entry.initialized || !entry.sessionId) {
      entry.pendingClientReqs.push({ socket, msg });
      return;
    }
    handleClientMessage(entry, msg, socket);
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    entry.clients.delete(socket);
    scheduleKillIfIdle(entry);
  });
}

function drainPending(entry: DevinSessionEntry) {
  const queued = entry.pendingClientReqs.splice(0);
  for (const { socket, msg } of queued) {
    handleClientMessage(entry, msg, socket);
  }
}

// Reply to agent→client RPCs we don't support. ACP spec says clients SHOULD
// answer every request — sending an error is friendlier than letting the
// agent hang. Capabilities advertised at initialize already tell the agent
// not to call fs/* / terminal/*, but request_permission may still arrive if
// some tool slips past the dangerous mode (defensive belt-and-suspenders).
function rejectAgentRequest(entry: DevinSessionEntry, id: number | string, method: string) {
  writeRpc(entry, {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `client does not support ${method}`,
    },
  });
}

function wireProcess(entry: DevinSessionEntry, onInit: (sessionIdNow: string | null) => void) {
  const rl = readline.createInterface({ input: entry.proc.stdout });
  let initSeen = false;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch {
      broadcast(entry, { type: 'log', line });
      return;
    }

    // Sniff sessionId out of any message that carries one — useful when the
    // agent emits notifications before the session/new response.
    const maybeSid: unknown = msg?.params?.sessionId ?? msg?.result?.sessionId;
    if (typeof maybeSid === 'string' && !entry.sessionId) {
      entry.sessionId = maybeSid;
      bySessionId.set(maybeSid, entry);
      pending.delete(entry);
    }

    // Track mode + config so re-attaching clients can paint immediately.
    const update = msg?.params?.update;
    if (update?.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
      entry.currentModeId = update.currentModeId;
    }
    if (update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      entry.configOptions = update.configOptions;
    }
    if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      entry.availableCommands = update.availableCommands;
    }

    // initialize response (id === 0) flips us into the "session bootstrap" phase.
    if (msg?.id === 0 && msg?.result && !initSeen) {
      initSeen = true;
      // We'll send session/new or session/load right after this.
      onInit(entry.sessionId);
      // Forward the initialize response so clients can introspect capabilities.
      broadcast(entry, { type: 'acp', data: msg });
      return;
    }

    // session/new or session/load response (id === 1) finishes bootstrap.
    if (msg?.id === 1 && msg?.result && !entry.initialized) {
      entry.initialized = true;
      if (msg.result?.modes?.currentModeId) entry.currentModeId = msg.result.modes.currentModeId;
      if (Array.isArray(msg.result?.configOptions)) entry.configOptions = msg.result.configOptions;
      broadcast(entry, { type: 'acp', data: msg });
      // Restore model/mode from a previous subprocess if available. Must run
      // after initialized=true so nextRpcId works and after broadcast so the
      // client has the session/load baseline before receiving config updates.
      restoreSessionConfig(entry);
      drainPending(entry);
      return;
    }

    // Devin CLI >= 2026.5.26 no longer sends a formal JSON-RPC response for
    // session/new (id=1). Instead the session is bootstrapped entirely via
    // notifications carrying sessionId + configOptions + mode. Detect this
    // and complete the bootstrap from accumulated notification state.
    if (initSeen && !entry.initialized && entry.sessionId && entry.configOptions) {
      entry.initialized = true;
      // Synthesize a response so clients (DevinPanel) can set status='ready'.
      broadcast(entry, { type: 'acp', data: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          sessionId: entry.sessionId,
          modes: entry.currentModeId
            ? { currentModeId: entry.currentModeId }
            : undefined,
          configOptions: entry.configOptions,
        },
      }});
      restoreSessionConfig(entry);
      drainPending(entry);
      // Fall through so this notification is also broadcast normally.
    }

    // session/load returned an error (e.g. "Session not found" for a stale
    // resumeId that no longer exists in Devin's local store). Without this
    // branch the entry would linger uninitialised: future attaches would find
    // it in bySessionId, see an empty history buffer, and replay nothing —
    // exactly the "refresh many times and history won't load" symptom.
    // Kill the subprocess so the exit handler tears down state and the next
    // connect spawns fresh.
    if (msg?.id === 1 && msg?.error && !entry.initialized) {
      broadcast(entry, { type: 'acp', data: msg });
      broadcast(entry, { type: 'load_failed', error: msg.error });
      try { entry.proc.kill('SIGTERM'); } catch {}
      return;
    }

    // session/prompt response — keyed on stopReason, since ids ≥ 100 are
    // used for any client-initiated RPC (prompt / cancel / set_mode / etc).
    if (typeof msg?.id === 'number' && msg.id >= 100 && msg?.result?.stopReason) {
      entry.promptPending = false;
      broadcast(entry, { type: 'acp', data: msg });
      if (entry.clients.size === 0) scheduleKillIfIdle(entry);
      return;
    }

    // Agent→client RPC request. We handle two categories:
    //  1) session/request_permission — forward to UI, await client response,
    //     fall back to "cancelled" on timeout.
    //  2) Everything else (fs/*, terminal/*) — auto-reject; capabilities
    //     advertised at initialize already tell the agent not to call these,
    //     so this is defensive.
    if (typeof msg?.id !== 'undefined' && typeof msg?.method === 'string') {
      if (msg.method === 'session/request_permission') {
        const rpcId = msg.id;
        const timer = setTimeout(() => {
          if (!entry.pendingAgentRpcs.has(rpcId)) return;
          entry.pendingAgentRpcs.delete(rpcId);
          writeRpc(entry, {
            jsonrpc: '2.0',
            id: rpcId,
            result: { outcome: { outcome: 'cancelled' } },
          });
          broadcast(entry, { type: 'permission_timeout', id: rpcId });
        }, PERMISSION_TIMEOUT_MS);
        entry.pendingAgentRpcs.set(rpcId, timer);
        broadcast(entry, { type: 'acp', data: msg });
        return;
      }
      rejectAgentRequest(entry, msg.id, msg.method);
      broadcast(entry, { type: 'acp', data: msg });
      return;
    }

    // Notification or other response — pass straight through.
    broadcast(entry, { type: 'acp', data: msg });
  });

  entry.proc.stderr.on('data', (chunk) => {
    broadcast(entry, { type: 'stderr', data: chunk.toString() });
  });

  entry.proc.on('exit', (code) => {
    persistSessionConfig(entry);
    broadcast(entry, { type: 'exit', code });
    if (entry.sessionId) bySessionId.delete(entry.sessionId);
    pending.delete(entry);
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
    for (const t of entry.pendingAgentRpcs.values()) clearTimeout(t);
    entry.pendingAgentRpcs.clear();
    for (const c of entry.clients) {
      try { c.close(); } catch {}
    }
    entry.clients.clear();
  });

  entry.proc.on('error', (err) => {
    broadcast(entry, { type: 'error', message: String(err) });
  });
}

// After session/load, check if we have saved config from a previous
// subprocess for this sessionId. If so, send set_config_option RPCs to
// restore the model/mode the user had before the process was recycled.
function restoreSessionConfig(entry: DevinSessionEntry) {
  if (!entry.sessionId) return;
  const saved = savedSessionConfig.get(entry.sessionId);
  if (!saved) return;
  savedSessionConfig.delete(entry.sessionId);

  const currentModel = extractCurrentModel(entry.configOptions);
  if (saved.model && saved.model !== currentModel) {
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: nextRpcId(entry),
      method: 'session/set_config_option',
      params: { sessionId: entry.sessionId, configId: 'model', value: saved.model },
    });
  }

  if (saved.modeId && saved.modeId !== entry.currentModeId) {
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: nextRpcId(entry),
      method: 'session/set_mode',
      params: { sessionId: entry.sessionId, modeId: saved.modeId },
    });
  }
}

function sendInitialize(entry: DevinSessionEntry) {
  writeRpc(entry, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'remote-ide',
        title: 'AI Studio',
        version: '0.1.0',
      },
    },
  });
}

function sendSessionNewOrLoad(entry: DevinSessionEntry, resumeSessionId: string | null) {
  if (resumeSessionId) {
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params: { sessionId: resumeSessionId, cwd: entry.cwd, mcpServers: [] },
    });
  } else {
    writeRpc(entry, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: entry.cwd, mcpServers: [] },
    });
  }
}

// Read sessions directly out of Devin's local SQLite store. Faster than
// spawning a fresh ACP subprocess just to call `session/list`, and works even
// when the CLI is offline. Falls back to oneShotRpc if the DB is missing.
function readSessionsFromDb(cwd: string): Array<{
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}> | null {
  const dbPath = nodePath.join(nodeOs.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db');
  if (!nodeFs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    // readOnly avoids holding a write lock while devin itself may be running.
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      'SELECT id, working_directory AS cwd, title, last_activity_at ' +
      'FROM sessions WHERE working_directory = ? AND hidden = 0 ' +
      'ORDER BY last_activity_at DESC',
    ).all(cwd) as Array<{ id: string; cwd: string; title: string | null; last_activity_at: number }>;
    return rows.map((r) => ({
      sessionId: r.id,
      cwd: r.cwd,
      // 'Untitled' is Devin's placeholder before an auto-generated title kicks
      // in; surfacing it just clutters the picker.
      title: r.title && r.title !== 'Untitled' ? r.title : undefined,
      updatedAt: new Date(r.last_activity_at * 1000).toISOString(),
    }));
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

// Look up a single session's metadata by slug. Used to bootstrap resumed
// tabs' title from Devin's own store (rather than the client guessing from
// a paginated transcript slice, which mis-picks the "first user msg" when
// the true first is off-page).
function readSessionFromDb(slug: string, cwd: string): {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
} | null {
  const dbPath = nodePath.join(nodeOs.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db');
  if (!nodeFs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      'SELECT id, working_directory AS cwd, title, last_activity_at ' +
      'FROM sessions WHERE id = ? AND working_directory = ? LIMIT 1',
    ).get(slug, cwd) as { id: string; cwd: string; title: string | null; last_activity_at: number } | undefined;
    if (!row) return null;
    return {
      sessionId: row.id,
      cwd: row.cwd,
      title: row.title && row.title !== 'Untitled' ? row.title : undefined,
      updatedAt: new Date(row.last_activity_at * 1000).toISOString(),
    };
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Transcript: read conversation history from Devin's local sessions.db.
// Mirrors the Claude-side JSONL transcript API so DevinPanel can pre-fetch
// history via HTTP before opening a WS (just like ChatPanel does).
// ---------------------------------------------------------------------------

type TranscriptEvent =
  | { role: 'user'; content: string; images?: string[]; nodeId: number }
  | { role: 'assistant'; content: string; model?: string; nodeId: number }
  | {
      role: 'tool_call';
      toolCallId: string;
      title: string;
      kind: string;
      rawInput?: any;
      nodeId: number;
    }
  | { role: 'tool_result'; toolCallId: string; content: string; toolKind?: string; nodeId: number };

function readDevinTranscript(
  sessionSlug: string,
  opts?: { limit?: number; before?: number },
): { events: TranscriptEvent[]; startIndex: number } | null {
  const dbPath = nodePath.join(nodeOs.homedir(), '.local', 'share', 'devin', 'cli', 'sessions.db');
  if (!nodeFs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const limit = opts?.limit ?? 200;
    const before = opts?.before;
    // Walk the active branch: from the latest node back to root via
    // parent_node_id. This naturally excludes dead-end branches (failed
    // ACP starts) and assistant duplicates, so no message_id dedup needed.
    const beforeClause = before != null ? 'AND mn.node_id < ?' : '';
    const sql =
      'WITH RECURSIVE chain(nid) AS (' +
      '  SELECT MAX(node_id) FROM message_nodes WHERE session_id = ?' +
      '  UNION ALL' +
      '  SELECT m.parent_node_id FROM message_nodes m' +
      '    JOIN chain c ON m.node_id = c.nid AND m.session_id = ?' +
      '  WHERE m.parent_node_id IS NOT NULL' +
      ')' +
      'SELECT mn.node_id, mn.chat_message FROM message_nodes mn ' +
      'JOIN chain c ON mn.node_id = c.nid ' +
      `WHERE mn.session_id = ? AND json_extract(mn.chat_message, '$.role') != 'system' ` +
      `${beforeClause} ORDER BY mn.node_id DESC LIMIT ?`;
    const params: any[] = before != null
      ? [sessionSlug, sessionSlug, sessionSlug, before, limit]
      : [sessionSlug, sessionSlug, sessionSlug, limit];
    const rows = db.prepare(sql).all(...params) as Array<{
      node_id: number;
      chat_message: string;
    }>;
    rows.reverse(); // chronological order

    const events: TranscriptEvent[] = [];
    for (const row of rows) {
      let cm: any;
      try { cm = JSON.parse(row.chat_message); } catch { continue; }
      const nodeId = row.node_id;

      if (cm.role === 'user') {
        const text = typeof cm.content === 'string' ? cm.content : '';
        // Extract images from ACP content blocks.
        const acpBlocks: any[] = cm.metadata?.extensions?.['chisel/acp-content-blocks'] ?? [];
        const images: string[] = [];
        for (const b of acpBlocks) {
          if (b?.type === 'image' && b.data && b.mimeType) {
            images.push(`data:${b.mimeType};base64,${b.data}`);
          }
        }
        events.push({ role: 'user', content: text, images: images.length ? images : undefined, nodeId });
        continue;
      }

      if (cm.role === 'assistant') {
        const text = typeof cm.content === 'string' ? cm.content : '';
        const model: string | undefined = cm.metadata?.generation_model;
        if (text) {
          events.push({ role: 'assistant', content: text, model, nodeId });
        }
        // Emit a tool_call event for each tool invocation in this message.
        const toolCalls: any[] = Array.isArray(cm.tool_calls) ? cm.tool_calls : [];
        const toolMeta: Record<string, any> =
          cm.metadata?.extensions?.['chisel/tool_call_content'] ?? {};
        for (const tc of toolCalls) {
          const id: string = tc.id;
          const meta = toolMeta[id] ?? {};
          let rawInput: any;
          try {
            rawInput = typeof tc.arguments === 'string'
              ? JSON.parse(tc.arguments) : tc.arguments;
          } catch { rawInput = tc.arguments; }
          events.push({
            role: 'tool_call',
            toolCallId: id,
            title: meta.title ?? tc.name ?? '',
            kind: meta.kind ?? tc.name ?? 'other',
            rawInput,
            nodeId,
          });
        }
        continue;
      }

      if (cm.role === 'tool') {
        const output = typeof cm.content === 'string' ? cm.content : '';
        const tcId: string = cm.tool_call_id ?? '';
        const toolKind: string | undefined =
          cm.metadata?.extensions?.['chisel/tool_result_meta']?.kind;
        if (tcId) {
          events.push({ role: 'tool_result', toolCallId: tcId, content: output, toolKind, nodeId });
        }
        continue;
      }
    }

    const startIndex = rows.length > 0 ? rows[0].node_id : 0;
    return { events, startIndex };
  } catch {
    return null;
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

// One-shot helper: spawn ACP, initialize, send a request, read its response,
// close. Used as a fallback for /api/projects/:id/devin-sessions when the
// local sqlite store is missing.
async function oneShotRpc(cwd: string, method: string, params: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(DEVIN_BIN, ['--permission-mode', 'dangerous', 'acp'], {
      cwd, env: devinEnv(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch {}
      reject(new Error('devin acp timeout'));
    }, INIT_TIMEOUT_MS);

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0 && msg.result) {
        // initialize done — fire the real call
        try {
          proc.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 1, method, params,
          }) + '\n');
        } catch (e) {
          settled = true;
          clearTimeout(timer);
          try { proc.kill('SIGTERM'); } catch {}
          reject(e);
        }
        return;
      }
      if (msg.id === 1) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.kill('SIGTERM'); } catch {}
        if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
        else resolve(msg.result);
      }
    });

    proc.stderr.on('data', () => { /* swallow chisel logs */ });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('devin acp exited before response'));
    });

    // Fire initialize.
    try {
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'remote-ide', title: 'AI Studio', version: '0.1.0' },
        },
      }) + '\n');
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

export function registerDevinRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/devin-sessions',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      // Prefer the local sqlite store: spawn-free, ~ms latency.
      const fromDb = readSessionsFromDb(project.path);
      if (fromDb) return { sessions: fromDb };
      // Fallback when the DB file isn't there (fresh install, alt cli home).
      try {
        const result = await oneShotRpc(project.path, 'session/list', { cwd: project.path });
        return { sessions: result?.sessions ?? [] };
      } catch (e: any) {
        return { sessions: [], error: String(e?.message ?? e) };
      }
    },
  );

  // Single-session metadata lookup — used by DevinPanel on mount for resumed
  // sessions to fetch the authoritative title from Devin's sessions.db,
  // instead of guessing from the transcript's paginated first user msg.
  app.get<{ Params: { id: string; slug: string } }>(
    '/api/projects/:id/devin-sessions/:slug',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const row = readSessionFromDb(req.params.slug, project.path);
      if (!row) return reply.code(404).send({ error: 'session not found' });
      return row;
    },
  );

  app.get<{ Params: { id: string; slug: string }; Querystring: { limit?: string; before?: string } }>(
    '/api/projects/:id/devin-sessions/:slug/transcript',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '60', 10) || 60, 1), 500);
      const before = req.query.before ? parseInt(req.query.before, 10) : undefined;
      const result = readDevinTranscript(req.params.slug, { limit, before });
      if (!result) return { events: [], startIndex: 0 };
      return result;
    },
  );

  app.get<{ Querystring: { project?: string; resume?: string } }>(
    '/ws/devin',
    { websocket: true },
    async (socket, req) => {
      const uid = getUserId(req as any);
      if (!uid) {
        send(socket, { type: 'error', message: 'unauthorized' });
        try { socket.close(); } catch {}
        return;
      }
      const projectId = req.query.project;
      const resumeId = req.query.resume;
      const project = projectId ? await getProject(uid, projectId) : null;
      if (!project) {
        send(socket, { type: 'error', message: 'project required or not found' });
        try { socket.close(); } catch {}
        return;
      }

      // 1) Attach to existing live session if we already host it.
      if (resumeId && bySessionId.has(resumeId)) {
        const entry = bySessionId.get(resumeId)!;
        attachClientHandlers(entry, socket);
        app.log.info({ resumeId, clients: entry.clients.size }, 'devin: attach');
        send(socket, {
          type: 'started',
          cwd: entry.cwd,
          resumed: true,
          attached: true,
          clients: entry.clients.size,
          promptPending: entry.promptPending,
          sessionId: entry.sessionId,
          currentModeId: entry.currentModeId,
          configOptions: entry.configOptions,
          availableCommands: entry.availableCommands,
        });
        // History comes from the DB (client pre-fetches via HTTP).
        // No ring buffer replay needed.
        send(socket, { type: 'replay_done' });
        return;
      }
      app.log.info({ resumeId }, 'devin: spawn');

      // 2) Spawn a fresh ACP subprocess. session/new or session/load happens
      //    after initialize response arrives.
      const proc = spawnDevin(project.path);
      const entry: DevinSessionEntry = {
        proc,
        cwd: project.path,
        sessionId: resumeId ?? null,
        clients: new Set(),
        initialized: false,
        pendingClientReqs: [],
        currentModeId: null,
        configOptions: null,
        availableCommands: null,
        rpcSeq: 0,
        promptPending: false,
        pendingAgentRpcs: new Map(),
      };
      // Pre-register so a near-simultaneous second ws with the same resumeId
      // attaches instead of spawning a duplicate.
      if (resumeId) bySessionId.set(resumeId, entry);
      else pending.add(entry);

      wireProcess(entry, () => sendSessionNewOrLoad(entry, resumeId ?? null));
      sendInitialize(entry);
      attachClientHandlers(entry, socket);

      send(socket, {
        type: 'started',
        cwd: project.path,
        resumed: !!resumeId,
        attached: false,
        clients: 1,
        promptPending: false,
        sessionId: entry.sessionId,
        currentModeId: null,
        configOptions: null,
        availableCommands: null,
      });
    },
  );
}
