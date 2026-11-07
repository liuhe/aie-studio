import { describe, expect, it } from 'vitest';
import { lookupMime, planMkdir, planMove, resolveRel } from '../fs.js';

describe('lookupMime', () => {
  it('treats TypeScript as text, not MPEG transport stream', () => {
    expect(lookupMime('/p/src/index.ts')).toBe('text/typescript');
    expect(lookupMime('/p/src/App.tsx')).toBe('text/tsx');
    expect(lookupMime('/p/src/x.mts')).toBe('text/typescript');
  });

  it('overrides other misleading or unknown source extensions', () => {
    expect(lookupMime('/p/main.rs')).toBe('text/x-rust');
    expect(lookupMime('/p/main.py')).toBe('text/x-python');
    expect(lookupMime('/p/main.go')).toBe('text/x-go');
    expect(lookupMime('/p/run.zsh')).toBe('text/x-shellscript');
  });

  it('recognises common extensionless / dot config files as text', () => {
    expect(lookupMime('/p/Dockerfile')).toBe('text/plain');
    expect(lookupMime('/p/Dockerfile.dev')).toBe('text/plain');
    expect(lookupMime('/p/.env.local')).toBe('text/plain');
    expect(lookupMime('/p/Makefile')).toBe('text/plain');
  });

  it('falls through to mime-types for everything else', () => {
    expect(lookupMime('/p/logo.png')).toBe('image/png');
    expect(lookupMime('/p/clip.mp4')).toBe('video/mp4');
    expect(lookupMime('/p/data.json')).toBe('application/json');
    expect(lookupMime('/p/blob.unknownext')).toBe('application/octet-stream');
  });
});

describe('resolveRel', () => {
  it('pins relative paths under the root and tolerates leading slashes', () => {
    expect(resolveRel('/p', 'a/b.txt')).toBe('/p/a/b.txt');
    expect(resolveRel('/p', '/a/b.txt')).toBe('/p/a/b.txt');
    expect(resolveRel('/p', '')).toBe('/p');
  });

  it('rejects escapes with a 400', () => {
    expect(() => resolveRel('/p', '../x')).toThrow(/escapes/);
    expect(() => resolveRel('/p', 'a/../../x')).toThrow(/escapes/);
    // Sibling that merely shares the root as a string prefix is still outside.
    expect(() => resolveRel('/p', '../p2/x')).toThrow(/escapes/);
  });
});

// Model: server.MoveEntry rule-407 / rule-409.
describe('planMove', () => {
  it('plans a rename within the same directory', () => {
    const plan = planMove('/p', 'docs/a.md', 'docs/b.md');
    expect(plan).toEqual({
      fromAbs: '/p/docs/a.md',
      toAbs: '/p/docs/b.md',
      fromRel: 'docs/a.md',
      toRel: 'docs/b.md',
    });
  });

  it('plans a move into another directory and normalises the returned paths', () => {
    const plan = planMove('/p', '/docs//a.md', 'archive/./a.md');
    expect(plan.fromRel).toBe('docs/a.md');
    expect(plan.toRel).toBe('archive/a.md');
  });

  it('refuses to move the project root or onto it', () => {
    expect(() => planMove('/p', '', 'x')).toThrow(/project root/);
    expect(() => planMove('/p', 'x', '')).toThrow(/project root/);
  });

  it('refuses escapes on either side', () => {
    expect(() => planMove('/p', '../x', 'y')).toThrow(/escapes/);
    expect(() => planMove('/p', 'x', '../y')).toThrow(/escapes/);
  });

  it('refuses no-op and into-itself moves', () => {
    expect(() => planMove('/p', 'a', 'a')).toThrow(/same/);
    expect(() => planMove('/p', 'a', 'a/b')).toThrow(/into itself/);
    expect(() => planMove('/p', 'a', 'a/b/c')).toThrow(/into itself/);
    // A sibling whose name merely extends the source name is fine.
    expect(planMove('/p', 'a', 'ab').toRel).toBe('ab');
  });
});

// Model: server.MakeDir rule-414.
describe('planMkdir', () => {
  it('resolves and normalises the new directory path', () => {
    expect(planMkdir('/p', 'docs/new')).toEqual({ abs: '/p/docs/new', rel: 'docs/new' });
    expect(planMkdir('/p', '/new//')).toEqual({ abs: '/p/new', rel: 'new' });
  });

  it('refuses the root and escapes', () => {
    expect(() => planMkdir('/p', '')).toThrow(/project root/);
    expect(() => planMkdir('/p', 'a/..')).toThrow(/project root/);
    expect(() => planMkdir('/p', '../x')).toThrow(/escapes/);
  });
});
