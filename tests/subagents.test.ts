import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/core/db.js';
import { ProjectRegistry } from '../src/core/registry.js';
import * as claudeCode from '../src/core/adapters/claude-code.js';

let dir: string;
let root: string;
let db: Db;
let registry: ProjectRegistry;

const SLUG = '-Users-robin-Projets-demo';
const PARENT = 'parent-session-id';

const line = (role: 'user' | 'assistant', text: string, uuid: string, ts: string) =>
  JSON.stringify({ type: role, uuid, timestamp: ts, message: { role, content: text } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-subagent-'));
  root = join(dir, 'projects');
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);

  mkdirSync(join(root, SLUG), { recursive: true });
  writeFileSync(
    join(root, SLUG, `${PARENT}.jsonl`),
    [
      line('user', 'Analyse ce dossier', 'u1', '2026-09-08T10:00:00.000Z'),
      line('assistant', 'Je lance un sous-agent.', 'a1', '2026-09-08T10:00:20.000Z'),
    ].join('\n') + '\n',
  );
  // Claude Code writes a sub-agent's own conversation beside the session that started it.
  mkdirSync(join(root, SLUG, PARENT, 'subagents'), { recursive: true });
  writeFileSync(
    join(root, SLUG, PARENT, 'subagents', 'agent-abc123.jsonl'),
    [
      line('user', 'Lis le fichier /Users/robin/x.ts et résume-le', 'u2', '2026-09-08T10:00:21.000Z'),
      line('assistant', 'Voilà le résumé.', 'a2', '2026-09-08T10:04:00.000Z'),
    ].join('\n') + '\n',
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sous-agents', () => {
  it('finds a sub-agent transcript during a full scan, not only through the watcher', () => {
    // The two disagreed before: chokidar walks the tree and saw them, discoverSessionFiles did not.
    const refs = claudeCode.discoverSessionFiles(root);
    const agent = refs.find((r) => r.sessionId === 'agent-abc123');
    expect(agent).toBeDefined();
    expect(agent?.parentSessionId).toBe(PARENT);
    // And its slug comes from the project directory, not from the word "subagents".
    expect(agent?.slug).toBe(SLUG);
  });

  it('reads the same layout from a path alone, which is all the watcher has', () => {
    const ref = claudeCode.refFromFilePath(join(root, SLUG, PARENT, 'subagents', 'agent-abc123.jsonl'));
    expect(ref.parentSessionId).toBe(PARENT);
    expect(ref.slug).toBe(SLUG);
  });

  it('keeps a sub-agent out of the project thread list, and reachable from its parent', () => {
    claudeCode.ingestAll(db, registry, root);

    const parent = db.getThread(PARENT)!;
    const listed = db.getThreadsForProject(parent.projectId);
    expect(listed.map((t) => t.id)).toEqual([PARENT]);
    expect(db.countThreadsForProject(parent.projectId)).toBe(1);

    const subs = db.getSubThreads(PARENT);
    expect(subs.map((t) => t.id)).toEqual(['agent-abc123']);
    expect(subs[0].parentThreadId).toBe(PARENT);
  });

  it('puts a sub-agent in its parent project rather than classifying it on its own', () => {
    claudeCode.ingestAll(db, registry, root);
    expect(db.getThread('agent-abc123')!.projectId).toBe(db.getThread(PARENT)!.projectId);
  });

  it('does not bill a sub-agent instruction as time somebody spent typing', () => {
    // Its "user" turn is an assistant instructing itself while it got on with something else.
    // Counted as typing, a client pays for minutes no human spent.
    claudeCode.ingestAll(db, registry, root);
    const withSub = db.getActivitySummary({});

    db.raw.prepare("DELETE FROM threads WHERE id = 'agent-abc123'").run();
    const withoutSub = db.getActivitySummary({});

    expect(withSub.totalTypingMs).toBe(withoutSub.totalTypingMs);
    expect(withSub.totalThinkingMs).toBe(withoutSub.totalThinkingMs);
  });
});
