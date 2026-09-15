import { describe, it, expect } from 'vitest';
import { normalizeProjectWorkspace, normalizePins, DEFAULT_GROUP_ID } from '../store.js';

describe('normalizeProjectWorkspace', () => {
  it('fills groups: [] for legacy slots that only have tabs', () => {
    const pw = normalizeProjectWorkspace({ tabs: [{ id: 'a', type: 'file', path: 'x' }], activeTabId: 'a' });
    expect(pw).toEqual({ tabs: [{ id: 'a', type: 'file', path: 'x' }], groups: [], pins: [] });
  });

  it('keeps tab.groupId untouched (absent means default Group)', () => {
    const pw = normalizeProjectWorkspace({
      tabs: [
        { id: 'a', type: 'file', path: 'x' },
        { id: 'b', type: 'session', groupId: 'g1' },
      ],
      groups: [{ id: 'g1', name: 'Work' }],
    });
    expect(pw.tabs[0]).not.toHaveProperty('groupId');
    expect((pw.tabs[1] as any).groupId).toBe('g1');
  });

  it('drops malformed, duplicate and default-id groups', () => {
    const pw = normalizeProjectWorkspace({
      tabs: [],
      groups: [
        { id: 'g1', name: 'Work' },
        { id: 'g1', name: 'Dup' },
        { id: DEFAULT_GROUP_ID, name: 'Default' },
        { id: '', name: 'empty id' },
        { id: 'g2', name: '' },
        { id: 'g3' },
        'junk',
        { id: 'g4', name: 'Ok', extra: true },
      ],
    });
    expect(pw.groups).toEqual([
      { id: 'g1', name: 'Work' },
      { id: 'g4', name: 'Ok' },
    ]);
  });

  it('tolerates garbage input', () => {
    expect(normalizeProjectWorkspace(null)).toEqual({ tabs: [], groups: [], pins: [] });
    expect(normalizeProjectWorkspace({ tabs: 'nope', groups: 'nope' })).toEqual({ tabs: [], groups: [], pins: [] });
  });

  it('fills pins: [] for slots written before the Pinboard existed', () => {
    const pw = normalizeProjectWorkspace({ tabs: [], groups: [] });
    expect(pw.pins).toEqual([]);
  });
});

describe('normalizePins', () => {
  it('keeps notes and complete bookmarks in order, backfilling createdAt', () => {
    const pins = normalizePins([
      { id: 'n1', kind: 'note', text: 'todo', createdAt: 5 },
      { id: 'b1', kind: 'bookmark', text: 'here', sessionKind: 'session', sessionId: 's', anchor: 'u:x' },
    ]);
    expect(pins[0]).toEqual({ id: 'n1', kind: 'note', text: 'todo', createdAt: 5 });
    expect(pins[1]).toMatchObject({ id: 'b1', kind: 'bookmark', sessionKind: 'session', sessionId: 's', anchor: 'u:x' });
    expect(typeof (pins[1] as any).createdAt).toBe('number');
  });

  it('drops malformed, unknown-kind, incomplete-bookmark and duplicate-id pins', () => {
    const pins = normalizePins([
      { id: 'n1', kind: 'note', text: 'a', createdAt: 1 },
      { id: 'n1', kind: 'note', text: 'dup', createdAt: 2 },
      { id: '', kind: 'note', text: 'empty id' },
      { id: 'x', kind: 'note' },
      { id: 'y', kind: 'sticker', text: 'nope' },
      { id: 'b1', kind: 'bookmark', text: 'no anchor', sessionKind: 'session', sessionId: 's' },
      { id: 'b2', kind: 'bookmark', text: 'ok', sessionKind: 'devin', sessionId: 'd', anchor: 'n:1', extra: 1 },
      'junk',
      null,
    ]);
    expect(pins.map((p) => p.id)).toEqual(['n1', 'b2']);
    expect(pins[1]).not.toHaveProperty('extra');
  });

  it('keeps a note\'s tab origin only when it is a complete { type, key }', () => {
    const pins = normalizePins([
      { id: 'n1', kind: 'note', text: 'a', createdAt: 1, tab: { type: 'session', key: 'abc' } },
      { id: 'n2', kind: 'note', text: 'b', createdAt: 1, tab: { type: 'file' } },
      { id: 'n3', kind: 'note', text: 'c', createdAt: 1, tab: 'nope' },
    ]);
    expect(pins[0]).toEqual({ id: 'n1', kind: 'note', text: 'a', createdAt: 1, tab: { type: 'session', key: 'abc' } });
    expect(pins[1]).not.toHaveProperty('tab');
    expect(pins[2]).not.toHaveProperty('tab');
  });

  it('tolerates garbage input', () => {
    expect(normalizePins(undefined)).toEqual([]);
    expect(normalizePins('nope')).toEqual([]);
  });
});
