/**
 * What a slice of work comes to, time and tokens together.
 *
 * Two figures of different natures are being added, and the result goes on an invoice, so what
 * each one is has to survive the addition:
 *
 *  - **Time** is an estimate, capped by the clock (see core/activity.ts). Writing time is derived
 *    from a character count at a pace the user sets; the wait for a reply is measured.
 *  - **Tokens** are measured consumption at published rates — except where they are not, which is
 *    the whole reason costs are split three ways in core/cost.ts.
 *
 * Two rules follow, and neither is negotiable:
 *
 *  1. **The archive upper bound never enters a billed amount.** An export says neither which model
 *     answered nor what it consumed, so its cost is computed against the dearest model of its date.
 *     That is a deliberate over-estimate, useful for knowing an order of magnitude and worthless as
 *     a price. It is reported alongside, never inside.
 *  2. **The default under-bills.** Only writing time is billed unless the user says otherwise, and
 *     unpriced messages count as zero rather than being guessed at. A figure that is too low is
 *     corrected by a person who notices; one that is too high is discovered by the client.
 */
import type { CostSummary } from './cost.js';

/** Deliberately low, and deliberately explicit: nothing here has a silent default. */
export const DEFAULT_BILLING: BillingSettings = {
  hourlyRateEur: 0,
  tokenMarginPercent: 0,
  billWaitingTime: false,
};

export interface BillingSettings {
  /** What an hour of work is invoiced at. Zero means time is not billed at all. */
  hourlyRateEur: number;
  /**
   * Applied to the token cost. 20 charges a fifth on top; -100 absorbs it entirely; -30 passes on
   * seventy percent of it. Negative is a real choice, not a mistake, so it is allowed.
   */
  tokenMarginPercent: number;
  /**
   * Whether the wait for a reply counts as billed time.
   *
   * Off by default. The wait is measured rather than estimated, which makes it tempting — but it is
   * also the time during which somebody can be doing something else, which is exactly why a day in
   * this corpus can add up to 35.5 hours. Turning it on is a decision about how one works, not a
   * detail of presentation.
   */
  billWaitingTime: boolean;
}

export interface BillableAmount {
  /** Hours actually charged, after the choice above. */
  billableHours: number;
  writingHours: number;
  waitingHours: number;
  timeAmountEur: number;

  /** Token cost before margin — measured and interpolated only. */
  tokenCostEur: number;
  marginAmountEur: number;
  tokenAmountEur: number;

  totalEur: number;

  /**
   * What was deliberately left out, so the total can be defended rather than merely quoted.
   */
  excluded: {
    /** The archives' upper bound, in euros. Reported, never added. */
    upperBoundEur: number;
    /** Messages carrying real usage against a model with no published rate. Counted as zero. */
    unpricedMessageCount: number;
    /** True when the wait was measured but not charged. */
    waitingTimeNotBilled: boolean;
  };
}

const MS_PER_HOUR = 3_600_000;

export function computeBillable(
  activity: { totalTypingMs: number; totalThinkingMs: number },
  costs: Pick<CostSummary, 'measuredCostUsd' | 'interpolatedCostUsd' | 'upperBoundCostUsd' | 'unpricedMessageCount' | 'eurRate'>,
  settings: BillingSettings,
): BillableAmount {
  const writingHours = activity.totalTypingMs / MS_PER_HOUR;
  const waitingHours = activity.totalThinkingMs / MS_PER_HOUR;
  const billableHours = writingHours + (settings.billWaitingTime ? waitingHours : 0);
  const timeAmountEur = billableHours * Math.max(0, settings.hourlyRateEur);

  // Measured plus interpolated. The upper bound is excluded here and reported below — see rule 1.
  const tokenCostEur = (costs.measuredCostUsd + costs.interpolatedCostUsd) * costs.eurRate;
  const marginAmountEur = tokenCostEur * (settings.tokenMarginPercent / 100);
  // A margin of -100 zeroes the line rather than turning it into a credit: absorbing a cost is not
  // the same as paying the client to have incurred it.
  const tokenAmountEur = Math.max(0, tokenCostEur + marginAmountEur);

  return {
    billableHours,
    writingHours,
    waitingHours,
    timeAmountEur,
    tokenCostEur,
    marginAmountEur,
    tokenAmountEur,
    totalEur: timeAmountEur + tokenAmountEur,
    excluded: {
      upperBoundEur: costs.upperBoundCostUsd * costs.eurRate,
      unpricedMessageCount: costs.unpricedMessageCount,
      waitingTimeNotBilled: !settings.billWaitingTime && waitingHours > 0,
    },
  };
}
