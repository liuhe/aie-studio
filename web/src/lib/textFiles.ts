// Shared "is this a text file we can render / edit?" decision (model:
// web.Viewer rule-077, web.EditorPanel). Server mime comes from lookupMime;
// the extension fallbacks cover sources the mime table calls octet-stream.
export const CODE_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'markup', css: 'css', scss: 'scss',
  sql: 'sql', swift: 'swift', lua: 'lua', vim: 'vim', dockerfile: 'docker',
};

export function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot + 1).toLowerCase();
}

export function isTextFile(mime: string | undefined, path: string): boolean {
  const ext = extOf(path);
  if (mime) {
    if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/javascript'
    ) return true;
  }
  return ext in CODE_EXT || ext === 'md' || ext === 'markdown';
}
