import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  deleteTestCase,
  isValidCaseSlug,
  parseCaseFrontmatter,
  readTestCase,
  readTestReport,
  scanTestCases,
  scanTestReports,
  summarizeReport,
  validateCaseText,
  writeTestCase,
} from '../aie.js';

const SAMPLE_CASE = `---
name: 对话跑偏时应主动复述焦点
description: 检验焦点维护
created: 2026-09-13
prompt: |
  第一行
  第二行："引号"
criteria:
  - 察觉到用户在扩大范围
  - 先复述焦点
forbidden_reads: []
judge_hints: |
  重点看 AI 有没有触发约定。
---

# 备注
`;

describe('parseCaseFrontmatter', () => {
  it('parses scalars, block scalars and lists', () => {
    const fm = parseCaseFrontmatter(SAMPLE_CASE)!;
    expect(fm.name).toBe('对话跑偏时应主动复述焦点');
    expect(fm.description).toBe('检验焦点维护');
    expect(fm.created).toBe('2026-09-13');
    expect(fm.prompt).toBe('第一行\n第二行："引号"');
    expect(fm.criteria).toEqual(['察觉到用户在扩大范围', '先复述焦点']);
    expect(fm.extra.forbidden_reads).toEqual([]);
    expect(fm.extra.judge_hints).toBe('重点看 AI 有没有触发约定。');
  });

  it('returns null without a frontmatter fence', () => {
    expect(parseCaseFrontmatter('# nope')).toBeNull();
  });

  it('handles empty criteria placeholder from the template', () => {
    const fm = parseCaseFrontmatter('---\nname: x\nprompt: |\n  \ncriteria:\n  - \n---\n')!;
    expect(fm.criteria).toEqual(['']);
    expect(fm.prompt).toBe('');
  });
});

describe('validateCaseText / isValidCaseSlug', () => {
  it('accepts a complete case', () => {
    expect(validateCaseText(SAMPLE_CASE)).toBeNull();
  });
  it('rejects missing prompt and empty criteria', () => {
    expect(validateCaseText('---\nname: x\ncriteria:\n  - a\n---\n')).toMatch(/prompt/);
    expect(validateCaseText('---\nname: x\nprompt: hi\ncriteria:\n  - \n---\n')).toMatch(/criteria/);
    expect(validateCaseText('no fence')).toMatch(/frontmatter/);
  });
  it('validates slugs', () => {
    expect(isValidCaseSlug('sample-focus-narrowing')).toBe(true);
    expect(isValidCaseSlug('Bad_Slug')).toBe(false);
    expect(isValidCaseSlug('../etc')).toBe(false);
    expect(isValidCaseSlug('a'.repeat(65))).toBe(false);
  });
});

describe('summarizeReport', () => {
  it('derives verdict and falls back to filename parts', () => {
    const s = summarizeReport('20260909-201500__foo.json', {
      judge_verdict: { passed: true, severity: 'low' },
      skipped: false,
      duration_ms: 12,
      target_commit_sha: 'abc',
      fix_round: null,
    })!;
    expect(s).toMatchObject({ timestamp: '20260909-201500', caseSlug: 'foo', verdict: 'passed', severity: 'low', durationMs: 12, commitSha: 'abc', fixRound: null });
    expect(summarizeReport('20260909-201500__foo.json', { skipped: true, judge_verdict: null })!.verdict).toBe('skipped');
    expect(summarizeReport('20260909-201500__foo.json', { judge_verdict: { passed: false } })!.verdict).toBe('failed');
    expect(summarizeReport('bad.json', {})).toBeNull();
  });
});

describe('case + report file helpers', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aie-test-tab-'));
    const reports = path.join(dir, '.aie', 'test-reports');
    await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(
      path.join(reports, '20260908-101200__foo.json'),
      JSON.stringify({ case_slug: 'foo', case_name: 'Foo', timestamp: '20260908-101200', judge_verdict: { passed: false, severity: 'high' } }),
    );
    await fs.writeFile(
      path.join(reports, '20260909-201500__foo.json'),
      JSON.stringify({ case_slug: 'foo', case_name: 'Foo', timestamp: '20260909-201500', judge_verdict: { passed: true, severity: 'low' } }),
    );
    await fs.writeFile(path.join(reports, '20260909-201500__bar.json'), JSON.stringify({ skipped: true, skip_reason: 'timeout', judge_verdict: null }));
    await fs.writeFile(path.join(reports, '20260909-201500__broken.json'), '{not json');
    await fs.writeFile(path.join(reports, 'notes.txt'), 'ignored');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty lists when dirs are missing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'aie-empty-'));
    expect(await scanTestCases(empty)).toEqual([]);
    expect(await scanTestReports(empty)).toEqual([]);
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('writes, lists, reads and deletes a case with create/409 guard', async () => {
    expect(await writeTestCase(dir, 'sample-case', SAMPLE_CASE, { create: true })).toEqual({ ok: true });
    expect(await writeTestCase(dir, 'sample-case', SAMPLE_CASE, { create: true })).toMatchObject({ ok: false, status: 409 });
    expect(await writeTestCase(dir, 'Bad Slug', SAMPLE_CASE)).toMatchObject({ ok: false, status: 400 });
    expect(await writeTestCase(dir, 'sample-case', '---\nname: x\n---\n')).toMatchObject({ ok: false, status: 400 });

    const cases = await scanTestCases(dir);
    expect(cases).toEqual([
      {
        slug: 'sample-case',
        name: '对话跑偏时应主动复述焦点',
        description: '检验焦点维护',
        created: '2026-09-13',
        criteriaCount: 2,
        source: '.claude/aie-tests/sample-case.md',
      },
    ]);
    expect(await readTestCase(dir, 'sample-case')).toBe(SAMPLE_CASE);
    expect(await readTestCase(dir, 'missing')).toBeNull();

    expect(await deleteTestCase(dir, 'sample-case')).toBe(true);
    expect(await deleteTestCase(dir, 'sample-case')).toBe(false);
    expect(await scanTestCases(dir)).toEqual([]);
  });

  it('scans reports newest first, skipping malformed and non-report files', async () => {
    const reports = await scanTestReports(dir);
    expect(reports.map((r) => [r.file, r.verdict])).toEqual([
      ['20260909-201500__bar.json', 'skipped'],
      ['20260909-201500__foo.json', 'passed'],
      ['20260908-101200__foo.json', 'failed'],
    ]);
    expect(reports[1]).toMatchObject({ caseName: 'Foo', severity: 'low', fixRound: null });
  });

  it('reads a single report and rejects bad names', async () => {
    const r = (await readTestReport(dir, '20260909-201500__foo.json')) as any;
    expect(r.case_slug).toBe('foo');
    expect(await readTestReport(dir, '../../etc/passwd')).toBeNull();
    expect(await readTestReport(dir, '20260909-201500__nope.json')).toBeNull();
    expect(await readTestReport(dir, '20260909-201500__broken.json')).toBeNull();
  });
});
