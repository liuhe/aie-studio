import type { ExportMessage, ExportMeta } from './types';

const ROLE_HEADER: Record<ExportMessage['kind'], string> = {
  user: '### 🧑 User',
  assistant: '### 🤖 Assistant',
  thought: '### 💭 Thought',
  system: '### ⚙️ System',
  tool: '#### 🛠 Tool',
};

function fenceOutput(text: string): string {
  // Pick a fence that doesn't collide with content. ``` is enough 99% of the
  // time; bump to ```` if the body contains the shorter fence.
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}\n${text}\n${fence}`;
}

function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function userBlock(m: Extract<ExportMessage, { kind: 'user' }>, opts: { embedImages: boolean }): string {
  const parts: string[] = [ROLE_HEADER.user];
  if (m.text) parts.push(m.text);
  if (m.images && m.images.length) {
    for (const src of m.images) {
      if (opts.embedImages && src.startsWith('data:')) {
        parts.push(`![](${src})`);
      } else if (src.startsWith('data:')) {
        parts.push('_[image omitted]_');
      } else {
        parts.push(`![](${src})`);
      }
    }
  }
  return parts.join('\n\n');
}

function toolBlock(m: Extract<ExportMessage, { kind: 'tool' }>): string {
  const head = `#### 🛠 ${m.name}${m.title ? ` — ${m.title}` : ''}`;
  const inputStr = stringifyInput(m.input);
  const inputBlock = inputStr ? `\n**input**\n${fenceOutput(inputStr)}` : '';
  const outputBlock = m.output ? `\n**output**\n${fenceOutput(m.output)}` : '';
  return `${head}${inputBlock}${outputBlock}`;
}

export function toMarkdown(
  messages: ExportMessage[],
  meta: ExportMeta,
  opts: { embedImages?: boolean } = {},
): string {
  const embedImages = opts.embedImages ?? true;
  const headerLines: string[] = [];
  if (meta.title) headerLines.push(`# ${meta.title}`);
  else headerLines.push(`# ${meta.source === 'devin' ? 'Devin' : 'Claude'} session`);
  const when = meta.exportedAt ?? new Date().toISOString();
  headerLines.push(`> Exported ${when} · source: ${meta.source}`);

  const body = messages
    .map((m) => {
      switch (m.kind) {
        case 'user':
          return userBlock(m, { embedImages });
        case 'assistant':
          return `${ROLE_HEADER.assistant}\n\n${m.text}`;
        case 'thought':
          return `${ROLE_HEADER.thought}\n\n> ${m.text.replace(/\n/g, '\n> ')}`;
        case 'system':
          return `${ROLE_HEADER.system}\n\n> ${m.text.replace(/\n/g, '\n> ')}`;
        case 'tool':
          return toolBlock(m);
      }
    })
    .join('\n\n---\n\n');

  return `${headerLines.join('\n')}\n\n${body}\n`;
}
