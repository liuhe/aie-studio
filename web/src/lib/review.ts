import type { Batch, Comment, TabRef } from '../types';

// Pure Review logic (model: entity Batch / Comment). App owns the state and
// persistence; everything here maps batches[] → batches[] or derives from it.

export const MAX_QUOTE_LENGTH = 2000;

export function clampQuote(quote: string): string {
  return quote.length > MAX_QUOTE_LENGTH ? quote.slice(0, MAX_QUOTE_LENGTH) : quote;
}

// Model: web.SetCurrentBatch — the marked batch if it is still a draft, else
// the last draft, else null (caller auto-creates one).
export function resolveCurrentBatch(batches: Batch[], markedId: string | null | undefined): Batch | null {
  const marked = markedId ? batches.find((b) => b.id === markedId && b.status === 'draft') : undefined;
  if (marked) return marked;
  for (let i = batches.length - 1; i >= 0; i--) if (batches[i].status === 'draft') return batches[i];
  return null;
}

export function newBatch(batches: Batch[], id: string, now: number): Batch {
  return { id, name: `Batch ${batches.length + 1}`, status: 'draft', comments: [], createdAt: now };
}

function mapDraft(batches: Batch[], batchId: string, fn: (b: Batch) => Batch): Batch[] {
  return batches.map((b) => (b.id === batchId && b.status === 'draft' ? fn(b) : b));
}

export function addComment(batches: Batch[], batchId: string, comment: Comment): Batch[] {
  return mapDraft(batches, batchId, (b) => ({ ...b, comments: [...b.comments, comment] }));
}

export function findComment(batches: Batch[], commentId: string): { batch: Batch; comment: Comment } | null {
  for (const batch of batches) {
    const comment = batch.comments.find((c) => c.id === commentId);
    if (comment) return { batch, comment };
  }
  return null;
}

export function editComment(batches: Batch[], commentId: string, text: string): Batch[] {
  const hit = findComment(batches, commentId);
  const trimmed = text.trim();
  if (!hit || !trimmed) return batches;
  return mapDraft(batches, hit.batch.id, (b) => ({
    ...b,
    comments: b.comments.map((c) => (c.id === commentId ? { ...c, text: trimmed } : c)),
  }));
}

export function deleteComment(batches: Batch[], commentId: string): Batch[] {
  const hit = findComment(batches, commentId);
  if (!hit) return batches;
  return mapDraft(batches, hit.batch.id, (b) => ({ ...b, comments: b.comments.filter((c) => c.id !== commentId) }));
}

// Model: web.ReorderComments / web.MoveComment. Place the comment in
// `toBatchId` at `index` (counted after removing it from its source; omitted
// = append). Source and target must both be drafts. Returns the same array
// when nothing would change.
export function placeComment(batches: Batch[], commentId: string, toBatchId: string, index?: number): Batch[] {
  const hit = findComment(batches, commentId);
  const target = batches.find((b) => b.id === toBatchId);
  if (!hit || !target || hit.batch.status !== 'draft' || target.status !== 'draft') return batches;
  const next = batches.map((b) => {
    if (b.id !== hit.batch.id && b.id !== toBatchId) return b;
    let comments = b.id === hit.batch.id ? b.comments.filter((c) => c.id !== commentId) : b.comments;
    if (b.id === toBatchId) {
      const at = index == null ? comments.length : Math.max(0, Math.min(index, comments.length));
      comments = [...comments.slice(0, at), hit.comment, ...comments.slice(at)];
    }
    return { ...b, comments };
  });
  const before = batches.map((b) => b.comments.map((c) => c.id).join(',')).join('|');
  const after = next.map((b) => b.comments.map((c) => c.id).join(',')).join('|');
  return before === after ? batches : next;
}

export function markBatchSent(batches: Batch[], batchId: string, now: number): Batch[] {
  return mapDraft(batches, batchId, (b) => ({ ...b, status: 'sent', sentAt: now }));
}

export function reopenBatch(batches: Batch[], batchId: string): Batch[] {
  return batches.map((b) => {
    if (b.id !== batchId || b.status !== 'sent') return b;
    const { sentAt: _sentAt, ...rest } = b;
    return { ...rest, status: 'draft' };
  });
}

// Model: entity Batch — one prompt for the whole batch, shaped so the AI
// can't misread item boundaries or which quote a comment belongs to: an
// intro line, then numbered items ([i/N] → blockquote → comment, kept tight)
// separated by `---`. A single comment needs none of that scaffolding.
// Also the whole text of a comment sent straight to the input box (model:
// web.SendCommentToPrompt).
export function composeComment(c: { text: string; quote?: string }): string {
  if (!c.quote) return c.text;
  const quoted = c.quote.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  return `${quoted}\n${c.text}`;
}
export function composeBatchPrompt(batch: Batch): string {
  const n = batch.comments.length;
  if (n <= 1) return batch.comments.map(composeComment).join('');
  const intro = `I have ${n} separate review comments, numbered below. A quoted block (>) is a passage from your earlier output; the text right under it is my comment on that passage. Items without a quote are general comments. Please address each one.`;
  const items = batch.comments.map((c, i) => `[${i + 1}/${n}]\n${composeComment(c)}`);
  return `${intro}\n\n${items.join('\n\n---\n\n')}`;
}

function isSessionRef(ref: TabRef | undefined): ref is TabRef {
  return !!ref && (ref.type === 'session' || ref.type === 'devin');
}

// Model: entity Batch — the session a batch should be sent to: the one
// session its comments came from, or null when there is none / more than one
// (caller falls back to the active session tab).
export function batchTargetSession(batch: Batch): TabRef | null {
  let found: TabRef | null = null;
  for (const c of batch.comments) {
    if (!isSessionRef(c.tab)) continue;
    if (found && (found.type !== c.tab.type || found.key !== c.tab.key)) return null;
    found = c.tab;
  }
  return found;
}

// Model: web.HighlightQuotes — what a session panel needs to mark its
// commented messages: every anchored comment (draft or sent) from that session.
// id / text / batchName / sent let the panel show the comment when its painted
// quote is clicked (model: web.ViewQuoteComments).
export type CommentMark = { anchor: string; quote?: string; id: string; text: string; batchName: string; sent: boolean };
export function commentMarksFor(batches: Batch[], ref: TabRef): CommentMark[] {
  const out: CommentMark[] = [];
  for (const b of batches) {
    for (const c of b.comments) {
      if (c.anchor && c.tab && c.tab.type === ref.type && c.tab.key === ref.key) out.push({ anchor: c.anchor, quote: c.quote, id: c.id, text: c.text, batchName: b.name, sent: b.status === 'sent' });
    }
  }
  return out;
}

export function draftCommentCount(batches: Batch[]): number {
  return batches.reduce((n, b) => (b.status === 'draft' ? n + b.comments.length : n), 0);
}
