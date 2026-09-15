import { useRef, useState, type ReactNode } from 'react';
import type { Settings, SendKey, Theme, FontScale } from '../types';
import { usePwaInstall } from '../usePwaInstall';
import { listSettingsSections } from '../registry';
import { useClaudeModels, EFFORT_LEVELS } from '../useClaudeModels';

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

export function Settings({
  settings,
  username,
  onChange,
  onClose,
  onSignOut,
}: {
  settings: Settings;
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
  const pwa = usePwaInstall();
  const modelCatalog = useClaudeModels();
  function commit(next: Settings) {
    onChange(next);
    setSavedFlash(true);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1200);
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

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Settings</span>
          <span className="settings-saved-flash" data-on={savedFlash ? '1' : '0'}>Saved ✓</span>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-body">
          <SettingsSelect
            label="Theme"
            name="theme"
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(v) => commit({ ...settings, theme: v as Theme })}
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
            <div className="settings-label">Show stderr output</div>
            <label className="settings-option">
              <input
                type="checkbox"
                checked={settings.showStderr ?? false}
                onChange={(e) => commit({ ...settings, showStderr: e.target.checked })}
              />
              <div className="settings-option-text">
                <div>Show stderr in chat</div>
                <div className="settings-option-hint">Display stderr messages from AI processes (can be noisy)</div>
              </div>
            </label>
          </div>
          <div className="settings-section">
            <div className="settings-label">Pinboard</div>
            <label className="settings-option">
              <input
                type="checkbox"
                checked={settings.pinboard ?? false}
                onChange={(e) => commit({ ...settings, pinboard: e.target.checked })}
              />
              <div className="settings-option-text">
                <div>Show the Pinboard (notes + message bookmarks)</div>
                <div className="settings-option-hint">Right-hand column on desktop, right drawer on mobile, ☆ on chat messages. Existing pins are kept while off.</div>
              </div>
            </label>
          </div>
          <div className="settings-section">
            <div className="settings-label">Rich copy editor (desktop only)</div>
            <label className="settings-option">
              <input
                type="checkbox"
                checked={settings.richCopy ?? false}
                onChange={(e) => commit({ ...settings, richCopy: e.target.checked })}
              />
              <div className="settings-option-text">
                <div>Show 🍚 on AI replies</div>
                <div className="settings-option-hint">Opens the reply in an editable overlay so you can tweak it and copy it with formatting. Not available in the mobile layout.</div>
              </div>
            </label>
          </div>
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
          {listSettingsSections().map((section) => (
            <div key={section.id} className="settings-section">
              <div className="settings-label">{section.label}</div>
              {section.render({ settings, commit })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
