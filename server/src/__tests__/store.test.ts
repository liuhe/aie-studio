import { describe, it, expect } from 'vitest';
import { normalizeProjectWorkspace, normalizeBatches, DEFAULT_GROUP_ID } from '../store.js';

describe('normalizeProjectWorkspace', () => {
  it('fills groups: [] for legacy slots that only have tabs', () => {
    const pw = normalizeProjectWorkspace({ tabs: [{ id: 'a', type: 'file', path: 'x' }], activeTabId: 'a' });
    expect(pw).toEqual({ tabs: [{ id: 'a', type: 'file', path: 'x' }], groups: [], batches: [] });
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
    expect(normalizeProjectWorkspace(null)).toEqual({ tabs: [], groups: [], batches: [] });
    expect(normalizeProjectWorkspace({ tabs: 'nope', groups: 'nope' })).toEqual({ tabs: [], groups: [], batches: [] });
  });

  it('fills batches: [] for slots written before Review existed and drops legacy pins', () => {
    const pw = normalizeProjectWorkspace({ tabs: [], groups: [], pins: [{ id: 'n', kind: 'note', text: 'x' }] });
    expect(pw.batches).toEqual([]);
    expect(pw).not.toHaveProperty('pins');
  });
});

describe('normalizeBatches', () => {
  it('keeps draft / sent batches and their comments in order, backfilling createdAt', () => {
    const batches = normalizeBatches([
      { id: 'b1', name: 'Batch 1', status: 'draft', createdAt: 5, comments: [
        { id: 'c1', text: 'plain', createdAt: 6 },
        { id: 'c2', text: 'quoted', quote: 'some text', tab: { type: 'session', key: 's' }, anchor: 'a:u:0' },
      ] },
      { id: 'b2', name: 'Done', status: 'sent', createdAt: 7, sentAt: 8, comments: [] },
    ]);
    expect(batches[0].comments[0]).toEqual({ id: 'c1', text: 'plain', createdAt: 6 });
    expect(batches[0].comments[1]).toMatchObject({ id: 'c2', quote: 'some text', tab: { type: 'session', key: 's' }, anchor: 'a:u:0' });
    expect(typeof batches[0].comments[1].createdAt).toBe('number');
    expect(batches[1]).toEqual({ id: 'b2', name: 'Done', status: 'sent', createdAt: 7, sentAt: 8, comments: [] });
  });

  it('drops malformed / unknown-status / duplicate batches and malformed / duplicate comments', () => {
    const batches = normalizeBatches([
      { id: 'b1', name: 'A', status: 'draft', createdAt: 1, extra: 1, comments: [
        { id: 'c1', text: 'a', createdAt: 1, extra: 1 },
        { id: 'c1', text: 'dup', createdAt: 1 },
        { id: '', text: 'empty id' },
        { id: 'c2' },
        'junk',
        null,
      ] },
      { id: 'b1', name: 'dup', status: 'draft', comments: [] },
      { id: 'b2', name: 'B', status: 'archived', comments: [] },
      { id: 'b3', status: 'draft', comments: [] },
      { id: 'b4', name: 'C', status: 'draft', comments: [{ id: 'c1', text: 'dup across batches' }, { id: 'c3', text: 'ok' }] },
      'junk',
      null,
    ]);
    expect(batches.map((b) => b.id)).toEqual(['b1', 'b4']);
    expect(batches[0]).not.toHaveProperty('extra');
    expect(batches[0].comments.map((c) => c.id)).toEqual(['c1']);
    expect(batches[0].comments[0]).not.toHaveProperty('extra');
    expect(batches[1].comments.map((c) => c.id)).toEqual(['c3']);
  });

  it('drops invalid optional comment fields but keeps the comment', () => {
    const [b] = normalizeBatches([
      { id: 'b1', name: 'A', status: 'draft', createdAt: 1, sentAt: 9, comments: [
        { id: 'c1', text: 'a', createdAt: 1, quote: 5, tab: { type: 'file' }, anchor: 'u:x' },
        { id: 'c2', text: 'b', createdAt: 1, quote: 'x'.repeat(3000), anchor: 'u:x' },
      ] },
    ]);
    expect(b).not.toHaveProperty('sentAt');
    expect(b.comments[0]).toEqual({ id: 'c1', text: 'a', createdAt: 1 });
    expect(b.comments[1].quote).toHaveLength(2000);
    expect(b.comments[1]).not.toHaveProperty('anchor');
  });

  it('tolerates garbage input', () => {
    expect(normalizeBatches(undefined)).toEqual([]);
    expect(normalizeBatches('nope')).toEqual([]);
    expect(normalizeBatches([{ id: 'b', name: 'n', status: 'draft', comments: 'nope' }])[0].comments).toEqual([]);
  });
});
