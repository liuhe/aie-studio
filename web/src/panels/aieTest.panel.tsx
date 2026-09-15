import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteAieTestCase,
  listAieTestCases,
  listAieTestReports,
  readAieTestCase,
  readAieTestReport,
  writeAieTestCase,
  type AieTestCase,
  type AieTestReport,
  type AieTestReportSummary,
  type AieTestVerdict,
} from '../api';
import { registerTabKind, type TabRenderContext } from '../registry';
import {
  caseHistory,
  caseTemplate,
  formatDuration,
  formatRunTimestamp,
  groupRuns,
  isValidCaseSlug,
  latestReport,
  runPrompt,
  VERDICT_GLYPH,
} from '../lib/aieTest';

// Model: web.AieTestPanel / page web/AieTestView. Single-column, three views
// (overview / case editor / report detail) held in component state; the Tab
// itself only carries { id, type, groupId }.
declare module '../types' {
  interface TabKindMap {
    'aie-test': { id: string; type: 'aie-test'; groupId?: string };
  }
}

type View =
  | { kind: 'overview' }
  | { kind: 'case'; slug: string; create: boolean }
  | { kind: 'report'; file: string };

function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

function VerdictBadge({ verdict }: { verdict: AieTestVerdict }) {
  return <span className={`aie-test-badge aie-test-badge-${verdict}`}>{VERDICT_GLYPH[verdict]} {verdict}</span>;
}

function HistoryStrip({ history }: { history: AieTestVerdict[] }) {
  if (history.length === 0) return <span className="aie-test-strip aie-test-strip-empty">no runs</span>;
  return (
    <span className="aie-test-strip" title={`${history.length} most recent runs, oldest → newest`}>
      {history.map((v, i) => (
        <span key={i} className={`aie-test-strip-cell aie-test-strip-${v}`}>{VERDICT_GLYPH[v]}</span>
      ))}
    </span>
  );
}

function AieTestPanel({ project, openTab }: Pick<TabRenderContext, 'project' | 'openTab'>) {
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [cases, setCases] = useState<AieTestCase[] | null>(null);
  const [reports, setReports] = useState<AieTestReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, r] = await Promise.all([listAieTestCases(project.id), listAieTestReports(project.id)]);
      setCases(c);
      setReports(r);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  // Initial load + refresh once when the page comes back to the foreground
  // (reports land minutes after ▶; no polling — see model rule).
  useEffect(() => {
    void refresh();
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const run = (slug?: string) => {
    openTab({ id: shortId(), type: 'session', initialPrompt: runPrompt(slug) });
  };

  const newCase = () => {
    const raw = window.prompt('New case slug (kebab-case, e.g. focus-narrowing):');
    if (raw == null) return;
    const slug = raw.trim();
    if (!isValidCaseSlug(slug)) {
      window.alert('Invalid slug: use lowercase letters, digits and dashes (max 64).');
      return;
    }
    if (cases?.some((c) => c.slug === slug)) {
      window.alert(`Case "${slug}" already exists.`);
      return;
    }
    setView({ kind: 'case', slug, create: true });
  };

  if (view.kind === 'case') {
    return (
      <CaseEditor
        projectId={project.id}
        slug={view.slug}
        create={view.create}
        onBack={() => setView({ kind: 'overview' })}
        onSaved={() => {
          void refresh();
          setView({ kind: 'overview' });
        }}
        onDeleted={() => {
          void refresh();
          setView({ kind: 'overview' });
        }}
      />
    );
  }
  if (view.kind === 'report') {
    return <ReportDetail projectId={project.id} file={view.file} onBack={() => setView({ kind: 'overview' })} />;
  }

  return (
    <div className="aie-test">
      <div className="viewer-toolbar aie-test-toolbar">
        <button type="button" onClick={() => run()} disabled={!cases || cases.length === 0} title="Open a Claude tab and send /aie-test">
          ▶ Run all
        </button>
        <button type="button" onClick={() => void refresh()} disabled={loading}>↻ Refresh</button>
        <button type="button" onClick={newCase}>+ New case</button>
        <span className="aie-test-toolbar-path">.claude/aie-tests · .aie/test-reports</span>
      </div>
      <div className="panel-body aie-test-body">
        {error && <div className="aie-test-error">{error}</div>}
        <Overview
          cases={cases}
          reports={reports}
          onRun={run}
          onEdit={(slug) => setView({ kind: 'case', slug, create: false })}
          onOpenReport={(file) => setView({ kind: 'report', file })}
        />
      </div>
    </div>
  );
}

function Overview({
  cases,
  reports,
  onRun,
  onEdit,
  onOpenReport,
}: {
  cases: AieTestCase[] | null;
  reports: AieTestReportSummary[] | null;
  onRun: (slug: string) => void;
  onEdit: (slug: string) => void;
  onOpenReport: (file: string) => void;
}) {
  const runs = useMemo(() => groupRuns(reports ?? []), [reports]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  // Newest run expanded by default.
  const expandedRun = openRun ?? runs[0]?.timestamp ?? null;

  return (
    <>
      <section className="aie-test-section">
        <h3 className="aie-test-h">Cases {cases ? `(${cases.length})` : ''}</h3>
        {!cases && <div className="aie-test-muted">Loading…</div>}
        {cases && cases.length === 0 && (
          <div className="aie-test-muted">No cases yet. Use “+ New case” to add one under .claude/aie-tests/.</div>
        )}
        {cases && cases.length > 0 && (
          <ul className="aie-test-list">
            {cases.map((c) => {
              const latest = reports ? latestReport(reports, c.slug) : null;
              return (
                <li key={c.slug} className="aie-test-row">
                  <div className="aie-test-row-main">
                    <div className="aie-test-row-title">
                      <span className="aie-test-name">{c.name}</span>
                      <code className="settings-mono">{c.slug}</code>
                    </div>
                    {c.description && <div className="aie-test-desc">{c.description}</div>}
                    <div className="aie-test-row-meta">
                      <HistoryStrip history={reports ? caseHistory(reports, c.slug) : []} />
                      {latest && (
                        <button type="button" className="aie-test-link" onClick={() => onOpenReport(latest.file)}>
                          <VerdictBadge verdict={latest.verdict} /> {formatRunTimestamp(latest.timestamp)}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="aie-test-row-actions">
                    <button type="button" onClick={() => onRun(c.slug)} title={runPrompt(c.slug)}>▶</button>
                    <button type="button" onClick={() => onEdit(c.slug)}>Edit</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="aie-test-section">
        <h3 className="aie-test-h">Runs {reports ? `(${runs.length})` : ''}</h3>
        {!reports && <div className="aie-test-muted">Loading…</div>}
        {reports && runs.length === 0 && (
          <div className="aie-test-muted">No reports yet. Press ▶ to run; results appear here after /aie-test finishes.</div>
        )}
        {runs.map((run) => {
          const open = run.timestamp === expandedRun;
          return (
            <div key={run.timestamp} className="aie-test-run">
              <button type="button" className="aie-test-run-head" onClick={() => setOpenRun(open ? '' : run.timestamp)}>
                <span className="tool-chevron">{open ? '▾' : '▸'}</span>
                <span className="aie-test-run-ts">{formatRunTimestamp(run.timestamp)}</span>
                <span className="aie-test-run-counts">
                  <span className="aie-test-count-passed">{run.passed} ✓</span>
                  <span className="aie-test-count-failed">{run.failed} ✗</span>
                  {run.skipped > 0 && <span className="aie-test-count-skipped">{run.skipped} ⏭</span>}
                </span>
                {run.fixRound != null && <span className="aie-test-tag">fix round {run.fixRound}</span>}
              </button>
              {open && (
                <ul className="aie-test-list aie-test-run-list">
                  {run.reports.map((r) => (
                    <li key={r.file}>
                      <button type="button" className="aie-test-report-row" onClick={() => onOpenReport(r.file)}>
                        <VerdictBadge verdict={r.verdict} />
                        <span className="aie-test-name">{r.caseName || r.caseSlug}</span>
                        <span className="aie-test-report-meta">
                          {r.severity && r.verdict === 'failed' ? `severity ${r.severity}` : ''}
                          {r.durationMs != null ? ` · ${formatDuration(r.durationMs)}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>
    </>
  );
}

function CaseEditor({
  projectId,
  slug,
  create,
  onBack,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  slug: string;
  create: boolean;
  onBack: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [text, setText] = useState<string | null>(create ? caseTemplate(slug) : null);
  const [original, setOriginal] = useState<string>(create ? caseTemplate(slug) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (create) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await readAieTestCase(projectId, slug);
        if (!cancelled) {
          setText(t);
          setOriginal(t);
        }
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, slug, create]);

  const dirty = text != null && text !== original;

  const back = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onBack();
  };

  const save = async () => {
    if (text == null) return;
    setBusy(true);
    setError(null);
    try {
      await writeAieTestCase(projectId, slug, text, { create });
      onSaved();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (!window.confirm(`Delete case "${slug}"? Reports are kept.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAieTestCase(projectId, slug);
      onDeleted();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aie-test">
      <div className="viewer-toolbar aie-test-toolbar">
        <button type="button" onClick={back}>← Back</button>
        <span className="aie-test-toolbar-title">
          {create ? 'New case' : 'Edit case'} <code className="settings-mono">{slug}.md</code>
          {dirty && <span className="aie-test-dirty">●</span>}
        </span>
        <span className="aie-test-toolbar-spacer" />
        {!create && <button type="button" onClick={del} disabled={busy} className="aie-test-danger">Delete</button>}
        <button type="button" onClick={save} disabled={busy || text == null || (!create && !dirty)}>Save</button>
      </div>
      {error && <div className="aie-test-error">{error}</div>}
      {text == null ? (
        <div className="aie-test-muted aie-test-body">Loading…</div>
      ) : (
        <textarea
          className="aie-test-editor"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      )}
    </div>
  );
}

function ReportDetail({ projectId, file, onBack }: { projectId: string; file: string; onBack: () => void }) {
  const [report, setReport] = useState<AieTestReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await readAieTestReport(projectId, file);
        if (!cancelled) setReport(r);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, file]);

  const verdict: AieTestVerdict | null = report
    ? report.skipped
      ? 'skipped'
      : report.judge_verdict?.passed
        ? 'passed'
        : 'failed'
    : null;
  const criteria = report
    ? Array.isArray(report.criteria)
      ? report.criteria
      : report.criteria
        ? [report.criteria]
        : []
    : [];

  return (
    <div className="aie-test">
      <div className="viewer-toolbar aie-test-toolbar">
        <button type="button" onClick={onBack}>← Back</button>
        <span className="aie-test-toolbar-title">
          Report <code className="settings-mono">{file}</code>
        </span>
      </div>
      <div className="panel-body aie-test-body">
        {error && <div className="aie-test-error">{error}</div>}
        {!report && !error && <div className="aie-test-muted">Loading…</div>}
        {report && verdict && (
          <>
            <div className="aie-test-verdict">
              <VerdictBadge verdict={verdict} />
              <span className="aie-test-name">{report.case_name || report.case_slug}</span>
              {report.judge_verdict?.severity && verdict === 'failed' && (
                <span className="aie-test-tag">severity {report.judge_verdict.severity}</span>
              )}
              {report.fix_round != null && <span className="aie-test-tag">fix round {report.fix_round}</span>}
            </div>
            {report.skipped ? (
              <p className="aie-test-reasoning">Skipped: {report.skip_reason || 'no reason recorded'}</p>
            ) : (
              <p className="aie-test-reasoning">{report.judge_verdict?.reasoning || '(no reasoning)'}</p>
            )}

            <h4 className="aie-test-h">Criteria</h4>
            <ol className="aie-test-criteria">
              {criteria.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ol>

            <h4 className="aie-test-h">Prompt</h4>
            <pre className="aie-test-pre">{report.prompt ?? ''}</pre>

            <h4 className="aie-test-h">Response</h4>
            <pre className="aie-test-pre">{report.response ?? ''}</pre>

            {report.judge_hints && (
              <>
                <h4 className="aie-test-h">Judge hints</h4>
                <pre className="aie-test-pre">{report.judge_hints}</pre>
              </>
            )}

            <h4 className="aie-test-h">Meta</h4>
            <dl className="aie-test-meta">
              <dt>run</dt><dd>{formatRunTimestamp(report.timestamp)}</dd>
              <dt>duration</dt><dd>{formatDuration(report.duration_ms) || '—'}</dd>
              <dt>commit</dt><dd>{report.target_commit_sha || '—'}</dd>
              <dt>target</dt><dd>{report.target_root || report.target || '—'}</dd>
              <dt>case</dt><dd><code className="settings-mono">{report.case_slug}</code></dd>
            </dl>
          </>
        )}
      </div>
    </div>
  );
}

registerTabKind({
  id: 'aie-test',
  label: 'AIE Tests',
  singleton: true,
  render: ({ project, openTab }) => <AieTestPanel project={project} openTab={openTab} />,
  createAction: {
    label: '+ AIE Tests',
    create: () => ({ id: shortId(), type: 'aie-test' }),
  },
});
