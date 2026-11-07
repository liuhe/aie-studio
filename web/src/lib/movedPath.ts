// Model: web.FileTree rule-413 — after MoveEntry(from, to), anything keyed by
// a project-relative path that was `from` or lived under it follows along.
// Returns null when `path` is unaffected.
export function rewriteMovedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(from + '/')) return to + path.slice(from.length);
  return null;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
