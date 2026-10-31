import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mirrors ~/.local/share/devin/cli/_versions as the CLI updater lays it out.
let dir: string;
let mod: typeof import('../devin-versions.js');

function install(v: string) {
  fs.mkdirSync(path.join(dir, v, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, v, 'bin', 'devin'), '#!/bin/sh\n');
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-versions-'));
  for (const v of ['3000.6.7', '3000.11.228', '3000.11.92', '2026.5.6-12']) install(v);
  fs.mkdirSync(path.join(dir, '_download'));
  fs.writeFileSync(path.join(dir, '_update.lock'), '');
  fs.mkdirSync(path.join(dir, 'broken')); // no bin/devin → ignored
  fs.symlinkSync('3000.11.92', path.join(dir, 'current'));
  process.env.REMOTE_IDE_DEVIN_VERSIONS_DIR = dir;
  mod = await import('../devin-versions.js');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('listDevinVersions', () => {
  it('lists installed versions newest-first and flags current', () => {
    expect(mod.listDevinVersions()).toEqual([
      { version: '3000.11.228', current: false },
      { version: '3000.11.92', current: true },
      { version: '3000.6.7', current: false },
      { version: '2026.5.6-12', current: false },
    ]);
  });
});

describe('resolveDevinBin', () => {
  const bin = (v: string) => path.join(dir, v, 'bin', 'devin');
  it('honours an installed pin', () => {
    expect(mod.resolveDevinBin('3000.6.7')).toBe(bin('3000.6.7'));
  });
  it('auto follows the current symlink', () => {
    expect(mod.resolveDevinBin('')).toBe(bin('3000.11.92'));
    expect(mod.resolveDevinBin(undefined)).toBe(bin('3000.11.92'));
  });
  it('warns and falls back to auto when the pin is not installed', () => {
    const warnings: string[] = [];
    expect(mod.resolveDevinBin('9999.0.0', (m) => warnings.push(m))).toBe(bin('3000.11.92'));
    expect(warnings[0]).toMatch(/9999\.0\.0 not installed/);
  });
  it('without a current link picks the newest installed, and PATH when nothing is installed', () => {
    fs.unlinkSync(path.join(dir, 'current'));
    expect(mod.resolveDevinBin('')).toBe(bin('3000.11.228'));
    for (const v of ['3000.6.7', '3000.11.228', '3000.11.92', '2026.5.6-12']) fs.rmSync(path.join(dir, v), { recursive: true });
    expect(mod.resolveDevinBin('')).toBe('devin');
    expect(mod.listDevinVersions()).toEqual([]);
  });
});
