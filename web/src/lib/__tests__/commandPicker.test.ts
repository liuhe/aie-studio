import { describe, expect, it } from 'vitest';
import {
  acpCommandsToItems, agentInsertText, filterCommands, matchCommandQuery, toCommandItems,
} from '../commandPicker';

describe('matchCommandQuery', () => {
  it('opens on a leading slash with empty query', () => {
    expect(matchCommandQuery('/')).toBe('');
  });
  it('captures the partial token after the slash', () => {
    expect(matchCommandQuery('/aie')).toBe('aie');
    expect(matchCommandQuery('/aie-pm')).toBe('aie-pm');
  });
  it('closes once whitespace follows the token (arguments phase)', () => {
    expect(matchCommandQuery('/aie-pm ')).toBeNull();
    expect(matchCommandQuery('/aie-pm foo')).toBeNull();
  });
  it('ignores slashes that are not at the start of the message', () => {
    expect(matchCommandQuery('see /tmp/project')).toBeNull();
    expect(matchCommandQuery('a/')).toBeNull();
    expect(matchCommandQuery('')).toBeNull();
  });
  it('still matches a path-like token at the start (filter then hides it)', () => {
    expect(matchCommandQuery('/tmp/project')).toBe('tmp/project');
  });
});

// A catalog that reports nothing: no bundled entries, no built-ins pass the
// live gate — leaves exactly the project skills + agents.
const EMPTY_CATALOG = { slashCommands: [], skills: [], agents: [], terminalSlashCommands: [] };

const items = toCommandItems(
  [
    { name: 'verify', description: 'v', source: 's' },
    { name: 'aie-pm', description: 'pm', source: 's' },
  ],
  [
    { name: 'aie-role-qa', description: 'qa', tools: '*', source: 'a' },
    { name: 'Explore', description: 'ex', tools: '*', source: 'a' },
  ],
  EMPTY_CATALOG,
);

describe('toCommandItems (Claude)', () => {
  it('skills insert "/name " and agents insert the instruction template', () => {
    expect(items.find((i) => i.name === 'aie-pm')?.insert).toBe('/aie-pm ');
    expect(items.find((i) => i.name === 'aie-pm')?.label).toBe('/aie-pm');
    expect(items.find((i) => i.name === 'Explore')?.insert).toBe(agentInsertText('Explore'));
    expect(items.find((i) => i.name === 'Explore')?.label).toBe('Explore');
    expect(agentInsertText('x')).not.toContain('@');
  });
});

describe('acpCommandsToItems (Devin)', () => {
  const acp = acpCommandsToItems([
    { name: 'login', description: 'Authenticate', input: { hint: '[api-key]' }, _meta: { 'cognition.ai/category': 'Account' } },
    { name: 'plan', description: 'Plan mode', input: { hint: '[prompt]' }, _meta: { 'cognition.ai/category': 'Session' } },
    { name: 'aie-pm', description: 'PM', input: null, _meta: { 'cognition.ai/category': 'Skills' } },
    { name: 'mystery', description: '' },
  ]);
  it('groups by Devin category, Skills first, others in agent order', () => {
    expect(acp.map((i) => `${i.group}:${i.name}`)).toEqual([
      'Skills:aie-pm', 'Skills:mystery', 'Account:login', 'Session:plan',
    ]);
  });
  it('shows the input hint in the label but inserts only "/name "', () => {
    expect(acp.find((i) => i.name === 'plan')?.label).toBe('/plan [prompt]');
    expect(acp.find((i) => i.name === 'plan')?.insert).toBe('/plan ');
    expect(acp.find((i) => i.name === 'aie-pm')?.label).toBe('/aie-pm');
  });
});

describe('toCommandItems with the CLI catalog', () => {
  const catalog = {
    slashCommands: ['aie-pm', 'deep-research', 'doctor', 'context', 'model', 'help', 'status', 'exit', 'compact'],
    skills: ['aie-pm', 'deep-research', 'doctor', 'unknown-skill'],
    agents: ['aie-role-qa', 'Explore', 'mystery-agent'],
    terminalSlashCommands: ['doctor'],
  };
  const merged = toCommandItems(
    [{ name: 'aie-pm', description: 'project pm', source: 's' }],
    [{ name: 'aie-role-qa', description: 'project qa', tools: '*', source: 'a' }],
    catalog,
  );
  it('adds bundled skills after project skills, dedups by name, drops terminal-only ones', () => {
    const skills = merged.filter((i) => i.group === 'Skills').map((i) => i.name);
    expect(skills).toEqual(['aie-pm', 'deep-research', 'unknown-skill']);
    expect(merged.find((i) => i.name === 'aie-pm')?.description).toBe('project pm');
    expect(merged.find((i) => i.name === 'deep-research')?.description).toMatch(/research/i);
    expect(merged.find((i) => i.name === 'unknown-skill')?.description).toBe('');
  });
  it('adds bundled agents with static descriptions', () => {
    const agents = merged.filter((i) => i.group === 'Agents').map((i) => i.name);
    expect(agents).toEqual(['aie-role-qa', 'Explore', 'mystery-agent']);
    expect(merged.find((i) => i.name === 'Explore')?.insert).toBe(agentInsertText('Explore'));
  });
  it('lists only allowlisted built-ins that the live catalog also has', () => {
    const cmds = merged.filter((i) => i.group === 'Commands').map((i) => i.name);
    expect(cmds).toEqual(['context', 'model', 'compact']);
    expect(cmds).not.toContain('help');
    expect(cmds).not.toContain('exit');
    expect(merged.find((i) => i.name === 'model')?.label).toBe('/model [name]');
    expect(merged.find((i) => i.name === 'model')?.insert).toBe('/model ');
  });
  it('falls back to the full allowlist (and no bundled entries) without a catalog', () => {
    const blind = toCommandItems([], [], null);
    expect(blind.every((i) => i.group === 'Commands')).toBe(true);
    expect(blind.map((i) => i.name)).toContain('context');
    expect(blind.map((i) => i.name)).not.toContain('deep-research');
  });
});

describe('filterCommands', () => {
  it('lists everything for an empty query, groups in first-appearance order, sorted by name', () => {
    expect(filterCommands(items, '').map((i) => i.name)).toEqual([
      'aie-pm', 'verify', 'aie-role-qa', 'Explore',
    ]);
  });
  it('prefers prefix matches over substring matches within a group', () => {
    const withSub = toCommandItems(
      [{ name: 'run-verify', description: '', source: '' }, { name: 'verify', description: '', source: '' }],
      [],
      EMPTY_CATALOG,
    );
    expect(filterCommands(withSub, 'ver').map((i) => i.name)).toEqual(['verify', 'run-verify']);
  });
  it('is case-insensitive and drops non-matches', () => {
    expect(filterCommands(items, 'EXP').map((i) => i.name)).toEqual(['Explore']);
    expect(filterCommands(items, 'tmp/project')).toEqual([]);
  });
});
