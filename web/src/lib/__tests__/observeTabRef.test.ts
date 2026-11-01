import { describe, expect, it } from 'vitest';
import { sameTabRef, tabRef, type Tab } from '../../types';

// Model: web.ObserveTab dedupe — two observe tabs of the same session compare
// equal by origin, and never collide with the session tab they observe.
describe('tabRef for observe tabs', () => {
  it('derives the ref from the origin, not the tab id', () => {
    const a: Tab = { id: '1', type: 'observe', origin: { type: 'session', key: 'abc' } };
    const b: Tab = { id: '2', type: 'observe', origin: { type: 'session', key: 'abc' } };
    const c: Tab = { id: '3', type: 'observe', origin: { type: 'devin', key: 'abc' } };
    expect(sameTabRef(tabRef(a), tabRef(b))).toBe(true);
    expect(sameTabRef(tabRef(a), tabRef(c))).toBe(false);
    expect(tabRef(a)).toEqual({ type: 'observe', key: 'session:abc' });
  });
  it('does not equal the source session tab ref', () => {
    const s: Tab = { id: '9', type: 'session', resumeId: 'abc' };
    const o: Tab = { id: '1', type: 'observe', origin: { type: 'session', key: 'abc' } };
    expect(sameTabRef(tabRef(s), tabRef(o))).toBe(false);
  });
});

import { tabLabel } from '../../components/TabBar';
describe('observe tab label', () => {
  it('never doubles the eye: the icon slot owns it, legacy titles are stripped', () => {
    expect(tabLabel({ id: '1', type: 'observe', origin: { type: 'session', key: 'abcdef1234' }, title: 'Chat 20:29' })).toBe('Chat 20:29');
    expect(tabLabel({ id: '1', type: 'observe', origin: { type: 'session', key: 'abcdef1234' }, title: '👁 Chat 20:29' })).toBe('Chat 20:29');
    expect(tabLabel({ id: '1', type: 'observe', origin: { type: 'session', key: 'abcdef1234' } })).toBe('abcdef12');
  });
  it('marks wire-capture session tabs with ⚡ from Tab.wire, once, and strips the legacy title suffix', () => {
    expect(tabLabel({ id: '1', type: 'session', title: 'Chat 20:29', wire: true })).toBe('Chat 20:29 ⚡');
    expect(tabLabel({ id: '1', type: 'session', resumeId: 'abcdef1234', title: 'Chat 20:29 ⚡', wire: true })).toBe('abcdef12 · Chat 20:29 ⚡');
    expect(tabLabel({ id: '1', type: 'session', title: 'Chat 20:29' })).toBe('Chat 20:29');
    expect(tabLabel({ id: '1', type: 'session', title: 'Chat 20:29 ⚡' })).toBe('Chat 20:29');
  });
});
