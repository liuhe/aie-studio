import { describe, it, expect } from 'vitest';
import type { Batch, Comment } from '../../types';
import {
  addComment,
  batchTargetSession,
  commentMarksFor,
  composeBatchPrompt,
  composeComment,
  deleteComment,
  draftCommentCount,
  editComment,
  markBatchSent,
  newBatch,
  placeComment,
  reopenBatch,
  resolveCurrentBatch,
} from '../review';

const c = (id: string, extra: Partial<Comment> = {}): Comment => ({ id, text: `text ${id}`, createdAt: 1, ...extra });
const b = (id: string, status: Batch['status'], comments: Comment[] = []): Batch => ({
  id, name: id, status, comments, createdAt: 1, ...(status === 'sent' ? { sentAt: 2 } : {}),
});
const ids = (batches: Batch[]) => batches.map((x) => x.comments.map((y) => y.id));

describe('resolveCurrentBatch', () => {
  const batches = [b('a', 'draft'), b('s', 'sent'), b('z', 'draft')];
  it('uses the marked draft', () => expect(resolveCurrentBatch(batches, 'a')?.id).toBe('a'));
  it('falls back to the last draft when the mark is missing, unknown or sent', () => {
    expect(resolveCurrentBatch(batches, null)?.id).toBe('z');
    expect(resolveCurrentBatch(batches, 'nope')?.id).toBe('z');
    expect(resolveCurrentBatch(batches, 's')?.id).toBe('z');
  });
  it('is null without drafts', () => expect(resolveCurrentBatch([b('s', 'sent')], 's')).toBeNull());
});

describe('newBatch', () => {
  it('names by position', () => expect(newBatch([b('a', 'sent')], 'x', 9)).toEqual({ id: 'x', name: 'Batch 2', status: 'draft', comments: [], createdAt: 9 }));
});

describe('comment mutations', () => {
  it('adds only to draft batches', () => {
    const batches = [b('a', 'draft'), b('s', 'sent')];
    expect(ids(addComment(batches, 'a', c('1')))).toEqual([['1'], []]);
    expect(ids(addComment(batches, 's', c('1')))).toEqual([[], []]);
  });
  it('edits with trimmed text, ignoring blank text and sent batches', () => {
    const batches = [b('a', 'draft', [c('1')]), b('s', 'sent', [c('2')])];
    expect(editComment(batches, '1', '  new ')[0].comments[0].text).toBe('new');
    expect(editComment(batches, '1', '   ')).toBe(batches);
    expect(editComment(batches, '2', 'x')[1].comments[0].text).toBe('text 2');
  });
  it('deletes from drafts only', () => {
    const batches = [b('a', 'draft', [c('1'), c('2')]), b('s', 'sent', [c('3')])];
    expect(ids(deleteComment(batches, '1'))).toEqual([['2'], ['3']]);
    expect(ids(deleteComment(batches, '3'))).toEqual([['1', '2'], ['3']]);
  });
});

describe('placeComment', () => {
  const batches = [b('a', 'draft', [c('1'), c('2'), c('3')]), b('z', 'draft', [c('4')]), b('s', 'sent', [c('5')])];
  it('reorders within a batch', () => {
    expect(ids(placeComment(batches, '1', 'a', 2))).toEqual([['2', '3', '1'], ['4'], ['5']]);
    expect(ids(placeComment(batches, '3', 'a', 0))).toEqual([['3', '1', '2'], ['4'], ['5']]);
  });
  it('moves across draft batches, appending by default', () => {
    expect(ids(placeComment(batches, '1', 'z'))).toEqual([['2', '3'], ['4', '1'], ['5']]);
    expect(ids(placeComment(batches, '2', 'z', 0))).toEqual([['1', '3'], ['2', '4'], ['5']]);
  });
  it('returns the same array for no-ops and for sent source / target', () => {
    expect(placeComment(batches, '1', 'a', 0)).toBe(batches);
    expect(placeComment(batches, '1', 's')).toBe(batches);
    expect(placeComment(batches, '5', 'a')).toBe(batches);
    expect(placeComment(batches, 'nope', 'a')).toBe(batches);
  });
});

describe('sent / reopen', () => {
  it('marks a draft sent once and reopens it without sentAt', () => {
    const sent = markBatchSent([b('a', 'draft')], 'a', 42);
    expect(sent[0]).toMatchObject({ status: 'sent', sentAt: 42 });
    expect(markBatchSent(sent, 'a', 99)[0].sentAt).toBe(42);
    const reopened = reopenBatch(sent, 'a');
    expect(reopened[0].status).toBe('draft');
    expect(reopened[0]).not.toHaveProperty('sentAt');
  });
});

describe('composeBatchPrompt', () => {
  it('numbers items, keeps each quote tight to its comment and separates items with ---', () => {
    const batch = b('a', 'draft', [
      c('1', { quote: 'line one\n\nline two', text: 'why?' }),
      c('2', { text: 'also do X' }),
    ]);
    const out = composeBatchPrompt(batch);
    expect(out.startsWith('I have 2 separate review comments')).toBe(true);
    expect(out.endsWith('[1/2]\n> line one\n>\n> line two\nwhy?\n\n---\n\n[2/2]\nalso do X')).toBe(true);
  });
  it('sends a single comment without scaffolding', () => {
    expect(composeBatchPrompt(b('a', 'draft', [c('1', { quote: 'q', text: 'why?' })]))).toBe('> q\nwhy?');
    expect(composeBatchPrompt(b('a', 'draft', [c('1', { text: 'just this' })]))).toBe('just this');
  });
  it('composes a comment sent straight to the input (no Batch)', () => {
    expect(composeComment({ quote: 'a\nb', text: 'why?' })).toBe('> a\n> b\nwhy?');
    expect(composeComment({ text: 'just this' })).toBe('just this');
  });
});

describe('batchTargetSession', () => {
  const s1 = { type: 'session', key: 's1' };
  it('is the single session the comments came from', () => {
    expect(batchTargetSession(b('a', 'draft', [c('1', { tab: s1 }), c('2'), c('3', { tab: { type: 'file', key: 'x' } }), c('4', { tab: s1 })]))).toEqual(s1);
  });
  it('is null with no session or several', () => {
    expect(batchTargetSession(b('a', 'draft', [c('1')]))).toBeNull();
    expect(batchTargetSession(b('a', 'draft', [c('1', { tab: s1 }), c('2', { tab: { type: 'devin', key: 's1' } })]))).toBeNull();
  });
});

describe('derived views', () => {
  const s1 = { type: 'session', key: 's1' };
  const batches = [
    b('a', 'draft', [c('1', { tab: s1, anchor: 'u:1', quote: 'q' }), c('2', { tab: s1 }), c('3', { tab: { type: 'session', key: 'other' }, anchor: 'u:2' })]),
    b('s', 'sent', [c('4', { tab: s1, anchor: 'u:4' })]),
  ];
  it('collects anchored marks for one session across draft and sent batches', () => {
    expect(commentMarksFor(batches, s1)).toEqual([
      { anchor: 'u:1', quote: 'q', id: '1', text: 'text 1', batchName: 'a', sent: false },
      { anchor: 'u:4', quote: undefined, id: '4', text: 'text 4', batchName: 's', sent: true },
    ]);
  });
  it('counts draft comments only', () => expect(draftCommentCount(batches)).toBe(3));
});
