import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { computeMessageHash } from '../src/core/hash.js';
import {
  COSTS_SNAPSHOT,
  TIMELINE_SNAPSHOT,
  isWholeCorpus,
  refreshStatsSnapshots,
  snapshotsAreStale,
} from '../src/core/stats-snapshot.js';
import type { CostSummary } from '../src/core/cost.js';

let dir: string;
let db: Db;

const NOW = '2026-09-12T08:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-snapshot-'));
  db = new Db(join(dir, 'hub.sqlite'));
  db.upsertProject({
    id: 'p1', name: 'P', canonicalPath: join(dir, 'p'),
    aliases: { paths: [], claudeSlugs: [], codexCwds: [] }, createdAt: NOW, lastActiveAt: NOW,
  });
  db.upsertThread({
    id: 't1', projectId: 'p1', title: 'T', originEngine: 'claude-code', engineIds: {},
    messageCount: 0, promptCount: 0, createdAt: NOW, updatedAt: NOW, status: 'active',
  });
  db.insertMessage({
    id: 'm1', threadId: 't1', projectId: 'p1', sourceEngine: 'claude-code', role: 'assistant',
    content: 'x', timestamp: NOW, sequence: 0, model: 'claude-sonnet-5',
    usage: { inputTokens: 1_000_000, outputTokens: 0 },
    hash: computeMessageHash({ threadId: 't1', timestamp: NOW, role: 'assistant', content: 'x' }),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('isWholeCorpus', () => {
  it('is true only when nothing narrows the question', () => {
    // What decides whether a stored answer can be served at all.
    expect(isWholeCorpus({})).toBe(true);
    expect(isWholeCorpus({ eurRate: 0.92 })).toBe(true); // a conversion rate narrows nothing
    expect(isWholeCorpus({ projectId: 'p1' })).toBe(false);
    expect(isWholeCorpus({ startDate: '2026-09-01' })).toBe(false);
    expect(isWholeCorpus({ threadId: 't1' })).toBe(false);
    expect(isWholeCorpus({ engine: 'codex' })).toBe(false);
  });
});

describe('refreshStatsSnapshots', () => {
  it('stores both aggregates, with the moment they were taken', () => {
    refreshStatsSnapshots(db);

    const costs = db.getStatsSnapshot<CostSummary>(COSTS_SNAPSHOT)!;
    expect(costs.payload.totalCostUsd).toBeCloseTo(2, 10); // $2/MTok input on sonnet-5
    expect(Date.parse(costs.computedAt)).toBeGreaterThan(0);
    expect(costs.messageCount).toBe(1);

    expect(db.getStatsSnapshot(TIMELINE_SNAPSHOT)).not.toBeNull();
  });

  it('stores the totals, not just the series', () => {
    // The billing figure adds these up. Recomputing them separately took 14.5 s for a number
    // describing four years of work.
    refreshStatsSnapshots(db);
    const stored = db.getStatsSnapshot<{ summary: { totalTypingMs: number; messageCount: number } }>(TIMELINE_SNAPSHOT)!;
    expect(stored.payload.summary).toHaveProperty('totalTypingMs');
    expect(stored.payload.summary).toHaveProperty('byDate');
    expect(stored.payload.summary).toHaveProperty('cappedMessageCount');
  });

  it('records the typing pace alongside the series', () => {
    // A series taken at another pace would draw bars contradicting the totals beside them, so the
    // reader has to be able to tell. Storing the pace is what lets the route refuse a mismatch.
    db.setKeystrokesPerMinute('local-admin', 120);
    refreshStatsSnapshots(db);
    const stored = db.getStatsSnapshot<{ keystrokesPerMinute: number }>(TIMELINE_SNAPSHOT)!;
    expect(stored.payload.keystrokesPerMinute).toBe(db.getKeystrokesPerMinute(undefined));
  });
});

describe('une forme retirée', () => {
  it('is ignored rather than misread, and swept away on the next pass', () => {
    // A stored payload whose shape changed is present, parses, and yields undefined where the new
    // code looks — which turned the page into a 500 rather than a recompute. The key carries the
    // version so the old row is never read, and the refresh drops it.
    db.setStatsSnapshot('timeline.v1', { byDate: [] });
    expect(db.getStatsSnapshot('timeline.v1')).not.toBeNull();

    refreshStatsSnapshots(db);

    expect(db.getStatsSnapshot('timeline.v1')).toBeNull();
    expect(db.getStatsSnapshot(TIMELINE_SNAPSHOT)).not.toBeNull();
  });
});

describe('snapshotsAreStale', () => {
  it('is stale when nothing has ever been computed', () => {
    expect(snapshotsAreStale(db)).toBe(true);
  });

  it('is fresh right after a pass', () => {
    refreshStatsSnapshots(db);
    expect(snapshotsAreStale(db)).toBe(false);
  });

  it('is stale again a day later', () => {
    refreshStatsSnapshots(db);
    expect(snapshotsAreStale(db, Date.now() + 25 * 3_600_000)).toBe(true);
  });

  it('survives a corrupted payload rather than throwing on a page load', () => {
    refreshStatsSnapshots(db);
    db.raw.prepare("UPDATE stats_snapshot SET payload = '{tronqué' WHERE key = ?").run(COSTS_SNAPSHOT);
    expect(db.getStatsSnapshot(COSTS_SNAPSHOT)).toBeNull();
    expect(snapshotsAreStale(db)).toBe(true);
  });
});
