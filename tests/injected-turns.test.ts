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
const SESSION = 'session-injected';

const evt = (o: Record<string, unknown>) => JSON.stringify(o);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sync-hub-injected-'));
  root = join(dir, 'projects');
  db = new Db(join(dir, 'hub.sqlite'));
  registry = new ProjectRegistry(db);
  mkdirSync(join(root, SLUG), { recursive: true });

  writeFileSync(
    join(root, SLUG, `${SESSION}.jsonl`),
    [
      evt({ type: 'user', uuid: 'u1', timestamp: '2026-09-08T10:00:00.000Z', message: { role: 'user', content: 'Ma vraie question' } }),
      // How a skill body arrives: the person's slot, filled by the tool, flagged isMeta.
      evt({
        type: 'user', uuid: 'u2', isMeta: true, timestamp: '2026-09-08T10:00:01.000Z',
        message: { role: 'user', content: 'Approach this as the design lead at a small studio. '.repeat(200) },
      }),
      evt({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-08T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Ma réponse' }] } }),
    ].join('\n') + '\n',
  );
  claudeCode.ingestAll(db, registry, root);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tours injectés', () => {
  it('keeps the injected turn verbatim — it is part of what was sent', () => {
    const injected = db.getMessagesForThread(SESSION).filter((m) => m.isInjected);
    expect(injected).toHaveLength(1);
    expect(injected[0].content).toContain('Approach this as the design lead');
    expect(injected[0].content.length).toBeGreaterThan(9000);
  });

  it('does not count it as a prompt the person wrote', () => {
    const thread = db.getThread(SESSION)!;
    expect(thread.promptCount).toBe(1); // the real question, not the skill body
    expect(thread.messageCount).toBe(3); // everything is still stored
  });

  it('does not bill eleven thousand characters as time somebody spent typing', () => {
    const withInjected = db.getActivitySummary({ threadId: SESSION });

    db.raw.prepare("UPDATE messages SET is_injected = 0 WHERE id = 'u2'").run();
    const asIfTyped = db.getActivitySummary({ threadId: SESSION });

    expect(asIfTyped.totalTypingMs).toBeGreaterThan(withInjected.totalTypingMs);
  });

  it('leaves a genuinely typed turn alone', () => {
    const typed = db.getMessagesForThread(SESSION).find((m) => m.content === 'Ma vraie question')!;
    expect(typed.isInjected).toBeUndefined();
  });
});
