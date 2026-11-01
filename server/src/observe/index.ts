// 观察装配入口：读盘 + 装配 + wire 并入。/api/observe（Phase 1）直接用这里的 assembleClaudeSession。
// 纯函数部分在 assemble.ts / wire.ts，这里只做文件系统编排。

import os from 'node:os';
import type { Conversation } from './types.js';
import { assembleSession } from './assemble.js';
import { attachWire, readWireRecords, wireDir } from './wire.js';
import { readSessionTranscripts } from './transcript.js';

export * from './types.js';
export { assembleSession, buildConversation, validate, counts, iterActions, TERMINAL_STOP_REASONS } from './assemble.js';
export { attachWire, readWireRecords, wireDir, wireRequestSummary, wireResponseSummary } from './wire.js';
export type { WireRecord, SseEvent } from './wire.js';
export { assembleDevinSession, assembleDevinObservation, buildDevinConversation, chainTo, mainChainHead, readDevinSession } from './devin-adapter.js';
export {
  encodeCwd,
  transcriptDir,
  transcriptPath,
  subagentsDir,
  parseJsonl,
  readSessionTranscripts,
  newestMtime,
} from './transcript.js';

export interface AssembledSession {
  /** [0] 是根 Conversation，其后是子代理 */
  conversations: Conversation[];
  wire: { matched: number; orphans: number };
}

/**
 * 装配一个 Claude Code 会话：主 transcript + 子代理 + `<cwd>/.aie/observations/wire/<id>/`。
 * 主 transcript 不存在时抛 ENOENT（调用方转 404）。
 */
export async function assembleClaudeSession(cwd: string, sessionId: string, home = os.homedir()): Promise<AssembledSession> {
  const { main, subagents } = await readSessionTranscripts(cwd, sessionId, home);
  const conversations = assembleSession(sessionId, main, subagents);
  const records = await readWireRecords(wireDir(cwd, sessionId));
  const wire = attachWire(conversations, records);
  return { conversations, wire };
}
