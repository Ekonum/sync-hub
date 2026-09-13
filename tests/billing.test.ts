import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING, computeBillable, type BillingSettings } from '../src/core/billing.js';

const H = 3_600_000;

const activity = { totalTypingMs: 10 * H, totalThinkingMs: 4 * H };

const costs = {
  measuredCostUsd: 100,
  interpolatedCostUsd: 20,
  upperBoundCostUsd: 500,
  unpricedMessageCount: 7,
  eurRate: 1, // keeps the arithmetic readable; conversion is tested on its own below
};

const settings = (o: Partial<BillingSettings> = {}): BillingSettings => ({ ...DEFAULT_BILLING, hourlyRateEur: 105, ...o });

describe('computeBillable', () => {
  it('bills writing time at the rate, and leaves the wait out by default', () => {
    const b = computeBillable(activity, costs, settings());
    expect(b.billableHours).toBe(10);
    expect(b.timeAmountEur).toBe(1050);
    expect(b.excluded.waitingTimeNotBilled).toBe(true);
  });

  it('adds the wait when that is the choice made', () => {
    const b = computeBillable(activity, costs, settings({ billWaitingTime: true }));
    expect(b.billableHours).toBe(14);
    expect(b.timeAmountEur).toBe(1470);
    expect(b.excluded.waitingTimeNotBilled).toBe(false);
  });

  it('never lets the archive upper bound into the total', () => {
    // The rule this module exists to enforce: 500 of upper bound, reported and not added.
    const b = computeBillable(activity, costs, settings({ hourlyRateEur: 0 }));
    expect(b.tokenCostEur).toBe(120); // measured + interpolated only
    expect(b.totalEur).toBe(120);
    expect(b.excluded.upperBoundEur).toBe(500);
  });

  it('applies a positive margin on top of the token cost', () => {
    const b = computeBillable(activity, costs, settings({ hourlyRateEur: 0, tokenMarginPercent: 25 }));
    expect(b.marginAmountEur).toBe(30);
    expect(b.tokenAmountEur).toBe(150);
  });

  it('lets a negative margin absorb part of the cost', () => {
    const b = computeBillable(activity, costs, settings({ hourlyRateEur: 0, tokenMarginPercent: -30 }));
    expect(b.tokenAmountEur).toBeCloseTo(84, 10); // 70% passed on
  });

  it('stops at zero rather than crediting the client for tokens', () => {
    // -100 means "I absorb it", not "I pay you for having used it".
    const b = computeBillable(activity, costs, settings({ hourlyRateEur: 0, tokenMarginPercent: -150 }));
    expect(b.tokenAmountEur).toBe(0);
    expect(b.totalEur).toBe(0);
  });

  it('converts the token cost into euros', () => {
    const b = computeBillable(activity, { ...costs, eurRate: 0.5 }, settings({ hourlyRateEur: 0 }));
    expect(b.tokenCostEur).toBe(60);
    expect(b.excluded.upperBoundEur).toBe(250);
  });

  it('reports messages whose model has no published rate rather than pricing them', () => {
    // Counting them as zero is the under-billing choice; saying how many is what makes it honest.
    const b = computeBillable(activity, costs, settings());
    expect(b.excluded.unpricedMessageCount).toBe(7);
  });

  it('bills nothing at all under the defaults', () => {
    // No rate set means no invoice, not an invoice of zero hours at some assumed rate.
    const b = computeBillable(activity, costs, DEFAULT_BILLING);
    expect(b.timeAmountEur).toBe(0);
    expect(b.tokenAmountEur).toBe(120); // the cost is still real, it just carries no margin
  });

  it('refuses a negative hourly rate rather than subtracting from the bill', () => {
    const b = computeBillable(activity, costs, settings({ hourlyRateEur: -50 }));
    expect(b.timeAmountEur).toBe(0);
  });
});
