import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Settings, SendKey, Theme, FontScale, LocalPrefs } from '../types';
import { usePwaInstall } from '../usePwaInstall';
import { sectionsForGroup, type SettingsGroupId } from '../registry';
import { useClaudeModels, EFFORT_LEVELS } from '../useClaudeModels';
import { listDevinVersions, type DevinVersion } from '../api';

type SelectOption = { value: string; label: string; hint?: string; group?: string };

const SEND_KEY_OPTIONS: SelectOption[] = [
  { value: 'cmd-enter', label: 'Cmd/Ctrl + Enter', hint: 'Enter inserts newline; ⌘/Ctrl + Enter sends' },
  { value: 'shift-enter', label: 'Shift + Enter', hint: 'Enter inserts newline; Shift + Enter sends' },
  { value: 'enter', label: 'Enter', hint: 'Enter sends; Shift + Enter inserts newline' },
];

const THEME_OPTIONS: SelectOption[] = [
  { value: 'dark', label: 'Dark', hint: 'VSCode-like dark palette (default)' },
  { value: 'light', label: 'Light', hint: 'Clean light palette' },
  { value: 'dim', label: 'Dim', hint: 'Softer dark (GitHub Dim-ish)' },
];

// Claude model list is loaded dynamically from /api/models (Anthropic's signed
// catalog filtered by local CLI version) — see useClaudeModels.
const DEFAULT_MODEL_OPTION: SelectOption = { value: '', label: 'Default', hint: 'Whatever claude CLI picks' };

const EFFORT_HINTS: Record<string, string> = {
  low: 'Fastest, least thinking',
  medium: 'Balanced',
  high: 'Most models default here',
  xhigh: 'Claude 5 family and Opus 4.7/4.8 only',
  max: 'Slowest, deepest reasoning',
};
const EFFORT_OPTIONS: SelectOption[] = [
  { value: '', label: 'Default', hint: "claude's per-model default" },
  ...EFFORT_LEVELS.map((lvl) => ({ value: lvl, label: lvl, hint: EFFORT_HINTS[lvl] })),
];

// Devin exposes ~75 model IDs via ACP; this curated set covers the practical
// picks. Empty value defers to Devin's own default (swe-1-6-fast at the time
// of writing). Mid-session switching is available via the model picker.
const DEVIN_MODEL_OPTIONS: SelectOption[] = [
  { value: '', label: 'Default', hint: "Whatever Devin picks" },
  { value: 'claude-opus-4-7-medium', label: 'Claude Opus 4.7 · Medium', hint: 'Balanced reasoning' },
  { value: 'claude-opus-4-7-high', label: 'Claude Opus 4.7 · High', hint: 'More reasoning, slower' },
  { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking', hint: 'Previous flagship + thinking' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Faster, less expensive' },
  { value: 'claude-sonnet-4-6-thinking', label: 'Claude Sonnet 4.6 Thinking', hint: 'Sonnet + thinking' },
  { value: 'gpt-5-5-medium', label: 'GPT-5.5 · Medium', hint: 'OpenAI mid tier' },
  { value: 'gpt-5-5-high', label: 'GPT-5.5 · High', hint: 'OpenAI high tier' },
  { value: 'gemini-3-1-pro-high', label: 'Gemini 3.1 Pro · High', hint: 'Google high tier' },
  { value: 'adaptive', label: 'Adaptive', hint: 'Devin auto-balances quality/cost' },
];

// Devin ACP mode ids (see DevinPanel MODE_ICON). '' = Devin's own default.
const DEVIN_MODE_OPTIONS: SelectOption[] = [
  { value: '', label: 'Default', hint: 'Whatever Devin picks (Code)' },
  { value: 'bypass', label: '🛡️ Bypass', hint: 'Auto-approve every tool call' },
  { value: 'accept-edits', label: '💻 Code', hint: "Devin's default: auto-approve file edits, ask for the rest" },
  { value: 'ask', label: '💬 Ask', hint: 'Confirm each tool call' },
  { value: 'plan', label: '📋 Plan', hint: 'Plan first, no edits' },
];

const FONT_SCALE_OPTIONS: SelectOption[] = [
  { value: 'small', label: 'Small', hint: 'Compact — more content per screen' },
  { value: 'normal', label: 'Normal', hint: 'Default reading size' },
  { value: 'large', label: 'Large', hint: '1.18×' },
  { value: 'xlarge', label: 'Extra Large', hint: '1.35×' },
  { value: 'huge', label: 'Huge', hint: '1.65×' },
  { value: 'xhuge', label: 'Extra Huge', hint: '2.0× — accessibility / projection' },
];

// Model: web.Settings rule-431 / page SettingsPane — one pane at a time.
const GROUPS: { id: SettingsGroupId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'claude', label: 'Claude' },
  { id: 'devin', label: 'Devin' },
  { id: 'features', label: 'Features' },
];

// Installed devin CLI versions (model: server.ListDevinVersions). '' = auto.
// Model: web entity Settings.claudeBridge — which Claude tab kind the ⋮ menu opens.
const CLAUDE_BRIDGE_OPTIONS: SelectOption[] = [
  { value: 'sdk', label: 'Agent SDK (default)', hint: 'New / Resume open claude-sdk tabs: AI-generated session titles, ✎ rename, same transcripts as the classic bridge.' },
  { value: 'cli', label: 'Classic (claude -p subprocess)', hint: 'New / Resume open the original session tabs driven by the hand-rolled stream-json bridge.' },
];

// A saved version that is no longer installed stays selectable so the user can
// see it, but the server treats it as auto.
function devinVersionOptions(versions: DevinVersion[] | null, selected: string): SelectOption[] {
  const newest = versions?.[0]?.version;
  const opts: SelectOption[] = [{
    value: '',
    label: 'Auto (newest installed)',
    hint: newest ? `Currently resolves to ${newest}` : "Follows the CLI's own `current` link",
  }];
  for (const v of versions ?? []) {
    opts.push({ value: v.version, label: v.current ? `${v.version} (current)` : v.version, hint: 'Pinned until you change it' });
  }
  if (selected && !opts.some((o) => o.value === selected)) {
    opts.push({ value: selected, label: `${selected} (not installed)`, hint: 'Not found on this machine — Auto is used instead' });
  }
  return opts;
}

// One compact row per setting: label, <select>, and the hint for whichever
// option is currently chosen. Options with a `group` render inside an
// <optgroup>; ungrouped ones come first.
export function SettingsSelect({
  label,
  name,
  value,
  options,
  onChange,
  showId,
  footer,
}: {
  label: string;
  name: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  showId?: boolean;
  footer?: ReactNode;
}) {
  const id = `settings-${name}`;
  const current = options.find((o) => o.value === value);
  const ungrouped = options.filter((o) => !o.group);
  const groups: { label: string; options: SelectOption[] }[] = [];
  for (const o of options) {
    if (!o.group) continue;
    let g = groups.find((x) => x.label === o.group);
    if (!g) { g = { label: o.group, options: [] }; groups.push(g); }
    g.options.push(o);
  }
  const renderOption = (o: SelectOption) => (
    <option key={o.value || '__default'} value={o.value}>{o.label}</option>
  );
  return (
    <div className="settings-section">
      <label className="settings-label" htmlFor={id}>{label}</label>
      <select id={id} className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {ungrouped.map(renderOption)}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>{g.options.map(renderOption)}</optgroup>
        ))}
      </select>
      {(current?.hint || (showId && value)) && (
        <div className="settings-option-hint">
          {current?.hint}
          {showId && value && <code className="settings-mono">{value}</code>}
        </div>
      )}
      {footer}
    </div>
  );
}

// One checkbox row (label + text + hint); shared by the on/off settings.
function Toggle({ label, checked, onChange, text, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; text: string; hint: string;
}) {
  return (
    <div className="settings-section">
      <div className="settings-label">{label}</div>
      <label className="settings-option">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <div className="settings-option-text">
          <div>{text}</div>
          <div className="settings-option-hint">{hint}</div>
        </div>
      </label>
    </div>
  );
}

export function Settings({
  settings,
  local,
  onLocalChange,
  username,
  onChange,
  onClose,
  onSignOut,
}: {
  settings: Settings;
  // Device-local prefs (localStorage; model: web entity Settings
  // claudeBridge / showWireMenu). Changes apply immediately, no server round trip.
  local: LocalPrefs;
  onLocalChange: (next: LocalPrefs) => void;
  username?: string;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  // Auto-saved indicator. Settings persist on every change; we flash a
  // "Saved" badge so the user has feedback (no explicit Save button means
  // people often wonder if their click took effect).
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<number | null>(null);
  const [group, setGroup] = useState<SettingsGroupId>('general');
  const pwa = usePwaInstall();
  const [devinVersions, setDevinVersions] = useState<DevinVersion[] | null>(null);
  useEffect(() => {
    let alive = true;
    listDevinVersions().then((r) => { if (alive) setDevinVersions(r.versions); }).catch(() => { if (alive) setDevinVersions([]); });
    return () => { alive = false; };
  }, []);
  const modelCatalog = useClaudeModels();
  function flashSaved() {
    setSavedFlash(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200);
  }
  function commit(next: Settings) {
    onChange(next);
    flashSaved();
  }

  const modelOptions: SelectOption[] = [
    DEFAULT_MODEL_OPTION,
    ...modelCatalog.aliases.map((a) => ({
      value: a.id, label: a.name, hint: a.description || 'Alias — auto-upgrade on new releases', group: 'Aliases (auto-latest)',
    })),
    ...modelCatalog.models.map((m) => ({
      value: m.id, label: m.name, hint: m.description || '', group: m.section === 'main' ? 'Latest' : 'Previous',
    })),
  ];

  const registered = sectionsForGroup(group).map((section) => (
    <div key={section.id} className="settings-section">
      <div className="settings-label">{section.label}</div>
      {section.render({ settings, commit })}
    </div>
  ));

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <span className="settings-saved-flash" data-on={savedFlash ? '1' : '0'}>Saved ✓</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-tabs" role="tablist">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={group === g.id}
              className={`settings-tab ${group === g.id ? 'active' : ''}`}
              onClick={() => setGroup(g.id)}
            >{g.label}</button>
          ))}
        </div>
        <div className="settings-body">
          {group === 'general' && (
            <>
              <SettingsSelect
                label="Theme"
                name="theme"
                value={settings.theme}
                options={THEME_OPTIONS}
                onChange={(v) => commit({ ...settings, theme: v as Theme })}
              />
              <SettingsSelect
                label="Font size"
                name="fontScale"
                value={settings.fontScale}
                options={FONT_SCALE_OPTIONS}
                onChange={(v) => commit({ ...settings, fontScale: v as FontScale })}
              />
              <SettingsSelect
                label="Send message with"
                name="sendKey"
                value={settings.sendKey}
                options={SEND_KEY_OPTIONS}
                onChange={(v) => commit({ ...settings, sendKey: v as SendKey })}
              />
              <div className="settings-section">
                <div className="settings-label">Install as app</div>
                {pwa.isInstalled ? (
                  <div className="settings-option-hint">Already installed on this device.</div>
                ) : pwa.canInstall ? (
                  <div className="settings-account-row">
                    <div className="settings-option-text">
                      <div>Pin AI Studio to your home screen / launcher.</div>
                      <div className="settings-option-hint">Standalone window, no browser chrome.</div>
                    </div>
                    <button className="settings-signout" onClick={() => pwa.install()}>Install app</button>
                  </div>
                ) : (
                  <div className="settings-option-hint">
                    Browser hasn't offered installation yet — interact with the app for a bit then reopen Settings, or use the browser menu (Chrome: ⋮ → Install / Add to Home Screen; iOS Safari: Share → Add to Home Screen).
                  </div>
                )}
              </div>
              {username && (
                <div className="settings-section">
                  <div className="settings-label">Account</div>
                  <div className="settings-account-row">
                    <div className="settings-option-text">
                      <div>Signed in as <code className="settings-mono">{username}</code></div>
                    </div>
                    <button className="settings-signout" onClick={onSignOut}>Sign out</button>
                  </div>
                </div>
              )}
              {registered}
            </>
          )}

          {group === 'claude' && (
            <>
              <Toggle
                label="Claude (this device)"
                checked={local.enableClaude}
                onChange={(v) => { onLocalChange({ ...local, enableClaude: v }); flashSaved(); }}
                text="Enable Claude on this device"
                hint='Off hides "New / Resume Claude session" in the tab menu. Open Claude tabs and everything else keep working.'
              />
              <SettingsSelect
                label="Default Claude model (new sessions)"
                name="model"
                value={settings.model ?? ''}
                options={modelOptions}
                showId
                onChange={(v) => commit({ ...settings, model: v })}
                footer={
                  <>
                    {modelCatalog.error && (
                      <div className="settings-option-hint" style={{ color: 'var(--color-error, #d33)' }}>
                        Catalog unavailable — aliases only. ({modelCatalog.error})
                      </div>
                    )}
                    <div className="settings-option-hint">
                      Mid-session switching: click the model name in the status bar.
                      {modelCatalog.cliVersion && <> · claude CLI {modelCatalog.cliVersion}</>}
                    </div>
                  </>
                }
              />
              <SettingsSelect
                label="Default Claude effort (new sessions)"
                name="effort"
                value={settings.effort ?? ''}
                options={EFFORT_OPTIONS}
                onChange={(v) => commit({ ...settings, effort: v })}
                footer={
                  <div className="settings-option-hint">
                    Haiku 4.5 and Opus 4.1 ignore effort. Mid-session changes restart the claude process on the same transcript.
                  </div>
                }
              />
              <SettingsSelect
                label="Claude bridge (this device)"
                name="claudeBridge"
                value={local.claudeBridge}
                options={CLAUDE_BRIDGE_OPTIONS}
                onChange={(v) => { onLocalChange({ ...local, claudeBridge: v === 'cli' ? 'cli' : 'sdk' }); flashSaved(); }}
              />
              <Toggle
                label="Wire capture (this device)"
                checked={local.showWireMenu}
                onChange={(v) => { onLocalChange({ ...local, showWireMenu: v }); flashSaved(); }}
                text={'Show "⚡ New Claude session (wire capture)" in the tab menu'}
                hint="Sessions started from that item route their API calls through the local wire proxy and record every request/response (plaintext prompts included) under the project's .aie/observations/wire/ for the observe tab."
              />
              {registered}
            </>
          )}

          {group === 'devin' && (
            <>
              <Toggle
                label="Devin (this device)"
                checked={local.enableDevin}
                onChange={(v) => { onLocalChange({ ...local, enableDevin: v }); flashSaved(); }}
                text="Enable Devin on this device"
                hint='Off hides "New / Resume Devin session" in the tab menu. Open Devin tabs and everything else keep working.'
              />
              <SettingsSelect
                label="Default Devin model (new sessions)"
                name="devinModel"
                value={settings.devinModel ?? ''}
                options={DEVIN_MODEL_OPTIONS}
                showId
                onChange={(v) => commit({ ...settings, devinModel: v })}
                footer={
                  <div className="settings-option-hint">
                    Devin's full list (~75 models) is available mid-session via the model picker.
                  </div>
                }
              />
              <SettingsSelect
                label="Default Devin mode (new sessions)"
                name="devinMode"
                value={settings.devinMode ?? ''}
                options={DEVIN_MODE_OPTIONS}
                onChange={(v) => commit({ ...settings, devinMode: v })}
                footer={
                  <div className="settings-option-hint">
                    Applied right after the session starts. Resumed sessions keep their own mode; the status-bar Mode picker still works mid-session.
                  </div>
                }
              />
              <SettingsSelect
                label="Devin CLI version"
                name="devinVersion"
                value={settings.devinVersion ?? ''}
                options={devinVersionOptions(devinVersions, settings.devinVersion ?? '')}
                onChange={(v) => commit({ ...settings, devinVersion: v })}
                footer={
                  <div className="settings-option-hint">
                    Applies to the next Devin session you open. Installed versions are read from <code className="settings-mono">~/.local/share/devin/cli/_versions</code>.
                  </div>
                }
              />
              {registered}
            </>
          )}

          {group === 'features' && (
            <>
              <Toggle
                label="Review"
                checked={settings.review ?? false}
                onChange={(v) => commit({ ...settings, review: v })}
                text="Show the Review panel (comment on AI output, send in batches)"
                hint="Select text in a session (or 💬 a message) to comment; comments collect in batches you send to the AI when ready. Right-hand column on desktop, right drawer on mobile. Existing batches are kept while off."
              />
              <Toggle
                label="Rich copy"
                checked={settings.richCopy ?? false}
                onChange={(v) => commit({ ...settings, richCopy: v })}
                text="Show 🍚 on AI replies"
                hint="One click copies the reply to the clipboard with formatting (headings, lists, code blocks), ready to paste into documents or chat apps."
              />
              <Toggle
                label="Show stderr output"
                checked={settings.showStderr ?? false}
                onChange={(v) => commit({ ...settings, showStderr: v })}
                text="Show stderr in chat"
                hint="Display stderr messages from AI processes (can be noisy)"
              />
              {registered}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
