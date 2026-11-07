import type { ReactNode } from 'react';
import type { Settings } from '../types';

export type SettingsSectionProps = {
  settings: Settings;
  commit: (next: Settings) => void;
};

// Model: web.SettingsRegistry — which pane of the grouped Settings modal a
// section lands in. Absent = 'features'.
export type SettingsGroupId = 'general' | 'claude' | 'devin' | 'features';

export type SettingsSection = {
  id: string;
  label: string;
  group?: SettingsGroupId;
  // Ascending. Built-in sections use 100, 200, 300... Registered sections can
  // choose their slot (e.g. 150 to appear between Theme and Model).
  order?: number;
  render: (props: SettingsSectionProps) => ReactNode;
};

const sections = new Map<string, SettingsSection>();

export function registerSettingsSection(s: SettingsSection) {
  sections.set(s.id, s);
}

export function listSettingsSections(): SettingsSection[] {
  return [...sections.values()].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000));
}

export function sectionsForGroup(group: SettingsGroupId): SettingsSection[] {
  return listSettingsSections().filter((s) => (s.group ?? 'features') === group);
}
