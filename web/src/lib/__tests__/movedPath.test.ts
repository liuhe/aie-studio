import { describe, expect, it } from 'vitest';
import { joinPath, parentPath, rewriteMovedPath } from '../movedPath';

describe('rewriteMovedPath', () => {
  it('rewrites the moved entry itself', () => {
    expect(rewriteMovedPath('docs/a.md', 'docs/a.md', 'archive/a.md')).toBe('archive/a.md');
  });

  it('rewrites descendants of a moved directory', () => {
    expect(rewriteMovedPath('docs/sub/a.md', 'docs', 'notes')).toBe('notes/sub/a.md');
    expect(rewriteMovedPath('docs/a.md', 'docs', 'x/docs')).toBe('x/docs/a.md');
  });

  it('leaves unrelated paths alone, including prefix-sharing siblings', () => {
    expect(rewriteMovedPath('src/a.ts', 'docs', 'notes')).toBeNull();
    expect(rewriteMovedPath('docs2/a.md', 'docs', 'notes')).toBeNull();
  });
});

describe('parentPath / joinPath', () => {
  it('round-trip at the root and nested', () => {
    expect(parentPath('a.md')).toBe('');
    expect(parentPath('docs/a.md')).toBe('docs');
    expect(joinPath('', 'a.md')).toBe('a.md');
    expect(joinPath('docs', 'a.md')).toBe('docs/a.md');
  });
});
