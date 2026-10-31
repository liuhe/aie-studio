import { useRef, useState } from 'react';
import {
  appendAttachmentHint, buildContent, canSubmit, emptyAnswers, toggleOption, toggleOther, toggleSkip, unansweredRequired,
  type ElicitationAnswer, type ElicitationQuestion, type ElicitationRequest,
} from '../lib/elicitation';
import { imageFilesFromClipboard } from '../lib/imageAttachments';
import { isSendKeyTrigger } from '../lib/sendKey';
import type { SendKey } from '../types';
import { AttachImagesButton, ImageAttachmentStrip, useImageAttachments, type ImageAttachment } from './ImageAttachments';

// Inline question form (model: web.ElicitationForm). Rendered in the chat
// stream at the tool card it belongs to — Claude's AskUserQuestion and Devin's
// ask_user_question both land here via useElicitationHost. Every question
// lists its options as toggle buttons plus a trailing "Other" that opens a
// free-text box, and a per-question Skip. Submit answers accept; "Reply in
// chat" declines, which the agent reads as "the user wants to clarify in
// conversation".
export function ElicitationForm({ request, agentName, sendKey, onSubmit, onSkip, onBlocked }: {
  request: ElicitationRequest;
  // For button hints ("Devin will ask what you'd like to clarify").
  agentName: string;
  // Same send chord as the chat input (rule-319); pressed in the Other box.
  sendKey: SendKey;
  // Model: web.ElicitationForm rule-318 — images can't ride in the ACP reply;
  // the panel sends them as a follow-up prompt right after the accept.
  onSubmit: (content: Record<string, string | string[]>, images: ImageAttachment[]) => void;
  onSkip: () => void;
  // Send chord pressed while required questions are still open — host toasts.
  onBlocked: (message: string) => void;
}) {
  const [answers, setAnswers] = useState(() => emptyAnswers(request));
  const patch = (key: string, next: ElicitationAnswer) => setAnswers((prev) => ({ ...prev, [key]: next }));
  const ready = canSubmit(request, answers);
  const attachments = useImageAttachments();

  function submit() {
    const withHint = attachments.images.length ? appendAttachmentHint(request, answers) : answers;
    onSubmit(buildContent(request, withHint), attachments.images);
  }
  // Send chord from the Other box (rule-319): submit if possible, else explain.
  function submitFromKey() {
    if (ready) { submit(); return; }
    const n = unansweredRequired(request, answers);
    onBlocked(`${n} question${n === 1 ? '' : 's'} still unanswered`);
  }

  return (
    <div className="elicit-form" onClick={(e) => e.stopPropagation()}>
      {request.questions.map((q) => (
        <QuestionBlock
          key={q.key}
          q={q}
          a={answers[q.key]}
          allowOther={request.allowOther}
          onChange={(next) => patch(q.key, next)}
          onPasteFiles={attachments.addFiles}
          sendKey={sendKey}
          onSubmitKey={submitFromKey}
        />
      ))}
      <ImageAttachmentStrip images={attachments.images} onRemove={attachments.remove} className="chat-pending-images elicit-attachments" />
      <div className="elicit-actions">
        <AttachImagesButton onFiles={attachments.addFiles} className="elicit-attach" title="Attach image — sent as the next message after your answer" />
        <button className="elicit-skip" onClick={onSkip} title={`Don't answer the form — ${agentName} will ask what you'd like to clarify`}>Reply in chat</button>
        <button className="elicit-submit" disabled={!ready} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  );
}

function QuestionBlock({ q, a, allowOther, onChange, onPasteFiles, sendKey, onSubmitKey }: {
  q: ElicitationQuestion;
  a: ElicitationAnswer;
  allowOther: boolean;
  onPasteFiles: (files: File[]) => void;
  sendKey: SendKey;
  onSubmitKey: () => void;
  onChange: (next: ElicitationAnswer) => void;
}) {
  const otherOpen = a.other !== null;
  // Free-text-only questions (no options) have no toggle; the box is always open.
  const showOtherToggle = q.options.length > 0 && allowOther;
  return (
    <div className="elicit-q">
      <div className="elicit-q-head">
        <span className="elicit-q-header">{q.header}</span>
        {q.multi && <span className="elicit-q-hint">select all that apply</span>}
        <button
          type="button"
          className={`elicit-q-skip${a.skipped ? ' on' : ''}`}
          aria-pressed={a.skipped}
          onClick={() => onChange(toggleSkip(q, a))}
          title={a.skipped ? 'Answer this question after all' : 'Leave this question unanswered'}
        >
          {a.skipped ? 'Skipped · undo' : 'Skip'}
        </button>
      </div>
      {q.question && q.question !== q.header && <div className="elicit-q-text">{q.question}</div>}
      <div className={`elicit-options${a.skipped ? ' skipped' : ''}`}>
        {q.options.map((o) => {
          const on = a.selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className={`elicit-option${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange(toggleOption(q, a, o.value))}
            >
              <span className="elicit-option-mark">{q.multi ? (on ? '☑' : '☐') : (on ? '◉' : '○')}</span>
              <span className="elicit-option-body">
                <span className="elicit-option-label">{o.value}</span>
                {o.description && <span className="elicit-option-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
        {showOtherToggle && (
          <button
            type="button"
            className={`elicit-option elicit-option-other${otherOpen ? ' on' : ''}`}
            aria-pressed={otherOpen}
            onClick={() => onChange(toggleOther(q, a))}
          >
            <span className="elicit-option-mark">{q.multi ? (otherOpen ? '☑' : '☐') : (otherOpen ? '◉' : '○')}</span>
            <span className="elicit-option-body">
              <span className="elicit-option-label">Other</span>
              <span className="elicit-option-desc">type your own</span>
            </span>
          </button>
        )}
      </div>
      {otherOpen && (
        <OtherTextarea value={a.other ?? ''} onChange={(text) => onChange({ ...a, other: text })} onPasteFiles={onPasteFiles} sendKey={sendKey} onSubmitKey={onSubmitKey} />
      )}
    </div>
  );
}

// Multi-line free text that grows with its content and can also be dragged
// taller/shorter via the native vertical resize handle. Auto-grow only ever
// expands, so a manual drag is never undone by the next keystroke.
function OtherTextarea({ value, onChange, onPasteFiles, sendKey, onSubmitKey }: {
  value: string;
  onChange: (v: string) => void;
  onPasteFiles: (files: File[]) => void;
  sendKey: SendKey;
  onSubmitKey: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = () => {
    const ta = ref.current;
    if (ta && ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  return (
    <textarea
      ref={ref}
      className="elicit-other"
      placeholder="Type your answer…"
      rows={4}
      autoFocus
      value={value}
      onChange={(e) => { onChange(e.target.value); grow(); }}
      onInput={grow}
      onPaste={(e) => {
        const files = imageFilesFromClipboard(e.clipboardData?.items);
        if (files.length) { e.preventDefault(); onPasteFiles(files); }
      }}
      onKeyDown={(e) => {
        if (isSendKeyTrigger(sendKey, { ...e, isComposing: e.nativeEvent.isComposing })) { e.preventDefault(); onSubmitKey(); }
      }}
    />
  );
}
