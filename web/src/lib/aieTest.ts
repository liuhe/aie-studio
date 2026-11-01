import type { AieTestReportSummary, AieTestVerdict } from '../api';

// Pure helpers for the AIE Test tab. Kept free of React so they can be unit
// tested and so the panel stays a thin view over the server's report list.

export type AieTestRun = {
  timestamp: string;
  fixRound: number | null;
  passed: number;
  failed: number;
  skipped: number;
  reports: AieTestReportSummary[];
};

// Group report summaries by run timestamp (a batch shares one timestamp).
// Input is expected newest-first (server order); output keeps that order.
export function groupRuns(reports: AieTestReportSummary[]): AieTestRun[] {
  const byTs = new Map<string, AieTestRun>();
  for (const r of reports) {
    let run = byTs.get(r.timestamp);
    if (!run) {
      run = { timestamp: r.timestamp, fixRound: r.fixRound, passed: 0, failed: 0, skipped: 0, reports: [] };
      byTs.set(r.timestamp, run);
    }
    run[r.verdict]++;
    run.reports.push(r);
    if (run.fixRound == null && r.fixRound != null) run.fixRound = r.fixRound;
  }
  return [...byTs.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// Chronological (oldest → newest) verdict strip for one case, capped to the
// most recent `limit` reports.
export function caseHistory(reports: AieTestReportSummary[], slug: string, limit = 10): AieTestVerdict[] {
  const mine = reports.filter((r) => r.caseSlug === slug).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return mine.slice(Math.max(0, mine.length - limit)).map((r) => r.verdict);
}

export function latestReport(reports: AieTestReportSummary[], slug: string): AieTestReportSummary | null {
  let best: AieTestReportSummary | null = null;
  for (const r of reports) {
    if (r.caseSlug !== slug) continue;
    if (!best || r.timestamp.localeCompare(best.timestamp) > 0) best = r;
  }
  return best;
}

export const VERDICT_GLYPH: Record<AieTestVerdict, string> = { passed: '✓', failed: '✗', skipped: '⏭' };

// "20260909-201500" → "2026-09-09 20:15:00"
export function formatRunTimestamp(ts: string): string {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return ts;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function caseTemplate(slug: string, today = new Date()): string {
  const d = today.toISOString().slice(0, 10);
  return `---
name: ${slug}
description:
created: ${d}
prompt: |
  
criteria:
  - 
---

# 备注
`;
}

export const CASE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export function isValidCaseSlug(slug: string): boolean {
  return CASE_SLUG_RE.test(slug) && slug.length <= 64;
}

export function runPrompt(slug?: string): string {
  return slug ? `/aie-test ${slug}` : '/aie-test';
}
