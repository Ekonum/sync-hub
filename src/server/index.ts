import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Db } from '../core/db.js';
import { ProjectRegistry } from '../core/registry.js';
import { startWatching, type WatchHandle } from '../core/watch.js';
import type { ScanProgress } from '../types.js';
import { updateAllPointerFiles } from '../core/pointer-files.js';
import * as claudeCode from '../core/adapters/claude-code.js';
import * as codex from '../core/adapters/codex.js';
import * as cowork from '../core/adapters/cowork.js';
import * as antigravity from '../core/adapters/antigravity.js';
import { ingestAllMemories } from '../core/adapters/memories.js';
import { ingestClaudeExport } from '../core/adapters/claude-export.js';
import { ingestChatGptExport } from '../core/adapters/chatgpt-export.js';
import { runPushCycle } from '../core/sync-push-client.js';
import { runPullCycle } from '../core/sync-pull-client.js';
import { createApp } from './app.js';

const PROJECTS_ROOT = process.env.SYNC_HUB_PROJECTS_ROOT ?? join(homedir(), 'Projets');
const DATA_DIR = process.env.SYNC_HUB_DATA_DIR ?? join(import.meta.dirname, '..', '..', 'data');
const IMPORTS_DIR = process.env.SYNC_HUB_IMPORTS_DIR ?? join(import.meta.dirname, '..', '..', 'imports');
const CLIENT_DIST = join(import.meta.dirname, '..', '..', 'dist', 'client');
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '127.0.0.1'; // local-only by default — this is a personal tool, not a network service

// A remote hub (brick 1 of remote sync — see the sync-hub plan) is this exact same server, just
// with nothing local to scan: no ~/.claude, no ~/Projets, inside its container. Same codebase,
// one flag, rather than a second image to build and keep in sync.
const DISABLE_LOCAL_INGEST = process.env.SYNC_HUB_DISABLE_LOCAL_INGEST === '1';
// Configures the OUTGOING/INCOMING sync side (this instance synchronizing with a remote hub) — opt-in, no-op on any
// instance that hasn't set both.
// Mutable, so enrolling from the dashboard takes effect immediately rather than on next boot —
// a newcomer pasting a token should see the sync start, not be told to restart a service.
// Persisted in the keychain (token) and a small file (URL) so a restart keeps the enrolment.
const ENROLMENT_FILE = join(DATA_DIR, 'remote.json');
let REMOTE_URL = process.env.SYNC_HUB_REMOTE_URL;
let REMOTE_TOKEN = process.env.SYNC_HUB_REMOTE_TOKEN;

if (!REMOTE_URL) {
  try {
    REMOTE_URL = JSON.parse(readFileSync(ENROLMENT_FILE, 'utf-8')).remoteUrl || undefined;
  } catch {
    // No file yet, or unreadable — this instance simply is not enrolled.
  }
}

const db = new Db(join(DATA_DIR, 'hub.sqlite'));
const registry = new ProjectRegistry(db);
if (!DISABLE_LOCAL_INGEST) registry.bootstrapFromProjectsRoot(PROJECTS_ROOT);

/** Hands the event loop back so pending HTTP requests get served between two files. */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The full scan, one file at a time, yielding in between.
 *
 * The only scan there is now. A synchronous twin existed for the "Rescanner" button, which meant
 * pressing it blocked the server for the length of the scan — including the request that would
 * have asked whether it was finished.
 *
 * The synchronous version blocks for as long as it takes — measured from a clean clone against a
 * real history: over six minutes, during which the dashboard answered nothing at all. Node runs
 * this on one thread, so listening earlier is not enough on its own; the loop has to be given
 * back. A newcomer now gets a dashboard immediately, and watches it fill.
 */
async function fullScanProgressively(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (DISABLE_LOCAL_INGEST) return;
  let files = 0;

  const engines: Array<{ name: string; refs: unknown[]; ingest: (ref: any) => void }> = [
    { name: 'Claude Code', refs: claudeCode.discoverSessionFiles(), ingest: (r) => claudeCode.ingestSessionFile(db, registry, r) },
    { name: 'Codex', refs: codex.discoverSessionFiles(), ingest: (r) => codex.ingestSessionFile(db, registry, r) },
    { name: 'Antigravity', refs: antigravity.discoverSessionFiles(), ingest: (r) => antigravity.ingestSessionFile(db, registry, r) },
    { name: 'Antigravity CLI', refs: antigravity.discoverSessionFiles(antigravity.ANTIGRAVITY_CLI_BRAIN_ROOT), ingest: (r) => antigravity.ingestSessionFile(db, registry, r) },
  ];
  // Counted once, up front: a progress figure whose denominator moves tells you nothing.
  const total = engines.reduce((n, e) => n + e.refs.length, 0);
  const report = (phase: string) => onProgress?.({ running: true, done: files, total, phase });

  for (const engine of engines) {
    const engineStarted = Date.now();
    report(engine.name);
    for (const ref of engine.refs) {
      try {
        engine.ingest(ref);
      } catch (err) {
        // One unreadable session must not abort the whole first run.
        console.error('sync-hub: fichier ignoré pendant le scan initial', err);
      }
      files++;
      report(engine.name);
      await yieldToEventLoop();
    }
    const seconds = (Date.now() - engineStarted) / 1000;
    if (seconds >= 1) console.log(`sync-hub: ${engine.name}, ${engine.refs.length} fichiers en ${seconds.toFixed(0)} s`);
  }

  // These read whole archives rather than a session at a time, and none of them yields, so each
  // one holds the event loop for as long as it takes. Timing them is how you find out which — the
  // ChatGPT export alone is 281 MB here, and a slow phase is otherwise indistinguishable from a
  // hung process.
  const timed = (label: string, run: () => void) => {
    const started = Date.now();
    report(label);
    run();
    const seconds = (Date.now() - started) / 1000;
    if (seconds >= 1) console.log(`sync-hub: ${label} en ${seconds.toFixed(0)} s`);
  };
  timed('cowork', () => cowork.ingestAll(db, registry));
  timed('mémoires', () => ingestAllMemories(db, registry));
  timed('archive Claude', () => ingestClaudeExport(db, join(IMPORTS_DIR, 'claude')));
  timed('archive ChatGPT', () => ingestChatGptExport(db, join(IMPORTS_DIR, 'chatgpt')));
  timed('fichiers repères', () => updateAllPointerFiles(db));
  onProgress?.({ running: false, done: files, total, phase: '' });
  lastPointerPass = new Date();
  console.log(`sync-hub: scan initial terminé (${files} fichiers de session).`);
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncInterval: ReturnType<typeof setInterval> | undefined;

async function syncNow(): Promise<void> {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  try {
    // Pull any new remote items first, then push any pending local items
    await runPullCycle(db, { remoteUrl: REMOTE_URL, remoteToken: REMOTE_TOKEN });
    await runPushCycle(db, { remoteUrl: REMOTE_URL, remoteToken: REMOTE_TOKEN });
  } catch (err) {
    console.error('sync: bidirectional cycle failed', err);
  }
}

/** Debounced rather than fired on every ingest event — a burst of file changes (a full scan, a
 * fast-typed conversation) should settle into one sync cycle, not one HTTP round trip per file. */
function scheduleSync(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 15_000);
}

/** A floor under the ingest-driven schedule above. Guarantees regular pull/push even without local activity. */
function startSyncInterval(): void {
  if (!REMOTE_URL || !REMOTE_TOKEN) return;
  syncInterval = setInterval(syncNow, 5 * 60_000);
  syncInterval.unref?.(); // never hold the process open on its own account
}

if (DISABLE_LOCAL_INGEST) {
  console.log('sync-hub: rôle hub distant — pas de scan local, en attente de sync…');
} else {
  console.log('sync-hub: dashboard disponible immédiatement, scan initial en arrière-plan…');
}
scheduleSync();
startSyncInterval();

/**
 * Pointer-file refresh, debounced and scoped.
 *
 * An assistant appends to its own transcript every few seconds while it works, and each append is
 * an ingest event. Running the full pass on every one of them cost ~2.8s of CPU a time and
 * rewrote 134 files — measured at 17-60% of a core during ordinary use. Collapsing a burst into
 * one pass, and touching only projects active since the previous pass, makes the steady-state
 * cost negligible without ever letting a pointer go stale for more than the delay.
 */
let pointerTimer: ReturnType<typeof setTimeout> | undefined;
let lastPointerPass: Date | undefined;
function schedulePointerRefresh(): void {
  if (pointerTimer) clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => {
    const since = lastPointerPass;
    lastPointerPass = new Date();
    updateAllPointerFiles(db, new Date(), since);
  }, 20_000);
  pointerTimer.unref?.();
}

const watchHandle: WatchHandle = DISABLE_LOCAL_INGEST
  ? { isActive: () => false, ready: () => Promise.resolve(), close: async () => {} }
  : startWatching(db, registry, {
      onIngest: () => {
        schedulePointerRefresh();
        scheduleSync();
      },
    });

const appDeps: Parameters<typeof createApp>[0] = {
  db,
  registry,
  watchHandle,
  rescan: fullScanProgressively,
  onEnrol: (hubUrl, token) => {
    REMOTE_URL = hubUrl;
    REMOTE_TOKEN = token;
    // The handlers read deps at request time, so mutating the very object we passed is what makes
    // an enrolment visible immediately instead of only after the next boot.
    appDeps.remoteUrl = hubUrl;
    appDeps.remoteToken = token;
    // The token goes to the keychain, never to the JSON file: run_daemon.sh reads it back from
    // there at boot, and a file under data/ would put a live credential on disk in cleartext.
    execFileSync('security', ['add-generic-password', '-a', process.env.USER ?? 'sync-hub', '-s', 'sync-hub-remote-token', '-w', token, '-U']);
    writeFileSync(ENROLMENT_FILE, JSON.stringify({ remoteUrl: hubUrl }, null, 2));
    startSyncInterval();
    void syncNow();
  },
  clientDistDir: CLIENT_DIST,
  localIngest: !DISABLE_LOCAL_INGEST,
  archiveRoots: { syncHubArchiveRoot: join(DATA_DIR, 'archived-sessions') },
  importsDir: IMPORTS_DIR,
  remoteUrl: REMOTE_URL,
  remoteToken: REMOTE_TOKEN,
};

const app = createApp(appDeps);

const address = await app.listen({ port: PORT, host: HOST });
app.log.info(`sync-hub écoute sur ${address}`);

// Deliberately after listen() and deliberately not awaited: the first run on a real history takes
// minutes, and there is no reason to keep the dashboard dark for it.
void fullScanProgressively()
  .then(() => scheduleSync())
  .catch((err) => console.error('sync-hub: scan initial en échec', err));

async function shutdown(): Promise<void> {
  if (syncTimer) clearTimeout(syncTimer);
  if (pointerTimer) clearTimeout(pointerTimer);
  if (syncInterval) clearInterval(syncInterval);
  await watchHandle.close();
  await app.close();
  db.close();
  process.exit(0);
}

// SIGINT: Ctrl-C in a terminal. SIGTERM: what `launchctl unload`/`kill` send to stop the service.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
