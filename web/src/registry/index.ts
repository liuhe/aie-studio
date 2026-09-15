// Central registry entry. Importing this module registers built-in tab kinds
// as a side effect; App.tsx imports it once at startup. Extension modules can
// import the individual registerTabKind / registerSettingsSection APIs and
// register additional kinds/sections without touching App.tsx.
//
// The auto-loader for src/panels/*.panel.tsx lives in `../panels/index.ts` on
// purpose: putting the eager glob here would form a cycle with any panel that
// imports from this barrel (registry → panel → registry), which Rollup
// resolves with a module-eval order that hits TDZ on the registry Map.
import './builtinTabKinds';

export {
  registerTabKind,
  getTabKind,
  listTabKinds,
  type TabKind,
  type TabRenderContext,
  type ExportApi,
  type MessageLocator,
} from './tabRegistry';

export {
  registerSettingsSection,
  listSettingsSections,
  type SettingsSection,
  type SettingsSectionProps,
} from './settingsRegistry';
