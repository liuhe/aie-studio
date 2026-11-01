import { useEffect, useState, type ReactNode } from 'react';
import { getDevinUsage, type DevinQuota, type DevinUsage as DevinUsageData } from '../api';

// Devin subscription quota — the CLI's `/usage` panel isn't reachable over
// ACP, so the server fetches the same data directly (GET /api/devin/usage).
function formatReset(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets soon';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 48 ? `resets in ${Math.floor(h / 24)}d` : h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function QuotaBar({ label, quota }: { label: string; quota: DevinQuota }) {
  const pct = Math.max(0, Math.min(100, quota.remainingPercent));
  const level = pct <= 10 ? 'critical' : pct <= 30 ? 'low' : 'ok';
  return (
    <div className="devin-quota">
      <div className="devin-quota-head">
        <span>{label}</span>
        <span className="devin-quota-pct" data-level={level}>{pct}% left</span>
      </div>
      <div className="devin-quota-track">
        <div className="devin-quota-fill" data-level={level} style={{ width: `${pct}%` }} />
      </div>
      <div className="settings-option-hint">{formatReset(quota.resetAt)}</div>
    </div>
  );
}

export function DevinUsage({ onClose }: { onClose: () => void }) {
  const [usage, setUsage] = useState<DevinUsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const load = (refresh: boolean) => {
    setLoading(true);
    getDevinUsage(refresh)
      .then(setUsage, (e) => setUsage({ ok: false, error: e?.message || String(e) }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []);

  let body: ReactNode;
  if (!usage) {
    body = <div className="settings-option-hint">Loading…</div>;
  } else if (!usage.ok) {
    body = usage.error === 'not_logged_in' ? (
      <div className="settings-option-hint">
        Devin CLI isn't logged in on the host. Run <code className="settings-mono">devin</code> in a terminal and sign in.
      </div>
    ) : (
      <div className="settings-option-hint" style={{ color: 'var(--color-error, #d33)' }}>
        Usage unavailable: {usage.error}
      </div>
    );
  } else {
    const facts: string[] = [];
    if (usage.planName) facts.push(`${usage.planName} plan`);
    if (usage.overageBalance !== null) facts.push(`Overage balance $${usage.overageBalance.toFixed(2)}`);
    if (usage.acu) facts.push(`ACU ${usage.acu.consumed}${usage.acu.limit !== null ? ` / ${usage.acu.limit}` : ''}`);
    body = (
      <>
        {usage.daily && <QuotaBar label="Daily quota" quota={usage.daily} />}
        {usage.weekly && <QuotaBar label="Weekly quota" quota={usage.weekly} />}
        {!usage.daily && !usage.weekly && (
          <div className="settings-option-hint">No quota information reported for this account.</div>
        )}
        {facts.length > 0 && <div className="settings-option-hint">{facts.join(' · ')}</div>}
        <div className="settings-option-hint">
          Fetched {new Date(usage.fetchedAt).toLocaleTimeString()} · same data as the CLI's <code className="settings-mono">/usage</code>
        </div>
      </>
    );
  }

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span>Devin usage</span>
          <button className="settings-signout devin-usage-refresh" onClick={() => load(true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="settings-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">{body}</div>
        </div>
      </div>
    </div>
  );
}
