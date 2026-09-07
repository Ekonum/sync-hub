import type { Db } from './db.js';
import type { PushBatch, PushResult } from '../types.js';

export interface PushClientOptions {
  remoteUrl: string;
  remoteToken: string;
  /** Messages per POST, as an upper bound — the real limit is maxBatchBytes below. 50 rather than
   * something larger because the remote indexes every message into FTS as it applies the batch: on
   * a small VPS a 200-message batch took long enough to blow Node's default fetch headers timeout,
   * which stalls the whole sync. Smaller batches mean more round trips but ones that finish. */
  batchSize?: number;
  /** Ceiling on the serialized body, which is what actually has to fit.
   *
   * Counting messages is not counting bytes, and verbatim content makes the two unrelated: a page
   * of 50 was measured at 27.9 MB, of which two messages were 27.5 MB. That exceeded the remote's
   * own 25 MB bodyLimit, so it could never be applied — and since the watermark only advances on
   * success, every cycle rebuilt the identical oversized body and failed again. Cloudflare reported
   * it as an HTTP/2 ENHANCE_YOUR_CALM, which reads like throttling rather than "too big". The queue
   * stood still for five days with 20 839 messages behind it. */
  maxBatchBytes?: number;
  /** Bounds a single POST. Without it a slow remote hangs on undici's default headers timeout and
   * the failure surfaces as an opaque UND_ERR_HEADERS_TIMEOUT minutes later.
   *
   * Generous on purpose. The remote applies a batch synchronously — better-sqlite3 writes plus an
   * FTS index pass — which pins its single thread and stops it answering anything at all, measured
   * at a full core while catching up. Giving up at 60 s did not make that faster: the remote
   * carried on applying the batch it had been sent, the client re-pushed the same rows on the next
   * cycle, and the retry queued behind the work it had just abandoned. Waiting costs nothing here,
   * since there is nothing else for this cycle to do meanwhile. */
  requestTimeoutMs?: number;
}

/**
 * Pushes every message this instance hasn't pushed to `opts.remoteUrl` yet, in ascending
 * ingest_seq order, batched. The local watermark (Db.getRemoteSyncState/setRemoteSyncState) only
 * advances after a batch is confirmed applied — a network error or a non-2xx response leaves it
 * untouched, so the next cycle retries from the same point; re-pushing an already-applied batch is
 * always safe (the remote's own hash-based dedup, the same mechanism this store uses for its own
 * local ingestion, makes a duplicate push a no-op rather than a duplicate row).
 *
 * Push-only for now (see the brick-1 plan): this never reads anything back from the remote.
 */
export async function runPushCycle(db: Db, opts: PushClientOptions): Promise<void> {
  const batchSize = opts.batchSize ?? 50;
  const maxBatchBytes = opts.maxBatchBytes ?? 8 * 1024 * 1024;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 240_000;
  let cursor = db.getRemoteSyncState(opts.remoteUrl).lastPushedSeq;

  while (true) {
    const page = db.getMessagesAfterSeq(cursor, batchSize);
    if (page.messages.length === 0) break;

    // Trim the page to what will fit. The first message is always kept, even when it alone busts
    // the ceiling: dropping it would lose content, and the whole point of this store is that
    // nothing is summarised or discarded. An oversized single message is sent on its own, which is
    // both the best chance of it going through and the only way the queue behind it can drain.
    let bytes = 0;
    let count = 0;
    for (const message of page.messages) {
      const size = JSON.stringify(message).length;
      if (count > 0 && bytes + size > maxBatchBytes) break;
      bytes += size;
      count++;
    }
    const messages = page.messages.slice(0, count);
    const maxSeq = page.seqs[count - 1];
    if (count < page.messages.length) {
      console.log(`sync-push: page trimmed to ${count}/${page.messages.length} messages (${(bytes / 1024 / 1024).toFixed(1)} Mo)`);
    }

    // Projects are sent in full each batch (small, and upsertProject is a cheap idempotent
    // upsert) rather than tracked incrementally — simpler, and avoids a second watermark to keep
    // in sync with the message one. Threads are scoped to exactly what this batch's messages
    // reference, not sent in full (a real store can have thousands).
    const threadIds = [...new Set(messages.map((m) => m.threadId))];
    const batch: PushBatch = { projects: db.getProjects(), threads: db.getThreadsByIds(threadIds), messages };

    let response: Response;
    try {
      response = await fetch(`${opts.remoteUrl}/api/sync/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.remoteToken}` },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      console.error(
        `sync-push: batch of ${messages.length} after seq ${cursor} failed to reach the remote, will retry next cycle:`,
        err,
      );
      return;
    }
    if (!response.ok) {
      console.error(`sync-push: remote rejected batch (HTTP ${response.status}), will retry next cycle`);
      return;
    }

    const result = (await response.json()) as PushResult;
    if (result.skipped.projects.length || result.skipped.threads.length || result.skipped.messages.length) {
      console.error('sync-push: remote skipped some rows in this batch:', result.skipped);
    }
    cursor = maxSeq;
    db.setRemoteSyncState(opts.remoteUrl, cursor, new Date().toISOString());
  }
}
