// Claude Code transcript（~/.claude/projects/<encodeCwd(cwd)>/<session>.jsonl）读取与归一化。
// 格式事实见 projects/aie-observe/design.md §2.5。只做解析，不做装配。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** transcript 一行。只列装配用到的字段，其余透传在索引签名里。 */
export interface TranscriptEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  promptId?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  requestId?: string;
  effort?: string;
  message?: TranscriptMessage;
  /** 合并流式多行后，最后一行的时间（transcript 本身没有这个字段） */
  _ended_at?: string;
  /** 合并后：第一个 text 块所在行的 uuid 与块内序号（ChatPanel 锚点 a:<uuid>:<blockIdx>） */
  _text_anchor?: { uuid: string; blockIdx: number };
  [k: string]: unknown;
}

export interface TranscriptMessage {
  id?: string;
  role?: string;
  model?: string;
  stop_reason?: string | null;
  usage?: TranscriptUsage;
  content?: string | ContentBlock[];
  [k: string]: unknown;
}

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
  [k: string]: unknown;
}

export type ContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; signature?: string }
  | { type: 'tool_use'; id: string; name?: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  [k: string]: unknown;
}

export interface SubagentTranscript {
  /** 文件名去掉 .jsonl，即 `agent-<id>`，也是子 Conversation 的 id */
  agentId: string;
  meta: SubagentMeta;
  entries: TranscriptEntry[];
}

export interface SessionTranscripts {
  main: TranscriptEntry[];
  subagents: SubagentTranscript[];
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** Claude Code 用 '-' 替换路径里的 '/' 作项目目录名（与 session.ts 的 encodeCwd 一致） */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function transcriptDir(cwd: string, home = os.homedir()): string {
  return path.join(home, '.claude', 'projects', encodeCwd(cwd));
}

export function transcriptPath(cwd: string, sessionId: string, home = os.homedir()): string {
  return path.join(transcriptDir(cwd, home), `${sessionId}.jsonl`);
}

export function subagentsDir(cwd: string, sessionId: string, home = os.homedir()): string {
  return path.join(transcriptDir(cwd, home), sessionId, 'subagents');
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 逐行 JSON；空行与坏行跳过（Claude 进程写入中可能截断最后一行）。 */
export function parseJsonl(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') out.push(obj as TranscriptEntry);
    } catch {
      // 跳过
    }
  }
  return out;
}

/** 只保留 user / assistant 行，其余（attachment、queue-operation、file-history-snapshot…）丢弃。 */
export function relevantEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => e.type === 'user' || e.type === 'assistant');
}

/**
 * Claude Code 会把同一次 assistant 生成的不同 content block（thinking / text / tool_use）
 * 拆成多条行写入，都带同一个 message.id。按 message.id 合并：content 追加，usage 取最后一条，
 * `_ended_at` 记最后一行时间。
 */
export function mergeStreamedAssistant(entries: TranscriptEntry[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const indexByMessageId = new Map<string, number>();
  const textAnchor = (e: TranscriptEntry): { uuid: string; blockIdx: number } | undefined => {
    const c = e.message?.content;
    if (!e.uuid || !Array.isArray(c)) return undefined;
    const i = c.findIndex((b) => b && typeof b === 'object' && b.type === 'text');
    return i >= 0 ? { uuid: e.uuid, blockIdx: i } : undefined;
  };
  for (const e of entries) {
    if (e.type === 'assistant') {
      const mid = e.message?.id;
      if (mid && indexByMessageId.has(mid)) {
        const target = out[indexByMessageId.get(mid)!];
        const tgtContent = target.message?.content;
        const newContent = e.message?.content;
        if (Array.isArray(tgtContent) && Array.isArray(newContent)) {
          target.message = { ...target.message, content: [...tgtContent, ...newContent] };
        }
        if (e.message?.usage) target.message = { ...target.message, usage: e.message.usage };
        if (e.timestamp) target._ended_at = e.timestamp;
        if (!target._text_anchor) target._text_anchor = textAnchor(e);
        continue;
      }
      if (mid) indexByMessageId.set(mid, out.length);
      // 拷贝一份，避免合并时改到调用方的数组
      out.push({ ...e, message: e.message ? { ...e.message } : e.message, _text_anchor: textAnchor(e) });
      continue;
    }
    out.push(e);
  }
  return out;
}

export type UserContentKind = 'user_input' | 'tool_results' | 'mixed' | 'empty';

export interface ClassifiedUserContent {
  kind: UserContentKind;
  texts: string[];
  toolResults: Array<{ type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }>;
}

/** user 行的 content：字符串 = 纯输入；块数组可同时含 text 与 tool_result。 */
export function classifyUserContent(content: unknown): ClassifiedUserContent {
  if (typeof content === 'string') return { kind: 'user_input', texts: [content], toolResults: [] };
  if (!Array.isArray(content)) return { kind: 'empty', texts: [], toolResults: [] };
  const texts: string[] = [];
  const toolResults: ClassifiedUserContent['toolResults'] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') texts.push(typeof b.text === 'string' ? b.text : '');
    else if (b.type === 'tool_result') toolResults.push(b);
  }
  if (texts.length && toolResults.length) return { kind: 'mixed', texts, toolResults };
  if (texts.length) return { kind: 'user_input', texts, toolResults: [] };
  if (toolResults.length) return { kind: 'tool_results', texts: [], toolResults };
  return { kind: 'empty', texts: [], toolResults: [] };
}

export interface AssistantOutput {
  text: string;
  thinking: string;
  toolUses: Array<{ id: string; name?: string; input?: unknown }>;
}

export function extractAssistantOutput(content: unknown): AssistantOutput {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolUses: AssistantOutput['toolUses'] = [];
  if (!Array.isArray(content)) return { text: '', thinking: '', toolUses };
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') text.push(typeof b.text === 'string' ? b.text : '');
    else if (b.type === 'thinking') thinking.push(typeof b.thinking === 'string' ? b.thinking : '');
    else if (b.type === 'tool_use' && typeof b.id === 'string') toolUses.push(b);
  }
  return { text: text.join('\n'), thinking: thinking.join('\n'), toolUses };
}

/** tool_result.content 是字符串或 [{type:'text',text}] */
export function toolResultText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((x) => (x && typeof x === 'object' ? (typeof x.text === 'string' ? x.text : '') : String(x)))
      .join('\n');
  }
  return content == null ? '' : String(content);
}

// ---------------------------------------------------------------------------
// 读盘
// ---------------------------------------------------------------------------

export async function readTranscript(file: string): Promise<TranscriptEntry[]> {
  return parseJsonl(await fs.readFile(file, 'utf8'));
}

/** `<dir>/agent-<id>.meta.json` 与同名 `.jsonl` 配对；缺 jsonl 的跳过。 */
export async function readSubagentTranscripts(dir: string): Promise<SubagentTranscript[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: SubagentTranscript[] = [];
  for (const name of names.filter((n) => n.endsWith('.meta.json')).sort()) {
    const agentId = name.slice(0, -'.meta.json'.length);
    const jsonl = path.join(dir, `${agentId}.jsonl`);
    const raw = await fs.readFile(jsonl, 'utf8').catch(() => null);
    if (raw == null) continue;
    let meta: SubagentMeta = {};
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      // meta 坏了也不丢 transcript
    }
    out.push({ agentId, meta, entries: parseJsonl(raw) });
  }
  return out;
}

/** 读一个 session 的主 transcript 与全部子代理 transcript。主文件不存在抛 ENOENT。 */
export async function readSessionTranscripts(
  cwd: string,
  sessionId: string,
  home = os.homedir(),
): Promise<SessionTranscripts> {
  const main = await readTranscript(transcriptPath(cwd, sessionId, home));
  const subagents = await readSubagentTranscripts(subagentsDir(cwd, sessionId, home));
  return { main, subagents };
}

/** 主 transcript、子代理文件、wire 目录里最新的 mtime，用作缓存键。 */
export async function newestMtime(files: string[]): Promise<number> {
  let latest = 0;
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null);
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return latest;
}
