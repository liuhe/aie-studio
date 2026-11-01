// Auto-load every *.panel.tsx in this directory for side-effect registration.
// Kept separate from `../registry/index.ts` to avoid a registry ↔ panel import
// cycle (panels import from '../registry'; the barrel must not import them
// back or Rollup's evaluation order puts panel `registerTabKind(...)` calls
// before the registry Map declaration is initialized → TDZ at runtime).
const panelModules = import.meta.glob('./*.panel.tsx', { eager: true });
void panelModules;
