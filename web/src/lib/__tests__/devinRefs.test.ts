import { describe, expect, it } from 'vitest';
import { REF_HREF_PREFIX, refFromHref, rewriteDevinRefs, toProjectRel } from '../devinRefs';

const ROOT = '/home/dev/repos/app';

describe('toProjectRel', () => {
  it('strips the project root', () => {
    expect(toProjectRel(`${ROOT}/src/a.ts`, ROOT)).toBe('src/a.ts');
    expect(toProjectRel(`${ROOT}/src/a.ts`, `${ROOT}/`)).toBe('src/a.ts');
  });
  it('rejects paths outside the project, sibling-prefix dirs and the root itself', () => {
    expect(toProjectRel('/etc/hosts', ROOT)).toBeNull();
    expect(toProjectRel(`${ROOT}-other/x.ts`, ROOT)).toBeNull();
    expect(toProjectRel(ROOT, ROOT)).toBeNull();
    expect(toProjectRel(`${ROOT}/`, ROOT)).toBeNull();
  });
  it('is null without a project path', () => {
    expect(toProjectRel(`${ROOT}/src/a.ts`, undefined)).toBeNull();
  });
});

describe('rewriteDevinRefs', () => {
  it('turns an in-project ref_file into a link with an encoded relative href', () => {
    const out = rewriteDevinRefs(`见 <ref_file file="${ROOT}/docs/a b.md" /> 一文`, ROOT);
    expect(out).toBe(`见 [\`docs/a b.md\`](${REF_HREF_PREFIX}docs%2Fa%20b.md) 一文`);
  });
  it('appends the line range for ref_snippet and tolerates attribute order / no space before />', () => {
    const out = rewriteDevinRefs(`<ref_snippet lines="10-20" file="${ROOT}/src/x.ts"/>`, ROOT);
    expect(out).toBe(`[\`src/x.ts:10-20\`](${REF_HREF_PREFIX}src%2Fx.ts)`);
  });
  it('degrades out-of-project refs to inline code', () => {
    expect(rewriteDevinRefs('<ref_file file="/etc/hosts" />', ROOT)).toBe('`/etc/hosts`');
    expect(rewriteDevinRefs(`<ref_file file="${ROOT}/x.ts" />`, undefined)).toBe(`\`${ROOT}/x.ts\``);
  });
  it('emits code only when links are disabled (export)', () => {
    expect(rewriteDevinRefs(`<ref_file file="${ROOT}/x.ts" />`, ROOT, { links: false })).toBe('`x.ts`');
  });
  it('rewrites every ref in a table row and leaves unknown tags alone', () => {
    const row = `| <ref_file file="${ROOT}/a.md" /> | <ref_file file="${ROOT}/b.py" /> |`;
    expect(rewriteDevinRefs(row, ROOT)).toBe(
      `| [\`a.md\`](${REF_HREF_PREFIX}a.md) | [\`b.py\`](${REF_HREF_PREFIX}b.py) |`,
    );
    expect(rewriteDevinRefs('<ref_file />', ROOT)).toBe('<ref_file />');
    expect(rewriteDevinRefs('<other file="x" />', ROOT)).toBe('<other file="x" />');
  });
});

describe('refFromHref', () => {
  it('round-trips the relative path', () => {
    expect(refFromHref(`${REF_HREF_PREFIX}docs%2Fa%20b.md`)).toBe('docs/a b.md');
  });
  it('ignores ordinary links and malformed encodings', () => {
    expect(refFromHref('https://example.com')).toBeNull();
    expect(refFromHref(undefined)).toBeNull();
    expect(refFromHref(`${REF_HREF_PREFIX}%E0%A4%A`)).toBeNull();
    expect(refFromHref(REF_HREF_PREFIX)).toBeNull();
  });
});
