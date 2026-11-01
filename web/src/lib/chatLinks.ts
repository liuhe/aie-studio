// Model: web.OpenChatLink — decides what a markdown link inside an assistant
// message does when clicked. Shared by ChatPanel (Claude) and DevinPanel.
//
//   external → open in a new browser window (target=_blank)
//   file     → open a file Tab inside the app (via OpenTab)
//   inert    → render as plain text; navigating would tear down the SPA
//
// Pure function so it can be unit-tested without React.

import { refFromHref } from './devinRefs';

export type ChatLink =
  | { kind: 'external'; href: string }
  | { kind: 'file'; rel: string; lines?: string }
  | { kind: 'inert' };

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'sms']);
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
// `path:12`, `path:12-20`, `path#L12`, `path#L12-L20`
const LINES_RE = /(?::(\d+(?:-\d+)?)|#L(\d+)(?:-L?(\d+))?)$/;

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Strip a trailing line reference; returns [path, lines?].
function splitLines(path: string): [string, string | undefined] {
  const m = LINES_RE.exec(path);
  if (!m) return [path, undefined];
  const lines = m[1] ?? (m[3] ? `${m[2]}-${m[3]}` : m[2]);
  return [path.slice(0, m.index), lines];
}

// Normalise a project-relative path: drop leading "./", collapse "//",
// reject anything that escapes the root.
function normalizeRel(rel: string): string | null {
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function fileLink(pathish: string, projectPath?: string | null): ChatLink {
  // Fragment that is not a line anchor is just a section marker — drop it.
  const [withoutFrag, frag] = pathish.split(/#(?=.)/, 2) as [string, string?];
  let path = withoutFrag;
  let lines: string | undefined;
  if (frag && /^L\d+/.test(frag)) {
    [path, lines] = splitLines(`${path}#${frag}`);
  } else {
    [path, lines] = splitLines(path);
  }
  path = safeDecode(path);
  if (!path) return { kind: 'inert' };
  let rel: string | null;
  if (path.startsWith('/')) {
    if (!projectPath) return { kind: 'inert' };
    const root = projectPath.replace(/\/+$/, '');
    if (!root || !path.startsWith(root + '/')) return { kind: 'inert' };
    rel = normalizeRel(path.slice(root.length + 1));
  } else if (path.startsWith('~')) {
    return { kind: 'inert' };
  } else {
    rel = normalizeRel(path);
  }
  if (!rel) return { kind: 'inert' };
  return lines ? { kind: 'file', rel, lines } : { kind: 'file', rel };
}

export function resolveChatLink(href: string | undefined | null, projectPath?: string | null): ChatLink {
  if (!href) return { kind: 'inert' };
  const trimmed = href.trim();
  if (!trimmed) return { kind: 'inert' };

  const devinRel = refFromHref(trimmed);
  if (devinRel) return { kind: 'file', rel: devinRel };

  const m = SCHEME_RE.exec(trimmed);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (EXTERNAL_SCHEMES.has(scheme)) return { kind: 'external', href: trimmed };
    if (scheme === 'file') {
      // file:///abs/path or file://localhost/abs/path
      const rest = trimmed.slice(m[0].length).replace(/^\/\/[^/]*/, '');
      return fileLink(rest, projectPath);
    }
    // `foo.ts:12` — the "scheme" is really a filename followed by a line no.
    const rest = trimmed.slice(m[0].length);
    if (/^\d+(-\d+)?$/.test(rest)) return fileLink(trimmed, projectPath);
    // Protocol-relative `//host/x` is external too.
    return { kind: 'inert' };
  }
  if (trimmed.startsWith('//')) return { kind: 'external', href: trimmed };
  if (trimmed.startsWith('#')) return { kind: 'inert' };
  return fileLink(trimmed, projectPath);
}
