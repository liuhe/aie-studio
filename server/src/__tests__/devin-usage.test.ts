import { describe, it, expect } from 'vitest';
import { mapUserStatus } from '../devin-usage.js';

// Shape observed from SeatManagementService/GetUserStatus (Connect JSON):
// int64 fields arrive as strings, percentages as numbers.
const SAMPLE = {
  userStatus: {
    planStatus: {
      planStart: '2026-03-22T09:10:44Z',
      planEnd: '2027-03-22T02:58:32Z',
      availablePromptCredits: -1,
      dailyQuotaRemainingPercent: 58,
      weeklyQuotaRemainingPercent: 33,
      overageBalanceMicros: '19049413',
      dailyQuotaResetAtUnix: '1789286400',
      weeklyQuotaResetAtUnix: '1789286400',
      planInfo: { planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA', devinInfo: {} },
    },
  },
};

describe('mapUserStatus', () => {
  it('maps quota percentages, reset times and overage balance', () => {
    const u = mapUserStatus(SAMPLE);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.planName).toBe('Pro');
    expect(u.planEnd).toBe('2027-03-22T02:58:32Z');
    expect(u.daily).toEqual({ remainingPercent: 58, resetAt: '2026-09-13T08:00:00.000Z' });
    expect(u.weekly).toEqual({ remainingPercent: 33, resetAt: '2026-09-13T08:00:00.000Z' });
    expect(u.overageBalance).toBeCloseTo(19.049413, 6);
    expect(u.acu).toBeNull();
  });

  it('hides the weekly bar when planInfo.hideWeeklyQuota is set', () => {
    const body = structuredClone(SAMPLE);
    body.userStatus.planStatus.planInfo = { ...body.userStatus.planStatus.planInfo, hideWeeklyQuota: true } as any;
    const u = mapUserStatus(body);
    expect(u.ok && u.weekly).toBeNull();
    expect(u.ok && u.daily?.remainingPercent).toBe(58);
  });

  it('tolerates a mostly-empty response', () => {
    const u = mapUserStatus({ userStatus: {} });
    expect(u).toMatchObject({ ok: true, planName: null, daily: null, weekly: null, overageBalance: null, acu: null });
  });

  it('exposes ACU when the account reports it', () => {
    const body = structuredClone(SAMPLE);
    (body.userStatus.planStatus as any).acuConsumed = '12.5';
    (body.userStatus.planStatus as any).acuLimit = '250';
    const u = mapUserStatus(body);
    expect(u.ok && u.acu).toEqual({ consumed: 12.5, limit: 250 });
  });
});
