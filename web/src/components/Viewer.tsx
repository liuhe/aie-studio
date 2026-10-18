import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Theme } from '../types';

function prismStyle(theme: Theme) {
  return theme === 'light' ? oneLight : vscDarkPlus;
}

type Stat = { path: string; size: number; isDir: boolean; mime: string };

const CODE_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'markup', css: 'css', scss: 'scss',
  sql: 'sql', swift: 'swift', lua: 'lua', vim: 'vim', dockerfile: 'docker',
};

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot + 1).toLowerCase();
}

export function Viewer({ projectId, file, theme }: { projectId: string; file: { path: string }; theme: Theme }) {
  const codeStyle = prismStyle(theme);
  const [stat, setStat] = useState<Stat | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [htmlMode, setHtmlMode] = useState<'rendered' | 'source'>('rendered');

  useEffect(() => {
    setStat(null); setText(null); setErr(null);
    let aborted = false;
    (async () => {
      try {
        const sr = await fetch(`/api/fs/stat?project=${projectId}&path=${encodeURIComponent(file.path)}`);
        if (!sr.ok) throw new Error(`stat failed: ${sr.status}`);
        const s: Stat = await sr.json();
        if (aborted) return;
        setStat(s);

        const ext = extOf(file.path);
        const isText =
          s.mime.startsWith('text/') ||
          s.mime === 'application/json' ||
          s.mime === 'application/xml' ||
          s.mime === 'application/javascript' ||
          ext in CODE_EXT ||
          ext === 'md' ||
          ext === 'markdown';
        if (isText) {
          const r = await fetch(`/api/fs/file?project=${projectId}&path=${encodeURIComponent(file.path)}`);
          if (!r.ok) throw new Error(`load failed: ${r.status}`);
          const t = await r.text();
          if (!aborted) setText(t);
        }
      } catch (e: any) {
        if (!aborted) setErr(e.message);
      }
    })();
    return () => { aborted = true; };
  }, [projectId, file.path]);

  if (err) return <div className="viewer-empty">Error: {err}</div>;
  if (!stat) return <div className="viewer-empty">Loading…</div>;

  const ext = extOf(file.path);
  const url = `/api/fs/file?project=${projectId}&path=${encodeURIComponent(file.path)}`;

  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className="viewer-markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const inline = !match;
              if (inline) return <code className={className} {...props}>{children}</code>;
              return (
                <SyntaxHighlighter
                  PreTag="div"
                  language={match![1]}
                  style={codeStyle as any}
                  customStyle={{ borderRadius: 6, fontSize: 12 }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            },
          }}
        >{text ?? ''}</ReactMarkdown>
      </div>
    );
  }

  if (text === null && stat.mime.startsWith('image/')) {
    return <div className="viewer-image"><img src={url} alt={file.path} /></div>;
  }
  if (text === null && stat.mime === 'application/pdf') {
    return <iframe className="viewer-pdf" src={url} title={file.path} />;
  }
  if (text === null && stat.mime.startsWith('video/')) {
    return <div className="viewer-image"><video src={url} controls style={{ maxWidth: '100%', maxHeight: '100%' }} /></div>;
  }
  if (text === null && stat.mime.startsWith('audio/')) {
    return <div className="viewer-empty"><audio src={url} controls /></div>;
  }

  if (text !== null) {
    const lang = CODE_EXT[ext];
    // HTML defaults to a live render via /raw/<pid>/<path> (path-in-URL so
    // relative refs like <link href="./style.css"> resolve correctly). A
    // toggle button switches to syntax-highlighted source.
    const isHtml = ext === 'html' || ext === 'htm' || stat.mime === 'text/html';
    const rawUrl = isHtml
      ? `/raw/${projectId}/${file.path.split('/').map(encodeURIComponent).join('/')}`
      : null;
    const body = lang ? (
      <SyntaxHighlighter
        language={lang}
        style={codeStyle as any}
        customStyle={{ margin: 0, height: '100%', fontSize: 12 }}
        showLineNumbers
      >
        {text}
      </SyntaxHighlighter>
    ) : (
      <pre>{text}</pre>
    );
    if (rawUrl) {
      return (
        <div className="viewer-html">
          <div className="viewer-toolbar">
            <button
              type="button"
              onClick={() => setHtmlMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
            >{htmlMode === 'rendered' ? 'View source' : 'Rendered'}</button>
            <a href={rawUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
          </div>
          <div className="viewer-html-body">
            <iframe
              src={rawUrl}
              title={file.path}
              style={{ display: htmlMode === 'rendered' ? 'block' : 'none' }}
            />
            <div
              className="viewer-html-source"
              style={{ display: htmlMode === 'source' ? 'block' : 'none' }}
            >{body}</div>
          </div>
        </div>
      );
    }
    return body;
  }

  return <div className="viewer-empty">Binary file ({stat.mime}, {stat.size} bytes)</div>;
}
