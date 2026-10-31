import { useEffect, useMemo, useState, type RefObject } from 'react';
import { ElicitationForm } from './ElicitationForm';
import type { ImageAttachment } from './ImageAttachments';
import type { InputLock } from './ChatInput';
import { bindElicitationsToCards, summarizeAnswers, type ElicitationRequest } from '../lib/elicitation';
import type { SendKey } from '../types';

// Model: web.ElicitationForm / web.PendingFormInputLock. Everything a chat
// panel needs to host question forms, shared by ChatPanel (Claude
// AskUserQuestion) and DevinPanel (Devin ask_user_question): the pending /
// answered set, which tool card each form sits under, the chat-input lock,
// the recap once answered, and the image follow-up (rule-318). The panels
// only differ in how a request is parsed (add) and how an answer goes out
// (respond), both of which stay on the panel side.
export type ElicitationEntry = { req: ElicitationRequest; recap?: string };

export function useElicitationHost({ agentName, sendKey, scrollRef, cards, showToast, respond, sendFollowUp }: {
  // Shown in the lock placeholder and the expiry recap ("Claude" / "Devin").
  agentName: string;
  sendKey: SendKey;
  // The scrolling message list — used to reveal the first pending form.
  scrollRef: RefObject<HTMLDivElement | null>;
  // Tool cards in the stream, for bindElicitationsToCards (rule-303).
  cards: ReadonlyArray<{ toolCallId: string; rawInput?: any }>;
  showToast: (text: string) => void;
  // Wire the answer: content on Submit, null on "Reply in chat".
  respond: (req: ElicitationRequest, content: Record<string, string | string[]> | null) => void;
  // Rule-318: images can't ride on the answer, so they go as the next prompt.
  sendFollowUp: (text: string, images: ImageAttachment[]) => void;
}) {
  const [elicitations, setElicitations] = useState<ElicitationEntry[]>([]);
  const pendingCount = useMemo(() => elicitations.filter((e) => !e.recap).length, [elicitations]);

  // Re-attach replays still-pending requests; don't duplicate.
  function add(req: ElicitationRequest) {
    setElicitations((cur) => (cur.some((e) => e.req.id === req.id) ? cur : [...cur, { req }]));
  }
  // Server answered on the user's behalf (elicitation_timeout).
  function expire(id: number | string) {
    setElicitations((cur) => cur.map((e) => (e.req.id === id && !e.recap ? { ...e, recap: `Expired — ${agentName} continued without an answer` } : e)));
    showToast('Question expired');
  }
  function clear() { setElicitations([]); }

  function answer(req: ElicitationRequest, content: Record<string, string | string[]> | null, images: ImageAttachment[] = []) {
    respond(req, content);
    let recap = content ? summarizeAnswers(req, content) || 'Submitted' : 'Not answered — replying in chat';
    if (content && images.length > 0) {
      const n = images.length;
      sendFollowUp(`Attachments for the question form above (${n} image${n === 1 ? '' : 's'}).`, images);
      recap += `\n📎 ${n} image${n === 1 ? '' : 's'} sent as follow-up`;
    }
    setElicitations((cur) => cur.map((e) => (e.req.id === req.id ? { ...e, recap } : e)));
  }

  // Model: web.PendingFormInputLock. Unlock is one-shot: it lasts until the
  // pending set empties, then the next form locks again (rule-310).
  const [inputUnlocked, setInputUnlocked] = useState(false);
  useEffect(() => { if (pendingCount === 0) setInputUnlocked(false); }, [pendingCount]);
  function revealPendingForm() {
    const el = scrollRef.current?.querySelector<HTMLElement>('.elicit-form');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('elicit-attention');
    window.setTimeout(() => el.classList.remove('elicit-attention'), 1500);
  }
  const inputLock: InputLock | null = pendingCount > 0 && !inputUnlocked
    ? { reason: `${agentName} is waiting for your answer above — tap here to show the form`, onUnlock: () => setInputUnlocked(true), onShow: revealPendingForm }
    : null;

  // Which tool card each form/recap sits under (rule-303).
  const cardOf = useMemo(
    () => bindElicitationsToCards(elicitations.map((e) => ({ id: e.req.id, toolCallId: e.req.toolCallId })), cards),
    [elicitations, cards],
  );

  function renderEntry(e: ElicitationEntry) {
    if (e.recap) {
      return (
        <div key={String(e.req.id)} className="elicit-recap">
          <span className="elicit-recap-mark">↳</span>
          <pre className="elicit-recap-text">{e.recap}</pre>
        </div>
      );
    }
    return (
      <ElicitationForm
        key={String(e.req.id)}
        request={e.req}
        agentName={agentName}
        sendKey={sendKey}
        onBlocked={showToast}
        onSubmit={(content, images) => answer(e.req, content, images)}
        onSkip={() => answer(e.req, null)}
      />
    );
  }

  // Forms and recaps bound to this card (rule-304).
  function renderFor(toolCallId: string | undefined) {
    if (!toolCallId) return null;
    return elicitations.filter((e) => cardOf.get(e.req.id) === toolCallId).map(renderEntry);
  }
  // Pending forms whose card isn't in view (e.g. replay skipped it) still need
  // answering; answered recaps are card-only (rule-304).
  function renderOrphans() {
    return elicitations
      .filter((e) => !e.recap && !cardOf.has(e.req.id))
      .map((e) => <div key={String(e.req.id)} className="msg msg-tool msg-elicit-orphan">{renderEntry(e)}</div>);
  }

  return { elicitations, pendingCount, add, expire, clear, inputLock, renderFor, renderOrphans };
}
