import type { FastifyInstance } from 'fastify';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import nodeFs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WebSocket } from '@fastify/websocket';
import { getProject, getSettings } from './store.js';
import { getUserId } from './auth.js';
import { isEffortLevel } from './models.js';

export type CliCatalog = {
  slashCommands: string[];
  skills: string[];
  agents: string[];
  terminalSlashCommands: string[];
};

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// In `-p --input-format stream-json` mode claude emits `system.init` only
// after the first prompt, not at spawn. So a fresh or re-spawned session has
// no catalog until the user sends something — too late for a "/" picker
// opened before the first message. The catalog is a property of the cwd
// (project skills + CLI bundle), so remember the last one seen per cwd and
// persist it (same pattern as devin-config-cache.json) to survive restarts.
const CONFIG_DIR =
  process.env.REMOTE_IDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'remote-ide');
const CATALOG_CACHE_PATH = path.join(CONFIG_DIR, 'claude-catalog-cache.json');
const catalogByCwd = new Map<string, CliCatalog>();

function loadCatalogCacheFromDisk() {
  try {
    const obj = JSON.parse(nodeFs.readFileSync(CATALOG_CACHE_PATH, 'utf8')) as Record<string, unknown>;
    for (const [cwd, v] of Object.entries(obj)) {
      const c = v as Partial<CliCatalog> | null;
      if (!c || typeof c !== 'object') continue;
      catalogByCwd.set(cwd, {
        slashCommands: strList(c.slashCommands),
        skills: strList(c.skills),
        agents: strList(c.agents),
        terminalSlashCommands: strList(c.terminalSlashCommands),
      });
    }
  } catch {
    // Missing or corrupt — start empty.
  }
}
loadCatalogCacheFromDisk();

function rememberCatalog(cwd: string, catalog: CliCatalog) {
  catalogByCwd.set(cwd, catalog);
  try {
    nodeFs.mkdirSync(CONFIG_DIR, { recursive: true });
    nodeFs.writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(Object.fromEntries(catalogByCwd), null, 2));
  } catch {
    // Best-effort.
  }
}

// What to hand a client in `started`: this process's own init if it has
// fired, else the last catalog seen for the same cwd.
function catalogFor(entry: SessionEntry): CliCatalog | null {
  return entry.cliCatalog ?? catalogByCwd.get(entry.cwd) ?? null;
}

type SessionEntry = {
  proc: ChildProcessWithoutNullStreams;
  cwd: string;
  resumeId: string | null; // claude's session_id (null until system.init)
  clients: Set<WebSocket>;
  lastSelfWrite: number;
  lastInput: number;
  externalNotified: boolean;
  // True between user input and the matching `result` event — i.e. claude is
  // actively generating. Sent to attaching clients so a page refresh restores
  // the spinner instead of falsely showing "ready".
  thinking: boolean;
  // Most recent model id from `system.init`. Cached so clients that attach to
  // an already-live session (or re-attach after a refresh) can render the
  // model without waiting for a new init event.
  model: string | null;
  // --effort we launched the current proc with. '' = claude's default. Not
  // reported by system.init, so the server is the source of truth.
  effort: string;
  // Slash commands / skills / agents the CLI reported in `system.init`.
  // init fires once per spawn, so a client that attaches later (page
  // refresh) would never see it — replayed in `started`. Feeds the "/"
  // command picker.
  cliCatalog: CliCatalog | null;
  watcher?: nodeFs.FSWatcher;
  externalTimer?: NodeJS.Timeout;
  // When the last client disconnects, we delay killing the subprocess so a
  // page refresh (≈1s offline) doesn't lose in-flight work. Attach cancels.
  killTimer?: NodeJS.Timeout;
};

const CLIENT_DRAIN_GRACE_MS = 5 * 60_000;

// WS heartbeat: send a ping every PING_INTERVAL_MS; if the previous round's
// pong never arrived, terminate the socket so the entry can drain. Without
// this a TCP connection silently dropped by NAT/OS sleep leaves a zombie
// client in entry.clients forever.
const PING_INTERVAL_MS = 30_000;

// Suppress external-change detection while our own session is recently active.
// claude appends housekeeping records (permission-mode, file-history-snapshot,
// etc.) at unpredictable intervals during a live session, so we need a generous
// window to avoid false positives.
const EXTERNAL_QUIET_MS = 30_000;

function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`);
}

// Scan the project's most-recent JSONL for the last `assistant` event's model.
// Used as a hint when settings.model is empty and we're spawning a fresh
// session — saves the user from staring at a blank model field while claude
// boots up. The hint is overwritten by the real `system.init` model when it
// arrives.
async function peekRecentModel(cwd: string): Promise<string | null> {
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
    const fsp = await import('node:fs/promises');
    const files = await fsp.readdir(dir).catch(() => [] as string[]);
    const stats = await Promise.all(
      files
        .filter((f) => f.endsWith('.jsonl'))
        .map(async (f) => {
          const full = path.join(dir, f);
          const st = await fsp.stat(full).catch(() => null);
          return st ? { full, mtime: st.mtimeMs } : null;
        }),
    );
    const sorted = stats.filter((x): x is { full: string; mtime: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime);
    for (const { full } of sorted.slice(0, 3)) {
      const raw = await fsp.readFile(full, 'utf8').catch(() => '');
      if (!raw) continue;
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"assistant"')) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.model) return obj.message.model;
        } catch {}
      }
    }
  } catch {}
  return null;
}

// Registry keyed by claude's session_id so multiple WS clients targeting the
// same conversation share one subprocess.
const byResumeId = new Map<string, SessionEntry>();
// Entries that haven't reported a session_id yet (brand-new sessions during
// the gap between spawn and system.init). Kept just to clean up if needed.
const pending = new Set<SessionEntry>();

// Force-enable file checkpointing for every claude subprocess we spawn so that
// (a) every tool_use that touches a file writes a file-history-snapshot record
// and (b) `claude --rewind-files <uuid>` is allowed to run. In non-interactive
// (-p) mode claude gates checkpointing on the CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
// env var — the userSettings flag and --settings JSON only apply to the
// interactive TUI path, not to us.
const CLAUDE_ENV = { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };

function spawnClaude(cwd: string, resumeId?: string, model?: string, effort?: string): ChildProcessWithoutNullStreams {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    // Headless `-p` mode auto-stubs AskUserQuestion with a {is_error:true,
    // content:"Answer questions?"} tool_result ~1ms after emission, which
    // looks like a real failure to the model. Until we wire up an SDK-side
    // canUseTool handler, suppress the tool entirely so the model falls back
    // to plain markdown questions. See projects/askuserquestion/.
    '--disallowedTools', 'AskUserQuestion',
  ];
  if (model && model.trim()) args.push('--model', model.trim());
  if (isEffortLevel(effort)) args.push('--effort', effort);
  if (resumeId) args.push('--resume', resumeId);
  return spawn('claude', args, {
    cwd,
    env: CLAUDE_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function send(socket: WebSocket, msg: unknown) {
  try { socket.send(JSON.stringify(msg)); } catch {}
}

// Arm the idle-kill timer. Called when the last client leaves and again when
// claude finishes (`result` event) — so a long-running task with no observers
// stays alive until it completes, then has its own grace period afterwards.
// The timer fire itself bails out if claude is still thinking; a later `result`
// will rearm.
function scheduleKillIfIdle(entry: SessionEntry) {
  if (entry.clients.size > 0) return;
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = undefined;
    if (entry.clients.size > 0) return;
    if (entry.thinking) return; // result handler will rearm when done
    try { entry.proc.kill('SIGTERM'); } catch {}
    if (entry.resumeId) byResumeId.delete(entry.resumeId);
    pending.delete(entry);
  }, CLIENT_DRAIN_GRACE_MS);
}

function broadcast(entry: SessionEntry, msg: unknown, except?: WebSocket) {
  const payload = JSON.stringify(msg);
  for (const c of entry.clients) {
    if (c === except) continue;
    try { c.send(payload); } catch {}
  }
}

function attachClientHandlers(entry: SessionEntry, socket: WebSocket) {
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = undefined;
  }
  entry.clients.add(socket);

  // Per-socket WS-level heartbeat. Mirrors devin.ts — see comment there.
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
    if (msg.type === 'ping') {
      send(socket, { type: 'pong' });
      return;
    }
    if (msg.type === 'user') {
      const text = String(msg.text ?? '');
      const images: { mediaType: string; data: string }[] = Array.isArray(msg.images) ? msg.images : [];
      const msgId = typeof msg.msgId === 'string' ? msg.msgId : null;
      const content: any[] = [];
      if (text) content.push({ type: 'text', text });
      for (const img of images) {
        if (!img?.mediaType || !img?.data) continue;
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        });
      }
      if (content.length === 0) return;
      entry.lastInput = Date.now();
      entry.externalNotified = false;
      entry.thinking = true;
      const userEvent = { type: 'user', message: { role: 'user', content } };
      broadcast(entry, { type: 'event', data: userEvent, msgId }, socket);
      try { entry.proc.stdin.write(JSON.stringify(userEvent) + '\n'); } catch {}

      // Fire-and-forget: once claude flushes this prompt to JSONL, look up its
      // uuid and broadcast a {type:'user_uuid'} mapping so the rewind ✎ button
      // can appear on freshly-sent messages without a page reload.
      if (msgId && entry.resumeId) {
        const file = jsonlPathFor(entry.cwd, entry.resumeId);
        const matchText = text;
        (async () => {
          await waitForUserRecordFlushed(file, matchText);
          try {
            const raw = await fsp.readFile(file, 'utf8');
            const lines = raw.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
              const line = lines[i];
              if (!line) continue;
              try {
                const o = JSON.parse(line);
                if (o?.type !== 'user' || o?.message?.role !== 'user') continue;
                const c = o.message.content;
                const flat = typeof c === 'string'
                  ? c
                  : Array.isArray(c)
                    ? c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
                    : '';
                if (typeof o.uuid !== 'string') break;
                if (!matchText || flat.includes(matchText.slice(0, 80))) {
                  broadcast(entry, { type: 'user_uuid', msgId, uuid: o.uuid });
                }
                break;
              } catch {}
            }
          } catch {}
        })();
      }
      return;
    }
    if (msg.type === 'set_model') {
      // Mid-session model switch. claude responds with a control_response and
      // emits a fresh `system.init` carrying the new model id.
      const model = String(msg.model ?? '').trim();
      if (!model) return;
      const req = {
        type: 'control_request',
        request_id: `setmodel-${Date.now()}`,
        request: { subtype: 'set_model', model },
      };
      try { entry.proc.stdin.write(JSON.stringify(req) + '\n'); } catch {}
      return;
    }
    if (msg.type === 'set_effort') {
      // claude's control protocol has no set_effort (only set_model /
      // set_permission_mode / set_max_thinking_tokens), so a mid-session
      // change means respawning on the same transcript with --effort.
      const effort = String(msg.effort ?? '').trim();
      if (effort && !isEffortLevel(effort)) {
        send(socket, { type: 'effort_error', message: `invalid effort level: ${effort}` });
        return;
      }
      if (entry.thinking) {
        send(socket, { type: 'effort_error', message: 'wait for the current turn to finish before changing effort' });
        return;
      }
      const sid = entry.resumeId;
      if (!sid) {
        send(socket, { type: 'effort_error', message: 'session not initialized yet — send a message first' });
        return;
      }
      void (async () => {
        const oldProc = entry.proc;
        oldProc.removeAllListeners('exit');
        oldProc.removeAllListeners('error');
        if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = undefined; }
        if (entry.externalTimer) { clearTimeout(entry.externalTimer); entry.externalTimer = undefined; }
        if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
        try { oldProc.kill('SIGTERM'); } catch {}
        await awaitProcExit(oldProc);
        entry.effort = effort;
        entry.proc = spawnClaude(entry.cwd, sid, undefined, effort);
        entry.thinking = false;
        entry.lastSelfWrite = Date.now();
        entry.lastInput = Date.now();
        entry.externalNotified = false;
        wireProcess(entry);
        startWatcher(entry);
        broadcast(entry, { type: 'effort', effort });
      })();
      return;
    }
    if (msg.type === 'stop') {
      // Protocol-level interrupt: stops the current generation but leaves the
      // subprocess alive so the user can keep talking. claude responds with a
      // `result` event whose terminal_reason is "aborted_streaming".
      const req = {
        type: 'control_request',
        request_id: `interrupt-${Date.now()}`,
        request: { subtype: 'interrupt' },
      };
      try { entry.proc.stdin.write(JSON.stringify(req) + '\n'); } catch {}
      return;
    }
  });

  socket.on('close', () => {
    clearInterval(pingTimer);
    entry.clients.delete(socket);
    scheduleKillIfIdle(entry);
  });
}

function startWatcher(entry: SessionEntry) {
  if (entry.watcher || !entry.resumeId) return;
  const file = jsonlPathFor(entry.cwd, entry.resumeId);
  try {
    entry.watcher = nodeFs.watch(file, () => {
      const now = Date.now();
      // Treat the session as "ours" if we wrote stdout or received user input
      // recently. claude's housekeeping writes occur at unpredictable intervals
      // so the window has to be generous.
      if (now - entry.lastSelfWrite < EXTERNAL_QUIET_MS) return;
      if (now - entry.lastInput < EXTERNAL_QUIET_MS) return;
      // Already told clients; wait until our own activity resets the flag.
      if (entry.externalNotified) return;
      if (entry.externalTimer) clearTimeout(entry.externalTimer);
      entry.externalTimer = setTimeout(() => {
        if (entry.externalNotified) return;
        entry.externalNotified = true;
        broadcast(entry, { type: 'external_change', sessionId: entry.resumeId });
      }, 400);
    });
  } catch {
    setTimeout(() => startWatcher(entry), 1000);
  }
}

function wireProcess(entry: SessionEntry) {
  const rl = readline.createInterface({ input: entry.proc.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    entry.lastSelfWrite = Date.now();
    entry.externalNotified = false;
    let event: any;
    try { event = JSON.parse(line); } catch {
      broadcast(entry, { type: 'log', line });
      return;
    }
    if (event?.type === 'result') {
      entry.thinking = false;
      // Task finished. If nobody's listening, start the kill timer now.
      if (entry.clients.size === 0) scheduleKillIfIdle(entry);
    }
    if (event?.type === 'system' && event?.subtype === 'init' && event?.model) {
      entry.model = event.model;
    }
    if (event?.type === 'system' && event?.subtype === 'init') {
      entry.cliCatalog = {
        slashCommands: strList(event.slash_commands),
        skills: strList(event.skills),
        agents: strList(event.agents),
        terminalSlashCommands: strList(event.terminal_slash_commands),
      };
      rememberCatalog(entry.cwd, entry.cliCatalog);
    }
    // Capture session_id and register/re-key in the resume map.
    if (event?.type === 'system' && event?.subtype === 'init' && event?.session_id) {
      const sid: string = event.session_id;
      if (entry.resumeId && entry.resumeId !== sid) {
        byResumeId.delete(entry.resumeId);
        if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = undefined; }
      }
      entry.resumeId = sid;
      byResumeId.set(sid, entry);
      pending.delete(entry);
      startWatcher(entry);
    }
    broadcast(entry, { type: 'event', data: event });
  });

  entry.proc.stderr.on('data', (chunk) => {
    broadcast(entry, { type: 'stderr', data: chunk.toString() });
  });

  entry.proc.on('exit', (code) => {
    broadcast(entry, { type: 'exit', code });
    if (entry.resumeId) byResumeId.delete(entry.resumeId);
    pending.delete(entry);
    if (entry.watcher) { try { entry.watcher.close(); } catch {} }
    if (entry.externalTimer) clearTimeout(entry.externalTimer);
    if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
    for (const c of entry.clients) {
      try { c.close(); } catch {}
    }
    entry.clients.clear();
  });

  entry.proc.on('error', (err) => {
    broadcast(entry, { type: 'error', message: String(err) });
  });
}

// Wait for a child process to exit, with a safety timeout. We try SIGTERM
// first and force-resolve once it's gone (or after the timeout) — the caller
// has already arranged that we no longer care about the child's output.
function awaitProcExit(proc: ChildProcessWithoutNullStreams, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const onExit = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      proc.off('exit', onExit);
      try { proc.kill('SIGKILL'); } catch {}
      resolve();
    }, timeoutMs);
    proc.once('exit', onExit);
  });
}

// Run claude --rewind-files <uuid> as a one-shot subprocess. claude restores
// every file it edited after the target user message back to that point.
// Returns the captured stderr on non-zero exit so callers can surface it.
function runRewindFiles(cwd: string, sessionId: string, messageUuid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      'claude',
      ['--resume', sessionId, '--rewind-files', messageUuid],
      {
        cwd,
        env: CLAUDE_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c.toString(); });
    p.stdout.on('data', () => { /* drain */ });
    p.on('error', (e) => resolve({ ok: false, error: String(e) }));
    p.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
    });
  });
}

// Truncate the JSONL transcript at the line carrying `messageUuid` — that line
// and everything after it are removed. Returns false if no user-typed record
// with that uuid was found.
async function truncateTranscriptAt(file: string, messageUuid: string): Promise<boolean> {
  const raw = await fsp.readFile(file, 'utf8');
  let offset = 0;
  let cutOffset = -1;
  for (const line of raw.split('\n')) {
    if (line) {
      try {
        const obj = JSON.parse(line);
        if (obj?.uuid === messageUuid && obj?.type === 'user') {
          cutOffset = offset;
          break;
        }
      } catch {
        // ignore unparseable lines (queue-operation records etc. have type set)
      }
    }
    offset += line.length + 1; // include the '\n' that split() consumed
  }
  if (cutOffset < 0) return false;
  await fsp.truncate(file, cutOffset);
  return true;
}

// Poll the transcript JSONL until its last user-typed record matches the text
// we just wrote to claude's stdin — i.e. claude has flushed the prompt to
// disk. Without this the WS broadcast of `rewind` would race claude's write,
// and the client's refetch would miss the new user message until a manual
// page reload. Bails out after `timeoutMs` so a slow claude doesn't hang
// the response forever.
async function waitForUserRecordFlushed(file: string, expectedText: string, timeoutMs = 5000): Promise<void> {
  const needle = expectedText.trim().slice(0, 80);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type !== 'user' || obj?.message?.role !== 'user') continue;
          const c = obj.message.content;
          const flat = typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('')
              : '';
          if (!needle || flat.includes(needle)) return;
          // Last user record doesn't match yet — wait for the next write.
          break;
        } catch {}
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
}

function buildUserEvent(text: string, images: Array<{ mediaType?: string; data?: string }> | undefined) {
  const content: any[] = [];
  if (text) content.push({ type: 'text', text });
  for (const img of images ?? []) {
    if (!img?.mediaType || !img?.data) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  return { type: 'user', message: { role: 'user', content } };
}

export function registerSessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { project?: string; resume?: string } }>(
    '/ws/session',
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

      // 1) Attach to existing live session if requested resumeId is held.
      if (resumeId && byResumeId.has(resumeId)) {
        const entry = byResumeId.get(resumeId)!;
        attachClientHandlers(entry, socket);
        send(socket, {
          type: 'started',
          cwd: entry.cwd,
          resumed: true,
          attached: true,
          clients: entry.clients.size,
          thinking: entry.thinking,
          model: entry.model,
          effort: entry.effort,
          cliCatalog: catalogFor(entry),
        });
        return;
      }

      // 2) Spawn a new subprocess (resume from JSONL if requested).
      const settings = await getSettings(uid);
      // Hint priority: explicit setting > scan of recent JSONL.
      const requestedModel = settings.model || await peekRecentModel(project.path);
      const effort = isEffortLevel(settings.effort) ? settings.effort : '';
      const proc = spawnClaude(project.path, resumeId, settings.model, effort);
      const entry: SessionEntry = {
        proc,
        cwd: project.path,
        resumeId: resumeId ?? null,
        clients: new Set(),
        lastSelfWrite: Date.now(),
        lastInput: Date.now(),
        externalNotified: false,
        thinking: false,
        model: null,
        effort,
        cliCatalog: null,
      };
      // Pre-register so a near-simultaneous second connection with the same
      // resumeId attaches instead of spawning a duplicate.
      if (resumeId) byResumeId.set(resumeId, entry);
      else pending.add(entry);

      wireProcess(entry);
      if (resumeId) startWatcher(entry);
      attachClientHandlers(entry, socket);

      send(socket, {
        type: 'started',
        cwd: project.path,
        resumed: !!resumeId,
        attached: false,
        clients: 1,
        thinking: false,
        model: null,
        effort,
        requestedModel,
        cliCatalog: catalogFor(entry),
      });
    },
  );

  // Rewind: restore files + truncate JSONL at the chosen user message, then
  // re-send the edited text as the next prompt. Requires a live entry — the
  // initiating client must currently have the tab open (i.e. a WS attached),
  // which it does in practice when the rewind button is clicked.
  app.post<{
    Params: { id: string; sid: string };
    Body: {
      messageUuid?: string;
      newText?: string;
      images?: Array<{ mediaType: string; data: string }>;
    };
  }>(
    '/api/projects/:id/sessions/:sid/rewind',
    async (req, reply) => {
      const uid = getUserId(req);
      if (!uid) return reply.code(401).send({ error: 'unauthorized' });
      const project = await getProject(uid, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project not found' });

      const sid = req.params.sid;
      const messageUuid = String(req.body?.messageUuid ?? '').trim();
      const newText = String(req.body?.newText ?? '').trim();
      const images = Array.isArray(req.body?.images) ? req.body!.images! : [];
      if (!messageUuid) return reply.code(400).send({ error: 'messageUuid required' });
      if (!newText && images.length === 0) {
        return reply.code(400).send({ error: 'newText or images required' });
      }

      const jsonlFile = jsonlPathFor(project.path, sid);
      try { await fsp.stat(jsonlFile); }
      catch { return reply.code(404).send({ error: 'session transcript not found' }); }

      const entry = byResumeId.get(sid);
      if (!entry) {
        return reply.code(409).send({ error: 'session is not live — open the tab first' });
      }

      // Stop the current claude proc so it doesn't race the rewind / truncate /
      // respawn. We deliberately swallow `exit` from the broadcast (which would
      // tear down the WS clients) by clearing the handlers ahead of kill.
      const oldProc = entry.proc;
      oldProc.removeAllListeners('exit');
      oldProc.removeAllListeners('error');
      if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = undefined; }
      if (entry.externalTimer) { clearTimeout(entry.externalTimer); entry.externalTimer = undefined; }
      if (entry.killTimer) { clearTimeout(entry.killTimer); entry.killTimer = undefined; }
      try { oldProc.kill('SIGTERM'); } catch {}
      await awaitProcExit(oldProc);

      // After this point the entry holds a dead proc reference. Whether we
      // succeed or fail, we MUST restore a live proc to entry.proc before
      // returning — otherwise WS clients sit on a zombie that can't accept
      // new user input. Use this helper for any failure exit.
      const recoverWithoutRewind = (statusCode: number, error: string) => {
        const recoveryProc = spawnClaude(project.path, sid, undefined, entry.effort);
        entry.proc = recoveryProc;
        entry.thinking = false;
        entry.lastSelfWrite = Date.now();
        entry.lastInput = Date.now();
        entry.externalNotified = false;
        wireProcess(entry);
        startWatcher(entry);
        return reply.code(statusCode).send({ error });
      };

      // Step 1 — claude restores any files it edited after this point.
      const fileResult = await runRewindFiles(project.path, sid, messageUuid);
      if (!fileResult.ok) {
        app.log.error({ err: fileResult.error, sid, messageUuid }, 'rewind-files failed');
        return recoverWithoutRewind(500, `file rewind failed: ${fileResult.error}`);
      }

      // Step 2 — physically truncate JSONL at the target message line.
      const truncated = await truncateTranscriptAt(jsonlFile, messageUuid);
      if (!truncated) {
        return recoverWithoutRewind(400, 'messageUuid not found among user messages');
      }

      // Step 3 — re-spawn the long-running claude proc on the now-shorter
      // transcript and rewire it into the existing entry so the WS clients
      // stay attached.
      const newProc = spawnClaude(project.path, sid, undefined, entry.effort);
      entry.proc = newProc;
      entry.thinking = false;
      entry.lastSelfWrite = Date.now();
      entry.lastInput = Date.now();
      entry.externalNotified = false;
      wireProcess(entry);
      startWatcher(entry);

      // Step 4 — feed the edited message as the next prompt.
      entry.thinking = true;
      const userEvent = buildUserEvent(newText, images);
      try { newProc.stdin.write(JSON.stringify(userEvent) + '\n'); }
      catch (e: any) {
        app.log.error({ err: e }, 'rewind: failed to write new user message');
        return reply.code(500).send({ error: 'failed to start new turn' });
      }

      // Step 5 — wait for claude to flush the new user record to JSONL before
      // telling clients to refetch. Otherwise the refetch hits the truncated
      // transcript without the new prompt and the user wonders why their
      // edit disappeared until they reload the page.
      if (newText) await waitForUserRecordFlushed(jsonlFile, newText);
      broadcast(entry, { type: 'rewind' });

      return { ok: true };
    },
  );
}
