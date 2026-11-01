// Devin cites files in its prose with self-closing XML tags (its CLI system
// prompt, "File references"): `<ref_file file="/abs/path" />` and
// `<ref_snippet file="/abs/path" lines="a-b" />`. Our markdown pipeline has
// no rehype-raw, so the tags leak into the UI as literal text. Rewrite them
// to markdown before rendering: paths inside the project become links whose
// href carries the project-relative path (MarkdownText's <a> override turns
// that into openTab); anything else degrades to inline code.

export const REF_HREF_PREFIX = '#devin-ref:';

const REF_RE = /<ref_(file|snippet)\b([^>]*?)\/>/g;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

// Absolute path → project-relative, or null when the path is outside the
// project (or is the root itself — nothing to open). Mirrors makeRelPath's
// root normalisation but is strict: prefix match only, no substring games.
export function toProjectRel(abs: string, projectPath?: string | null): string | null {
  if (!projectPath) return null;
  const root = projectPath.replace(/\/+$/, '');
  if (!root || !abs.startsWith(root + '/')) return null;
  const rel = abs.slice(root.length + 1);
  return rel.length ? rel : null;
}

// `links: false` yields plain inline code for every ref — used for export,
// where a click target makes no sense.
export function rewriteDevinRefs(
  text: string,
  projectPath?: string | null,
  opts: { links?: boolean } = {},
): string {
  if (!text.includes('<ref_')) return text;
  return text.replace(REF_RE, (whole, kind: string, attrs: string) => {
    const file = attr(attrs, 'file');
    if (!file) return whole;
    const lines = kind === 'snippet' ? attr(attrs, 'lines') : undefined;
    const rel = toProjectRel(file, projectPath);
    const label = `\`${rel ?? file}${lines ? `:${lines}` : ''}\``;
    if (rel && opts.links !== false) return `[${label}](${REF_HREF_PREFIX}${encodeURIComponent(rel)})`;
    return label;
  });
}

export function refFromHref(href: string | undefined | null): string | null {
  if (!href || !href.startsWith(REF_HREF_PREFIX)) return null;
  try {
    const rel = decodeURIComponent(href.slice(REF_HREF_PREFIX.length));
    return rel.length ? rel : null;
  } catch {
    return null;
  }
}
