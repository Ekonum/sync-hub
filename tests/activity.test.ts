import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYSTROKES_PER_MINUTE,
  durationsForMessage,
  formatActivityDuration,
  typedCharacters,
} from '../src/core/activity.js';

const RATE = DEFAULT_KEYSTROKES_PER_MINUTE; // 40/min

describe('typedCharacters', () => {
  it('counts what someone actually wrote', () => {
    expect(typedCharacters('Bonjour David')).toBe(13);
  });

  it('does not count a pasted code block', () => {
    const content = ['Regarde ce bout :', '```ts', 'const x = 1;'.repeat(200), '```'].join('\n');
    // Only the sentence remains, so the count stays small rather than following the paste.
    expect(typedCharacters(content)).toBeLessThan(40);
  });

  it('does not count a quoted email', () => {
    const content = ['Ma réponse tient en une ligne', '> Bonjour Robin,', '> ' + 'blah '.repeat(300)].join('\n');
    expect(typedCharacters(content)).toBeLessThan(40);
  });

  it('does not count a tool-injected wrapper', () => {
    const content = '<system-reminder>' + 'x'.repeat(5000) + '</system-reminder>\nMa question';
    expect(typedCharacters(content)).toBe('Ma question'.length);
  });

  it('does not count an indented paste', () => {
    const content = ['Voici la trace :', '    at Object.foo (/app/x.js:1:1)'.repeat(50)].join('\n');
    expect(typedCharacters(content)).toBeLessThan(30);
  });

  it('does not count a stack trace pasted with no fence around it', () => {
    // How an error actually arrives in a prompt: pasted bare, no ``` anywhere.
    const trace = Array.from({ length: 30 }, (_, i) => `  at Object.step${i} (/app/src/thing.js:${i}:12)`);
    const content = ['Ça plante, tu peux regarder ?', 'TypeError: cannot read x', ...trace].join('\n');
    expect(typedCharacters(content)).toBeLessThan(60);
  });

  it('does not count bare log output', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `2026-09-08T06:${String(i).padStart(2, '0')}:00Z  requête traitée en 12ms`);
    expect(typedCharacters(['Voilà les logs', ...lines].join('\n'))).toBe('Voilà les logs'.length);
  });

  it('does not count a long unbroken token', () => {
    // A URL, a hash, a base64 blob: eighty characters without a space is never typed.
    const content = 'Le lien https://example.com/' + 'a'.repeat(200) + ' te dira tout';
    // The sentence survives; only the token goes. Dropping the whole line would drop the sentence.
    expect(typedCharacters(content)).toBe('Le lien  te dira tout'.length);
  });

  it('still counts French prose that merely looks structured', () => {
    // The rules that would have caught these were dropped on purpose: a French list item ends in
    // a semicolon quite correctly, and a phone number starts with a plus. Under-counting the
    // person's own writing is the failure mode that makes the billing figure indefensible.
    const content = [
      'Trois choses à faire :',
      '- reprendre le calendrier ;',
      '- vérifier les 44 divergences ;',
      '- rappeler au +33 6 12 34 56 78.',
    ].join('\n');
    expect(typedCharacters(content)).toBe(content.length);
  });
});

describe('durationsForMessage — typing', () => {
  const user = (content: string, gapMs: number | null) =>
    durationsForMessage({ role: 'user', content, timestamp: '2026-09-03T10:00:00Z', gapMs }, RATE);

  it('estimates from the rate when there was time to spare', () => {
    // 40 characters at 40/min = one minute, and two minutes were available.
    const d = user('x'.repeat(40), 2 * 60_000);
    expect(d.typingMs).toBeCloseTo(60_000, -2);
  });

  it('never claims more typing than the time that actually passed', () => {
    // 4,000 characters would be 100 minutes; only 30 seconds elapsed. This is the anchor that
    // takes the corpus estimate from 13,198 hours to a plausible 2,012.
    const d = user('mot '.repeat(1000), 30_000);
    expect(d.typingMs).toBe(30_000);
  });

  it('treats a long silence as absence, not as an hour of typing', () => {
    const d = user('mot '.repeat(25_000), 6 * 60 * 60_000);
    expect(d.typingMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it('caps the first message of a thread, which has nothing to measure against', () => {
    const d = user('mot '.repeat(25_000), null);
    expect(d.typingMs).toBe(5 * 60_000);
  });

  it('charges nothing for a message that was entirely pasted', () => {
    const d = user('```\n' + 'y'.repeat(9000) + '\n```', 10 * 60_000);
    expect(d.typingMs).toBe(0);
  });

  it('falls back to the default rate rather than dividing by zero', () => {
    const d = durationsForMessage({ role: 'user', content: 'x'.repeat(40), timestamp: 'x', gapMs: 60_000 }, 0);
    expect(Number.isFinite(d.typingMs)).toBe(true);
    expect(d.typingMs).toBeGreaterThan(0);
  });
});

describe('durationsForMessage — thinking', () => {
  const assistant = (gapMs: number | null) =>
    durationsForMessage({ role: 'assistant', content: 'réponse', timestamp: '2026-09-03T10:00:00Z', gapMs }, RATE);

  it('is the measured interval before the reply', () => {
    expect(assistant(12_000).thinkingMs).toBe(12_000);
  });

  it('is not counted at all when the session was clearly resumed later', () => {
    // A reply six hours later is someone coming back, not six hours of computation.
    expect(assistant(6 * 60 * 60_000).thinkingMs).toBe(0);
  });

  it('never doubles as typing', () => {
    expect(assistant(12_000).typingMs).toBe(0);
  });
});

describe('other roles', () => {
  it('charges nothing for system or tool turns', () => {
    for (const role of ['system', 'tool']) {
      const d = durationsForMessage({ role, content: 'x'.repeat(500), timestamp: 'x', gapMs: 60_000 }, RATE);
      expect(d).toEqual({ typingMs: 0, thinkingMs: 0 });
    }
  });
});

describe('formatActivityDuration', () => {
  it('reads the way someone would say it', () => {
    expect(formatActivityDuration(0)).toBe('0 s');
    expect(formatActivityDuration(45_000)).toBe('45 s');
    expect(formatActivityDuration(38 * 60_000)).toBe('38 min');
    expect(formatActivityDuration(2 * 3_600_000)).toBe('2 h');
    expect(formatActivityDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2 h 14 min');
  });
});
