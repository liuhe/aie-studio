import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseFrontmatter, scanAgents, scanAieProjects, scanSkills } from '../aie.js';

describe('parseFrontmatter', () => {
  it('extracts flat key: value pairs from a fenced block', () => {
    const fm = parseFrontmatter('---\nname: foo\ndescription: hello world\n---\nbody');
    expect(fm).toEqual({ name: 'foo', description: 'hello world' });
  });

  it('returns {} when no frontmatter fence is present', () => {
    expect(parseFrontmatter('# just markdown\n')).toEqual({});
  });

  it('strips surrounding quotes on values', () => {
    const fm = parseFrontmatter('---\nname: "quoted"\nlabel: \'single\'\n---\n');
    expect(fm).toEqual({ name: 'quoted', label: 'single' });
  });
});

describe('scan helpers', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aie-test-'));
    await fs.mkdir(path.join(dir, '.claude', 'skills', 'demo'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: A demo skill\n---\nbody',
    );
    await fs.mkdir(path.join(dir, '.claude', 'agents'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\n---\nbody',
    );
    await fs.mkdir(path.join(dir, 'projects', 'sample'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'projects', 'sample', 'overview.md'),
      '# Sample\n\nFirst summary paragraph.\n\nSecond ignored.\n',
    );
    await fs.writeFile(path.join(dir, 'projects', 'sample', 'tasks.md'), '# t');
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scans skills including subdir/SKILL.md layout', async () => {
    const skills = await scanSkills(dir);
    expect(skills).toEqual([
      { name: 'demo', description: 'A demo skill', source: '.claude/skills/demo/SKILL.md' },
    ]);
  });

  it('scans agents from .claude/agents/*.md', async () => {
    const agents = await scanAgents(dir);
    expect(agents).toEqual([
      {
        name: 'reviewer',
        description: 'Reviews',
        tools: 'Read, Grep',
        source: '.claude/agents/reviewer.md',
      },
    ]);
  });

  it('scans projects using overview.md first paragraph', async () => {
    const projects = await scanAieProjects(dir);
    expect(projects).toEqual([
      {
        name: 'sample',
        overviewSummary: 'First summary paragraph.',
        hasTasks: true,
        hasLog: false,
        hasDesign: false,
      },
    ]);
  });

  it('returns [] when .claude/skills/ is absent (empty project)', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'aie-empty-'));
    try {
      expect(await scanSkills(empty)).toEqual([]);
      expect(await scanAgents(empty)).toEqual([]);
      expect(await scanAieProjects(empty)).toEqual([]);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
