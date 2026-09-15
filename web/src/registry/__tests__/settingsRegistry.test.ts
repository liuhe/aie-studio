import { describe, expect, it } from 'vitest';
import { listSettingsSections, registerSettingsSection } from '../settingsRegistry';

describe('settingsRegistry', () => {
  it('registers and orders sections ascending', () => {
    registerSettingsSection({ id: 'a', label: 'A', order: 300, render: () => null });
    registerSettingsSection({ id: 'b', label: 'B', order: 100, render: () => null });
    registerSettingsSection({ id: 'c', label: 'C', order: 200, render: () => null });
    const ids = listSettingsSections().map((s) => s.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('re-registering same id overwrites in place', () => {
    registerSettingsSection({ id: 'dup', label: 'v1', render: () => null });
    registerSettingsSection({ id: 'dup', label: 'v2', render: () => null });
    const dup = listSettingsSections().filter((s) => s.id === 'dup');
    expect(dup.length).toBe(1);
    expect(dup[0].label).toBe('v2');
  });
});
