import { describe, expect, it } from 'vitest';
import { computeMessageHash } from '../src/core/hash.js';

/** A turn in thread `t1` at a fixed instant, with only what each test varies overridden. */
const turn = (o: Partial<Parameters<typeof computeMessageHash>[0]> = {}) =>
  computeMessageHash({ threadId: 't1', timestamp: '2026-09-08T10:00:00.000Z', role: 'user', content: 'bonjour', ...o });

describe('computeMessageHash', () => {
  it('is deterministic for identical input', () => {
    expect(turn()).toBe(turn());
  });

  it('differs when content differs', () => {
    expect(turn({ content: 'a' })).not.toBe(turn({ content: 'b' }));
  });

  it('lets the same answer be typed twice in one conversation', () => {
    // The failure this replaces: hashing content alone meant "Oui" existed exactly once in the
    // whole store — 197 893 messages, 5 456 threads — every later one rejected by the UNIQUE
    // constraint and lost. A verbatim archive cannot drop the second "Oui".
    const first = turn({ content: 'Oui', timestamp: '2026-09-08T10:00:00.000Z' });
    const later = turn({ content: 'Oui', timestamp: '2026-09-08T11:42:00.000Z' });
    expect(first).not.toBe(later);
  });

  it('lets the same answer be typed in two different conversations', () => {
    expect(turn({ content: 'Oui', threadId: 't1' })).not.toBe(turn({ content: 'Oui', threadId: 't2' }));
  });

  it('still recognises the same turn read twice, which is what it is for', () => {
    // Re-reading a file, or the same message arriving both by local ingestion and by a remote
    // push: same thread, same instant, same text. That must still collapse to one row.
    expect(turn({ content: 'Oui' })).toBe(turn({ content: 'Oui' }));
  });

  it('differs when only `thought` differs, even with identical (empty) role+content — the exact bug this session found in Codex/ChatGPT reasoning-only turns', () => {
    const h1 = turn({ role: 'assistant', content: '', thought: 'première réflexion' });
    const h2 = turn({ role: 'assistant', content: '', thought: 'deuxième réflexion, complètement différente' });
    expect(h1).not.toBe(h2);
  });

  it('a thought-only message never collides with a genuinely empty message', () => {
    const withThought = turn({ role: 'assistant', content: '', thought: 'je réfléchis' });
    const empty = turn({ role: 'assistant', content: '', thought: undefined });
    expect(withThought).not.toBe(empty);
  });
});
