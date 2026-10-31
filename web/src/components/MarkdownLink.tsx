import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { resolveChatLink } from '../lib/chatLinks';

// Model: web.OpenChatLink — the <a> renderer shared by ChatPanel and
// DevinPanel's markdown. External URLs open a new browser window; in-project
// file paths open a file Tab; anything else is inert text.
export function MarkdownLink({ href, children, projectPath, onOpenFile, node: _node, ...props }: {
  href?: string;
  children?: ReactNode;
  projectPath?: string | null;
  onOpenFile?: (relPath: string) => void;
  node?: unknown;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const link = resolveChatLink(href, projectPath);
  if (link.kind === 'external') {
    return <a href={link.href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
  }
  if (link.kind === 'file') {
    const title = link.lines ? `${link.rel}:${link.lines}` : link.rel;
    return (
      <a
        href={href}
        className="chat-ref"
        title={title}
        onClick={(e) => { e.preventDefault(); onOpenFile?.(link.rel); }}
        {...props}
      >
        {children}
      </a>
    );
  }
  return <span className="chat-link-inert" title={href}>{children}</span>;
}
