import { describe, expect, it } from 'vitest';
import { getTabKind, listTabKinds, registerTabKind } from '../tabRegistry';
// Side-effect import: registers built-in kinds so the test asserts the wiring
// path App.tsx actually uses.
import '../builtinTabKinds';

describe('tabRegistry', () => {
  it('registers built-in kinds via the barrel side effect', () => {
    for (const id of ['file', 'session', 'devin']) {
      expect(getTabKind(id), `built-in kind "${id}" missing`).toBeDefined();
    }
  });

  it('accepts new registrations without touching existing ones', () => {
    const before = listTabKinds().length;
    registerTabKind({
      id: 'test-kind',
      label: 'Test',
      render: () => null,
    });
    expect(getTabKind('test-kind')?.label).toBe('Test');
    expect(listTabKinds().length).toBe(before + 1);
  });

  it('keeps the singleton flag on registered kinds', () => {
    registerTabKind({ id: 'single-kind', label: 'Single', singleton: true, render: () => null });
    expect(getTabKind('single-kind')?.singleton).toBe(true);
    expect(getTabKind('test-kind')?.singleton).toBeUndefined();
  });

  it('returns undefined for unknown kinds', () => {
    expect(getTabKind('no-such-kind')).toBeUndefined();
  });
});
