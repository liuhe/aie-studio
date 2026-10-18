import { describe, expect, it } from 'vitest';
import { lookupMime } from '../fs.js';

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
