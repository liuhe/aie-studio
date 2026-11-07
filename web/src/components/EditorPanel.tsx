import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, readFileText, statFile, writeFile } from '../api';
import { isTextFile } from '../lib/textFiles';

// Model: web.EditorPanel (auc-129) / page FileEditorView. Whole-file
// textarea editor; Save = server.WriteFile with the mtime we loaded as the
// optimistic-concurrency base.

const MAX_BYTES = 20 * 1024 * 1024;

function clock(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function EditorPanel({
  projectId,
  path,
  registerCloseGuard,
}: {
  projectId: string;
  path: string;
  registerCloseGuard: (guard: (() => boolean) | null) => void;
}) {
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const dirty = text !== savedText;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setConflict(false);
    try {
      const s = await statFile(projectId, path);
      if (s.isDir || !isTextFile(s.mime, path)) throw new Error(`not a text file (${s.mime})`);
      if (s.size > MAX_BYTES) throw new Error('file too large to edit (>20MB)');
      const t = await readFileText(projectId, path);
      setText(t);
      setSavedText(t);
      setBaseMtime(s.mtimeMs);
      setStatus(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, path]);

  useEffect(() => { void load(); }, [load]);

  // Close guard (rule: dirty → confirm) + beforeunload for page navigation.
  useEffect(() => {
    registerCloseGuard(() => !dirtyRef.current || window.confirm('Discard unsaved changes?'));
    return () => registerCloseGuard(null);
  }, [registerCloseGuard]);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const save = useCallback(async (force: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await writeFile(projectId, path, text, force ? undefined : baseMtime ?? undefined);
      setSavedText(text);
      setBaseMtime(res.mtimeMs);
      setConflict(false);
      setStatus(`Saved ${clock()}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else setStatus(`Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [saving, projectId, path, text, baseMtime]);

  const reload = useCallback(() => {
    if (dirtyRef.current && !window.confirm('Discard unsaved changes and reload from disk?')) return;
    void load();
  }, [load]);

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (dirty && !saving) void save(false);
    }
  }

  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const el = e.currentTarget;
      el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
      setText(el.value);
    }
  }

  if (err) {
    return (
      <div className="editor-panel">
        <div className="viewer-toolbar editor-toolbar">
          <span className="editor-path" title={path}>{path}</span>
          <span className="editor-spacer" />
          <button onClick={reload}>Retry</button>
        </div>
        <div className="viewer-empty">Error: {err}</div>
      </div>
    );
  }

  return (
    <div className="editor-panel" onKeyDown={onKeyDown}>
      <div className="viewer-toolbar editor-toolbar">
        <span className="editor-path" title={path}>{path}</span>
        {dirty && <span className="editor-dirty">● Unsaved</span>}
        {!dirty && status && <span className="editor-status">{status}</span>}
        {dirty && status?.startsWith('Save failed') && <span className="editor-status editor-status-err">{status}</span>}
        <span className="editor-spacer" />
        <button onClick={reload} disabled={loading}>Reload</button>
        <button
          className="editor-save"
          onClick={() => void save(false)}
          disabled={!dirty || saving || loading}
          title="Save (⌘/Ctrl+S)"
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {conflict && (
        <div className="editor-conflict">
          <span>File changed on disk since you opened it.</span>
          <button onClick={reload}>Reload</button>
          <button onClick={() => void save(true)}>Overwrite</button>
        </div>
      )}
      {loading ? (
        <div className="viewer-empty">Loading…</div>
      ) : (
        <textarea
          className="editor-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
        />
      )}
    </div>
  );
}
