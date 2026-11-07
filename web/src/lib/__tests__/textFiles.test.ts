import { describe, expect, it } from 'vitest';
import { extOf, isTextFile } from '../textFiles';

describe('isTextFile', () => {
  it('accepts text-ish mimes regardless of extension', () => {
    expect(isTextFile('text/plain', 'NOTES')).toBe(true);
    expect(isTextFile('application/json', 'x.json5')).toBe(true);
    expect(isTextFile('text/typescript', 'a.ts')).toBe(true);
  });

  it('falls back to known source / markdown extensions when the mime is opaque', () => {
    expect(isTextFile('application/octet-stream', 'main.rs')).toBe(true);
    expect(isTextFile(undefined, 'README.md')).toBe(true);
  });

  it('rejects binaries', () => {
    expect(isTextFile('image/png', 'logo.png')).toBe(false);
    expect(isTextFile('application/pdf', 'doc.pdf')).toBe(false);
    expect(isTextFile('application/octet-stream', 'blob.bin')).toBe(false);
    expect(isTextFile(undefined, 'blob')).toBe(false);
  });

  it('extOf is lower-cased and empty for dotless names', () => {
    expect(extOf('A.TSX')).toBe('tsx');
    expect(extOf('Makefile')).toBe('');
  });
});
