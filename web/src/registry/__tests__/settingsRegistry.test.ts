import { describe, expect, it } from 'vitest';
import { listSettingsSections, registerSettingsSection, sectionsForGroup } from '../settingsRegistry';

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

// Model: web.SettingsRegistry — group placement in the tabbed Settings modal.
describe('sectionsForGroup', () => {
  it('defaults ungrouped sections to features and keeps order within a group', () => {
    registerSettingsSection({ id: 'g-feat', label: 'F', order: 50, render: () => null });
    registerSettingsSection({ id: 'g-claude2', label: 'C2', order: 20, group: 'claude', render: () => null });
    registerSettingsSection({ id: 'g-claude1', label: 'C1', order: 10, group: 'claude', render: () => null });
    expect(sectionsForGroup('claude').map((s) => s.id)).toEqual(['g-claude1', 'g-claude2']);
    expect(sectionsForGroup('features').map((s) => s.id)).toContain('g-feat');
    expect(sectionsForGroup('devin').map((s) => s.id)).not.toContain('g-feat');
  });
});
