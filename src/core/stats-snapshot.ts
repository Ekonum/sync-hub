/**
 * The aggregates that read the whole corpus, computed once a day rather than on every page load.
 *
 * Both of them walk every message: measured on this store, the cost summary takes 7.6 s and the
 * daily time series 5.1 s. They had an in-process memo, but it was keyed on the ingest counter,
 * which moves with every message ingested — so it never held while anyone was working, which is
 * precisely when the dashboard is open. The figures are shown with the moment they were taken, so
 * a reader knows they are this morning's rather than this second's, and can ask for a refresh.
 *
 * Only the unfiltered answer is stored. A narrowed one — a project, a period — reads far fewer
 * messages and is computed live, which keeps a filtered figure exact rather than as of this
 * morning. That matters: a filtered figure is what ends up on an invoice.
 */
import type { Db } from './db.js';
import type { ActivitySummary } from './activity.js';
import { computeCostSummary, type CostScope } from './cost.js';

/** What TIMELINE_SNAPSHOT holds. */
export interface TimelineSnapshot {
  summary: ActivitySummary;
  keystrokesPerMinute: number;
}

/**
 * Keys carry the shape's version.
 *
 * These payloads are stored JSON, so changing what goes into one makes every row written by the
 * previous version unreadable — and unreadable in the worst way: the row is present, it parses,
 * and the field the new code wants is simply undefined. That is how adding the totals to the
 * timeline turned the page into a 500 rather than a recompute. Bumping the key retires the old
 * shape instead of misreading it.
 */
export const COSTS_SNAPSHOT = 'costs.v1';
export const TIMELINE_SNAPSHOT = 'timeline.v2';

/** Rows under a key nothing reads any more — a retired shape, left behind by a bump above. */
const LIVE_KEYS = [COSTS_SNAPSHOT, TIMELINE_SNAPSHOT];

/** Whether a scope asks about everything — the only shape a stored aggregate can answer. */
export function isWholeCorpus(scope: CostScope): boolean {
  return !scope.projectId && !scope.threadId && !scope.engine && !scope.startDate && !scope.endDate;
}

export function refreshStatsSnapshots(db: Db): void {
  db.deleteStatsSnapshotsExcept(LIVE_KEYS);
  db.setStatsSnapshot(COSTS_SNAPSHOT, computeCostSummary(db, {}));

  // The whole summary, not just the series: the totals are what the billing figure adds up, and
  // recomputing them separately took 14.5 s for a number that describes four years of work.
  //
  // The pace is stored with it. A snapshot taken at another pace would draw bars contradicting the
  // totals printed beside them, and price hours that were counted at somebody else's speed.
  const keystrokesPerMinute = db.getKeystrokesPerMinute(undefined);
  db.setStatsSnapshot(TIMELINE_SNAPSHOT, {
    summary: db.getActivitySummary({ keystrokesPerMinute }),
    keystrokesPerMinute,
  });
}

/** How old a snapshot may get before the daily pass rebuilds it at startup. */
const STALE_AFTER_MS = 20 * 60 * 60 * 1000;

/** True when there is nothing stored, or what is stored is from yesterday. */
export function snapshotsAreStale(db: Db, now: number = Date.now()): boolean {
  for (const key of [COSTS_SNAPSHOT, TIMELINE_SNAPSHOT]) {
    const snapshot = db.getStatsSnapshot(key);
    if (!snapshot) return true;
    if (now - Date.parse(snapshot.computedAt) > STALE_AFTER_MS) return true;
  }
  return false;
}
