import { describe, expect, it } from 'vitest';
import { isSendKeyTrigger } from '../sendKey';

const k = (o: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }>) =>
  ({ key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, ...o });

describe('isSendKeyTrigger', () => {
  it('enter mode: plain Enter only', () => {
    expect(isSendKeyTrigger('enter', k({}))).toBe(true);
    expect(isSendKeyTrigger('enter', k({ shiftKey: true }))).toBe(false);
    expect(isSendKeyTrigger('enter', k({ metaKey: true }))).toBe(false);
  });
  it('cmd-enter mode: meta or ctrl, no shift', () => {
    expect(isSendKeyTrigger('cmd-enter', k({ metaKey: true }))).toBe(true);
    expect(isSendKeyTrigger('cmd-enter', k({ ctrlKey: true }))).toBe(true);
    expect(isSendKeyTrigger('cmd-enter', k({}))).toBe(false);
    expect(isSendKeyTrigger('cmd-enter', k({ metaKey: true, shiftKey: true }))).toBe(false);
  });
  it('shift-enter mode', () => {
    expect(isSendKeyTrigger('shift-enter', k({ shiftKey: true }))).toBe(true);
    expect(isSendKeyTrigger('shift-enter', k({ shiftKey: true, ctrlKey: true }))).toBe(false);
  });
  it('ignores IME composition and other keys', () => {
    expect(isSendKeyTrigger('enter', k({ isComposing: true }))).toBe(false);
    expect(isSendKeyTrigger('enter', k({ key: 'a' }))).toBe(false);
  });
});
