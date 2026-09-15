import { describe, expect, it } from 'vitest';
import type { AieTestReportSummary } from '../../api';
import {
  caseHistory,
  caseTemplate,
  formatDuration,
  formatRunTimestamp,
  groupRuns,
  isValidCaseSlug,
  latestReport,
  runPrompt,
} from '../aieTest';

function rep(p: Partial<AieTestReportSummary> & Pick<AieTestReportSummary, 'timestamp' | 'caseSlug' | 'verdict'>): AieTestReportSummary {
  return {
    file: `${p.timestamp}__${p.caseSlug}.json`,
    caseName: p.caseSlug,
    severity: null,
    fixRound: null,
    durationMs: null,
    commitSha: null,
    ...p,
  };
}

const REPORTS: AieTestReportSummary[] = [
  rep({ timestamp: '20260909-201500', caseSlug: 'bar', verdict: 'skipped' }),
  rep({ timestamp: '20260909-201500', caseSlug: 'foo', verdict: 'passed' }),
  rep({ timestamp: '20260908-101200', caseSlug: 'foo', verdict: 'failed', fixRound: 1 }),
  rep({ timestamp: '20260907-090000', caseSlug: 'foo', verdict: 'failed' }),
];

describe('groupRuns', () => {
  it('groups by timestamp newest first with verdict counts and fixRound', () => {
    const runs = groupRuns(REPORTS);
    expect(runs.map((r) => r.timestamp)).toEqual(['20260909-201500', '20260908-101200', '20260907-090000']);
    expect(runs[0]).toMatchObject({ passed: 1, failed: 0, skipped: 1, fixRound: null });
    expect(runs[0].reports.map((r) => r.caseSlug)).toEqual(['bar', 'foo']);
    expect(runs[1]).toMatchObject({ failed: 1, fixRound: 1 });
  });
  it('returns [] for no reports', () => {
    expect(groupRuns([])).toEqual([]);
  });
});

describe('caseHistory / latestReport', () => {
  it('returns chronological verdicts capped to limit', () => {
    expect(caseHistory(REPORTS, 'foo')).toEqual(['failed', 'failed', 'passed']);
    expect(caseHistory(REPORTS, 'foo', 2)).toEqual(['failed', 'passed']);
    expect(caseHistory(REPORTS, 'nope')).toEqual([]);
  });
  it('picks the newest report for a case', () => {
    expect(latestReport(REPORTS, 'foo')?.timestamp).toBe('20260909-201500');
    expect(latestReport(REPORTS, 'nope')).toBeNull();
  });
});

describe('formatting + template', () => {
  it('formats run timestamps and durations', () => {
    expect(formatRunTimestamp('20260909-201500')).toBe('2026-09-09 20:15:00');
    expect(formatRunTimestamp('weird')).toBe('weird');
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(12400)).toBe('12.4s');
    expect(formatDuration(125000)).toBe('2m5s');
  });
  it('builds a template that carries the slug and date', () => {
    const t = caseTemplate('my-case', new Date('2026-09-13T00:00:00Z'));
    expect(t.startsWith('---\nname: my-case\n')).toBe(true);
    expect(t).toContain('created: 2026-09-13');
    expect(t).toContain('criteria:\n  - ');
  });
  it('validates slugs and builds run prompts', () => {
    expect(isValidCaseSlug('ok-slug-1')).toBe(true);
    expect(isValidCaseSlug('Nope')).toBe(false);
    expect(isValidCaseSlug('')).toBe(false);
    expect(runPrompt()).toBe('/aie-test');
    expect(runPrompt('x')).toBe('/aie-test x');
  });
});
