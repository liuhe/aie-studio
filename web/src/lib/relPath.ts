// Strip the active project's absolute path prefix from strings for display,
// so a tool field showing `<projectRoot>/web/src/foo.ts` renders as
// `web/src/foo.ts`. The root is supplied at call time (per project), not
// baked in — callers pass `activeProject.path`. Returns an identity function
// when no path is known. Replaces every occurrence inside the string, which
// covers Bash commands, tool outputs and serialized JSON blobs that mention
// the root.
export function makeRelPath(projectPath: string | undefined | null): (s: string) => string {
  if (!projectPath) return (s) => s;
  const root = projectPath.replace(/\/+$/, '');
  if (!root) return (s) => s;
  const prefix = root + '/';
  return (s) => {
    if (typeof s !== 'string' || s.length === 0) return s;
    let out = s.split(prefix).join('');
    out = out.split(root).join('.');
    return out;
  };
}
