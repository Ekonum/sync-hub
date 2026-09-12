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
import { computeCostSummary, type CostScope } from './cost.js';

export const COSTS_SNAPSHOT = 'costs';
export const TIMELINE_SNAPSHOT = 'timeline';

/** Whether a scope asks about everything — the only shape a stored aggregate can answer. */
export function isWholeCorpus(scope: CostScope): boolean {
  return !scope.projectId && !scope.threadId && !scope.engine && !scope.startDate && !scope.endDate;
}

export function refreshStatsSnapshots(db: Db): void {
  db.setStatsSnapshot(COSTS_SNAPSHOT, computeCostSummary(db, {}));

  // The pace is stored with the series: a snapshot taken at another pace would draw bars that
  // contradict the totals shown beside them, and silently.
  const keystrokesPerMinute = db.getKeystrokesPerMinute(undefined);
  db.setStatsSnapshot(TIMELINE_SNAPSHOT, {
    byDate: db.getActivitySummary({ keystrokesPerMinute }).byDate,
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
