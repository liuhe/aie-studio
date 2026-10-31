import type { SendKey } from '../types';

// Model: web.SendPrompt rule-090 / web.ElicitationForm — the one place that
// decides whether a keydown is the user's configured "send" chord. Shared by
// ChatInput and the ask_user_question Other box.
export type KeyLike = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean };

export function isSendKeyTrigger(sendKey: SendKey, e: KeyLike): boolean {
  if (e.isComposing) return false;
  if (e.key !== 'Enter') return false;
  const mod = e.metaKey || e.ctrlKey;
  return (
    (sendKey === 'enter' && !e.shiftKey && !mod) ||
    (sendKey === 'cmd-enter' && mod && !e.shiftKey) ||
    (sendKey === 'shift-enter' && e.shiftKey && !mod)
  );
}
