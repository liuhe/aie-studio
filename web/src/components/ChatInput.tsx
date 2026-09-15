import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SendKey } from '../types';
import { filterCommands, matchCommandQuery, type CommandItem } from '../lib/commandPicker';

export type ChatInputStatus =
  | 'connecting'
  | 'replaying'
  | 'ready'
  | 'thinking'
  | 'reconnecting'
  | 'closed';

const INPUT_HEIGHT_KEY = 'chatInputHeight';
const MIN_INPUT_HEIGHT = 40;
const MAX_INPUT_HEIGHT_VH = 0.5;

function loadInputHeight(): number | null {
  const n = Number(localStorage.getItem(INPUT_HEIGHT_KEY));
  return Number.isFinite(n) && n >= MIN_INPUT_HEIGHT ? n : null;
}

export const ChatInput = memo(function ChatInput({
  status,
  sendKey,
  pendingImagesCount,
  readyPlaceholder,
  thinkingPlaceholder,
  commands,
  onCommandsOpen,
  onSend,
  onAddFiles,
  onStop,
}: {
  status: ChatInputStatus;
  sendKey: SendKey;
  pendingImagesCount: number;
  readyPlaceholder: string;
  thinkingPlaceholder: string;
  // "/" command picker (model: web.CommandPicker). Omit to disable. Claude
  // passes the .claude/ scan (skills + agents); Devin passes the commands the
  // agent advertised over ACP.
  commands?: CommandItem[];
  // Fired when the picker opens; caller can refetch the catalog in the background.
  onCommandsOpen?: () => void;
  onSend: (text: string) => void;
  onAddFiles: (files: FileList | File[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  // null = picker closed; string = query after the leading "/".
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Desktop-only height override (model: web.SendPrompt). Dragging the bar on
  // the input's top edge upward grows the textarea; persisted so tab switches
  // and reloads keep it. null = CSS default.
  const [height, setHeight] = useState<number | null>(loadInputHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>) {
    const ta = textareaRef.current;
    if (!ta) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: ta.offsetHeight };
  }
  function onResizeMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const max = Math.floor(window.innerHeight * MAX_INPUT_HEIGHT_VH);
    setHeight(Math.min(max, Math.max(MIN_INPUT_HEIGHT, d.startH + (d.startY - e.clientY))));
  }
  function onResizeUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const h = textareaRef.current?.offsetHeight;
    if (h) localStorage.setItem(INPUT_HEIGHT_KEY, String(h));
  }
  function onResizeReset() {
    setHeight(null);
    localStorage.removeItem(INPUT_HEIGHT_KEY);
  }

  const matches = commands && query != null ? filterCommands(commands, query) : [];
  const open = matches.length > 0;
  const selIdx = Math.min(sel, Math.max(0, matches.length - 1));

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) onCommandsOpen?.();
    wasOpenRef.current = open;
  }, [open, onCommandsOpen]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, selIdx]);

  function syncQuery(value: string, cursor: number) {
    if (!commands) return;
    setQuery(matchCommandQuery(value.slice(0, cursor)));
    setSel(0);
  }

  function pick(item: CommandItem) {
    const ta = textareaRef.current;
    // Trigger rule guarantees the "/query" token spans [0, cursor).
    const cursor = ta?.selectionStart ?? text.length;
    const next = item.insert + text.slice(cursor);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(item.insert.length, item.insert.length);
    });
  }

  function submit() {
    if (!text.trim() && pendingImagesCount === 0) return;
    onSend(text);
    setText('');
    setQuery(null);
  }

  const canSend =
    status !== 'closed' &&
    status !== 'connecting' &&
    status !== 'reconnecting' &&
    status !== 'replaying' &&
    (text.trim().length > 0 || pendingImagesCount > 0);

  return (
    <div className="chat-input">
      <div
        className="chat-input-resize"
        title="Drag up to enlarge; double-click to reset"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={onResizeReset}
      />
      {open && (
        <div className="cmd-popover" ref={listRef} role="listbox">
          {matches.map((item, idx) => {
            const groupStart = idx === 0 || matches[idx - 1].group !== item.group;
            return (
              <div key={`${item.group}:${item.name}`}>
                {groupStart && <div className="cmd-group">{item.group}</div>}
                <div
                  className={`cmd-item${idx === selIdx ? ' active' : ''}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === selIdx}
                  // preventDefault keeps focus (and the mobile keyboard) on the textarea.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                  onMouseEnter={() => setSel(idx)}
                >
                  <div className="cmd-item-name">{item.label}</div>
                  {item.description && <div className="cmd-item-desc">{item.description}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button
        className="chat-attach"
        onClick={() => fileInputRef.current?.click()}
        title="Attach image"
        disabled={status === 'closed'}
      >📎</button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) onAddFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <textarea
        ref={textareaRef}
        style={height != null ? { height } : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          syncQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onClick={(e) => syncQuery(text, e.currentTarget.selectionStart ?? text.length)}
        onBlur={() => setQuery(null)}
        placeholder={
          status === 'closed' ? 'closed'
          : status === 'thinking' ? thinkingPlaceholder
          : status === 'connecting' || status === 'reconnecting' || status === 'replaying' ? status
          : readyPlaceholder
        }
        disabled={status === 'closed'}
        onPaste={(e) => {
          const items = e.clipboardData?.items;
          if (!items) return;
          const files: File[] = [];
          for (const item of Array.from(items)) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) files.push(file);
            }
          }
          if (files.length) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            // While the picker is open, Enter/Tab pick regardless of sendKey.
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[selIdx]); return; }
            if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
          }
          if (e.key !== 'Enter') return;
          const mod = e.metaKey || e.ctrlKey;
          const trigger =
            (sendKey === 'enter' && !e.shiftKey && !mod) ||
            (sendKey === 'cmd-enter' && mod && !e.shiftKey) ||
            (sendKey === 'shift-enter' && e.shiftKey && !mod);
          if (trigger) { e.preventDefault(); submit(); }
        }}
      />
      <button onClick={submit} disabled={!canSend}>Send</button>
      {status === 'thinking' && (
        <button
          className="chat-stop"
          onClick={onStop}
          title="Interrupt current turn"
        >Stop</button>
      )}
    </div>
  );
});
