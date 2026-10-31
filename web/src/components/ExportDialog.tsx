import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Theme } from '../types';
import type { ExportFormat, ExportMessage, ExportSource } from '../lib/export/types';
import { toMarkdown } from '../lib/export/toMarkdown';
import { downloadBlob, downloadText, safeFilename } from '../lib/export/download';
import { ExportView } from './ExportView';

type Props = {
  projectId: string;
  messages: ExportMessage[];
  source: ExportSource;
  title?: string;
  theme: Theme;
  onClose: () => void;
};

function shortPreview(m: ExportMessage): string {
  if (m.kind === 'tool') return m.title || m.name;
  return (m.text ?? '').replace(/\s+/g, ' ').slice(0, 40);
}

function currentFontScale(): string {
  return document.documentElement.getAttribute('data-font-scale') ?? 'normal';
}

export function ExportDialog({ projectId, messages, source, title, theme, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [fromIdx, setFromIdx] = useState(0);
  const [toIdx, setToIdx] = useState(Math.max(0, messages.length - 1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const slice = useMemo(() => {
    const a = Math.min(fromIdx, toIdx);
    const b = Math.max(fromIdx, toIdx);
    return messages.slice(a, b + 1);
  }, [messages, fromIdx, toIdx]);

  const baseName = useMemo(() => {
    const stem = safeFilename(title || `${source}-session`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${stem}-${stamp}`;
  }, [title, source]);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const meta = { source, title, exportedAt: new Date().toISOString() };
      if (format === 'markdown') {
        const md = toMarkdown(slice, meta);
        downloadText(md, `${baseName}.md`);
      } else {
        const node = viewRef.current;
        if (!node) throw new Error('export view not mounted');
        // The portaled ExportView has `position: fixed; left: -100000; ...`
        // so the browser doesn't show it. If we serialise that inline style as-is
        // the server's puppeteer page renders the whole export off-screen → blank.
        // Clone and strip those browser-only positioning hacks before reading
        // outerHTML so the server gets a normally-positioned document.
        const clone = node.cloneNode(true) as HTMLElement;
        clone.style.position = '';
        clone.style.top = '';
        clone.style.left = '';
        clone.style.zIndex = '';
        clone.style.pointerEvents = '';
        const html = clone.outerHTML;
        const res = await fetch(`/api/projects/${projectId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            html,
            theme,
            fontScale: currentFontScale(),
            format,
            filename: baseName,
          }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error ?? `server returned ${res.status}`);
        }
        const blob = await res.blob();
        downloadBlob(blob, `${baseName}.${format}`);
      }
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || slice.length === 0;

  return (
    <div className="export-backdrop" onClick={busy ? undefined : onClose}>
      <div className="export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="export-header">
          <span>Export session</span>
          <button className="export-close" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="export-body">
          <div className="export-row">
            <div className="export-label">Format</div>
            <div className="export-format-options">
              {(['markdown', 'pdf', 'png'] as ExportFormat[]).map((f) => (
                <label key={f} className={`export-format-option ${format === f ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="export-format"
                    value={f}
                    checked={format === f}
                    onChange={() => setFormat(f)}
                    disabled={busy}
                  />
                  <span>{f.toUpperCase()}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="export-row">
            <div className="export-label">From</div>
            <select
              value={fromIdx}
              onChange={(e) => setFromIdx(Number(e.target.value))}
              disabled={busy}
              className="export-select"
            >
              {messages.map((m, i) => (
                <option key={i} value={i}>{`#${i + 1} · ${m.kind} · ${shortPreview(m)}`}</option>
              ))}
            </select>
          </div>
          <div className="export-row">
            <div className="export-label">To</div>
            <select
              value={toIdx}
              onChange={(e) => setToIdx(Number(e.target.value))}
              disabled={busy}
              className="export-select"
            >
              {messages.map((m, i) => (
                <option key={i} value={i}>{`#${i + 1} · ${m.kind} · ${shortPreview(m)}`}</option>
              ))}
            </select>
          </div>
          <div className="export-summary">
            {slice.length} of {messages.length} messages will be exported.
          </div>
          {err && <div className="export-error">{err}</div>}
        </div>
        <div className="export-actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={run} disabled={disabled} className="export-download">
            {busy ? 'Working…' : 'Download'}
          </button>
        </div>
      </div>
      {/* PDF / PNG go through the server, which renders our HTML in a real
          headless Chrome (no browser-side canvas size limits). The export view
          is portaled under <body> so the modal's flex / overflow can't
          collapse it before we read its outerHTML. */}
      {createPortal(
        <ExportView
          ref={viewRef}
          messages={slice}
          meta={{ source, title, exportedAt: new Date().toISOString() }}
          theme={theme}
        />,
        document.body,
      )}
    </div>
  );
}
