import { forwardRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Theme } from '../types';
import type { ExportMessage, ExportMeta } from '../lib/export/types';

// Shared rendering surface for PNG / PDF export. Mirrors ChatPanel / DevinPanel
// visuals so the exported image is recognisably "the chat" — reuses the same
// .msg / .msg-tool / .tool-field CSS classes from styles.css.

function MarkdownText({ text, theme }: { text: string; theme: Theme }) {
  const style = theme === 'light' ? oneLight : vscDarkPlus;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!match) return <code className={className} {...props}>{children}</code>;
          return (
            <SyntaxHighlighter
              PreTag="div"
              language={match[1]}
              style={style as any}
              customStyle={{ margin: '4px 0', borderRadius: 4, fontSize: 11, padding: '6px 8px' }}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function ToolFields({ input }: { input: unknown }) {
  if (!input || typeof input !== 'object') {
    return <pre className="tool-field-value">{String(input ?? '')}</pre>;
  }
  return (
    <>
      {Object.entries(input as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="tool-field">
          <div className="tool-field-key">{k}</div>
          <pre className="tool-field-value">
            {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
          </pre>
        </div>
      ))}
    </>
  );
}

export type ExportViewProps = {
  messages: ExportMessage[];
  meta: ExportMeta;
  theme: Theme;
  // Render off-screen (default) or inline for previewing.
  offscreen?: boolean;
};

export const ExportView = forwardRef<HTMLDivElement, ExportViewProps>(function ExportView(
  { messages, meta, theme, offscreen = true },
  ref,
) {
  const offscreenStyle: React.CSSProperties = offscreen
    ? { position: 'fixed', top: 0, left: -100000, zIndex: -1, pointerEvents: 'none' }
    : {};
  return (
    <div
      ref={ref}
      data-export-root="1"
      style={{
        ...offscreenStyle,
        width: 820,
        background: 'var(--bg)',
        color: 'var(--fg)',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10, marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          {meta.title ?? (meta.source === 'devin' ? 'Devin session' : 'Claude session')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Exported {meta.exportedAt ?? new Date().toISOString()} · source: {meta.source}
        </div>
      </div>
      <div className="chat-messages export-messages" style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'visible', height: 'auto' }}>
        {messages.map((m, i) => {
          if (m.kind === 'user') {
            return (
              <div key={i} className="msg msg-user" style={{ alignSelf: 'flex-end', maxWidth: '90%' }}>
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map((src, j) => (
                      <img key={j} src={src} className="msg-image" alt="" crossOrigin="anonymous" />
                    ))}
                  </div>
                )}
                {m.text && <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>}
              </div>
            );
          }
          if (m.kind === 'assistant') {
            return (
              <div key={i} className="msg msg-assistant">
                <MarkdownText text={m.text} theme={theme} />
              </div>
            );
          }
          if (m.kind === 'thought') {
            return (
              <div key={i} className="msg msg-tool open">
                <div className="tool-header">
                  <span className="tool-chevron">▾</span>
                  <span className="tool-name">thinking</span>
                </div>
                <div className="tool-detail">
                  <pre className="tool-field-value" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</pre>
                </div>
              </div>
            );
          }
          if (m.kind === 'system') {
            return <div key={i} className="msg msg-system" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>;
          }
          // tool
          return (
            <div key={i} className="msg msg-tool open">
              <div className="tool-header">
                <span className="tool-chevron">▾</span>
                <span className="tool-name">{m.name}</span>
                {m.title && <span className="tool-summary">{m.title}</span>}
              </div>
              <div className="tool-detail">
                <ToolFields input={m.input} />
                {m.output !== undefined && (
                  <div className="tool-field">
                    <div className="tool-field-key">output</div>
                    <pre className="tool-field-value" style={{ whiteSpace: 'pre-wrap' }}>{m.output}</pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
