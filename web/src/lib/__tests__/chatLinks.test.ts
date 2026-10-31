import { describe, expect, it } from 'vitest';
import { resolveChatLink } from '../chatLinks';
import { REF_HREF_PREFIX } from '../devinRefs';

const ROOT = '/tmp/project';

describe('resolveChatLink', () => {
  it('opens web URLs externally', () => {
    expect(resolveChatLink('https://example.com/a?b=1', ROOT)).toEqual({ kind: 'external', href: 'https://example.com/a?b=1' });
    expect(resolveChatLink('HTTP://x.y', ROOT).kind).toBe('external');
    expect(resolveChatLink('mailto:a@b.c', ROOT).kind).toBe('external');
    expect(resolveChatLink('//cdn.example.com/x.js', ROOT).kind).toBe('external');
  });

  it('turns relative paths into file tabs', () => {
    expect(resolveChatLink('web/src/App.tsx', ROOT)).toEqual({ kind: 'file', rel: 'web/src/App.tsx' });
    expect(resolveChatLink('./docs/a%20b.md', ROOT)).toEqual({ kind: 'file', rel: 'docs/a b.md' });
    expect(resolveChatLink('docs/x.md#section', ROOT)).toEqual({ kind: 'file', rel: 'docs/x.md' });
    expect(resolveChatLink('web/src/App.tsx:12', ROOT)).toEqual({ kind: 'file', rel: 'web/src/App.tsx', lines: '12' });
    expect(resolveChatLink('web/src/App.tsx:12-20', ROOT)).toEqual({ kind: 'file', rel: 'web/src/App.tsx', lines: '12-20' });
    expect(resolveChatLink('web/src/App.tsx#L12-L20', ROOT)).toEqual({ kind: 'file', rel: 'web/src/App.tsx', lines: '12-20' });
    expect(resolveChatLink('App.tsx:12', undefined)).toEqual({ kind: 'file', rel: 'App.tsx', lines: '12' });
  });

  it('maps absolute and file:// paths inside the project', () => {
    expect(resolveChatLink(`${ROOT}/server/src/fs.ts`, ROOT)).toEqual({ kind: 'file', rel: 'server/src/fs.ts' });
    expect(resolveChatLink(`file://${ROOT}/server/src/fs.ts:3`, ROOT)).toEqual({ kind: 'file', rel: 'server/src/fs.ts', lines: '3' });
    expect(resolveChatLink(`${ROOT}/`, ROOT).kind).toBe('inert');
  });

  it('keeps Devin refs working', () => {
    expect(resolveChatLink(`${REF_HREF_PREFIX}docs%2Fa%20b.md`, ROOT)).toEqual({ kind: 'file', rel: 'docs/a b.md' });
  });

  it('renders everything else as inert text', () => {
    expect(resolveChatLink('/etc/hosts', ROOT).kind).toBe('inert');
    expect(resolveChatLink(`${ROOT}/x.ts`, undefined).kind).toBe('inert');
    expect(resolveChatLink('../secret', ROOT).kind).toBe('inert');
    expect(resolveChatLink('~/x', ROOT).kind).toBe('inert');
    expect(resolveChatLink('javascript:alert(1)', ROOT).kind).toBe('inert');
    expect(resolveChatLink('data:text/plain,hi', ROOT).kind).toBe('inert');
    expect(resolveChatLink('#top', ROOT).kind).toBe('inert');
    expect(resolveChatLink('', ROOT).kind).toBe('inert');
    expect(resolveChatLink(undefined, ROOT).kind).toBe('inert');
  });
});
