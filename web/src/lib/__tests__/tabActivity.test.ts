import { describe, expect, it } from 'vitest';
import { activityMark, groupActivityMark, sameActivity } from '../tabActivity';

const gid = (t: { groupId?: string }) => t.groupId ?? 'default';

describe('activityMark', () => {
  it('returns null for no activity', () => {
    expect(activityMark(undefined)).toBeNull();
    expect(activityMark({ generating: false, awaitingInput: false })).toBeNull();
  });
  it('awaiting outranks generating', () => {
    expect(activityMark({ generating: true, awaitingInput: true })).toBe('awaiting');
    expect(activityMark({ generating: true, awaitingInput: false })).toBe('generating');
    expect(activityMark({ generating: false, awaitingInput: true })).toBe('awaiting');
  });
});

describe('groupActivityMark', () => {
  const tabs = [
    { id: 'a', groupId: 'g1' },
    { id: 'b', groupId: 'g1' },
    { id: 'c' }, // default group
  ];
  it('ignores tabs of other groups', () => {
    const act = { c: { generating: true, awaitingInput: true } };
    expect(groupActivityMark(tabs, act, 'g1', gid)).toBeNull();
    expect(groupActivityMark(tabs, act, 'default', gid)).toBe('awaiting');
  });
  it('any awaiting tab wins over generating siblings', () => {
    const act = { a: { generating: true, awaitingInput: false }, b: { generating: false, awaitingInput: true } };
    expect(groupActivityMark(tabs, act, 'g1', gid)).toBe('awaiting');
  });
  it('generating when no tab awaits', () => {
    const act = { a: { generating: true, awaitingInput: false } };
    expect(groupActivityMark(tabs, act, 'g1', gid)).toBe('generating');
  });
  it('unmounted tabs (no entry) contribute nothing', () => {
    expect(groupActivityMark(tabs, {}, 'g1', gid)).toBeNull();
  });
});

describe('sameActivity', () => {
  it('compares both flags', () => {
    expect(sameActivity(undefined, { generating: true, awaitingInput: false })).toBe(false);
    expect(sameActivity({ generating: true, awaitingInput: false }, { generating: true, awaitingInput: false })).toBe(true);
    expect(sameActivity({ generating: true, awaitingInput: false }, { generating: true, awaitingInput: true })).toBe(false);
  });
});
