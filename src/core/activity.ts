/**
 * How much human time a conversation represents.
 *
 * The point of this is billing: hours spent on a client's work, recoverable from the transcript
 * months later. So the numbers have to be defensible, and the obvious formula is not.
 *
 * Counting characters and dividing by a typing rate gives, on this corpus, 46.4M characters of
 * user text — 805 days of continuous typing at 40 keystrokes a minute. Wrong by orders of
 * magnitude, because most of those characters were pasted: the median user message is 170
 * characters and the longest is 363,510.
 *
 * Two anchors keep the estimate honest:
 *
 *  1. **Only plausibly-typed text counts.** Fenced code, quoted email, tool-injected wrappers and
 *     the line shapes in NEVER_TYPED are removed before counting — nobody types a 4,000-line log.
 *     This matters less than it looks: 30.2M of the 32.0M characters that survive it sit in
 *     messages the cap below already binds, so sharpening the filter moves the total by 3%. The
 *     cap does the work; this keeps the arithmetic honest for the messages it does not reach.
 *  2. **You cannot have typed for longer than you had.** Each message's typing time is capped by
 *     the wall-clock gap since the previous message in the thread. This is the strong one: it
 *     bounds a guess with something actually observed, and it is what stops a pasted block from
 *     inflating a day into a week.
 *
 * Everything here is an estimate and is labelled as one wherever it surfaces. Thinking time, by
 * contrast, is measured: it is the interval between a message and the reply to it.
 */

/** Keystrokes per minute. Deliberately low — a slow, realistic pace under-bills rather than over-bills. */
export const DEFAULT_KEYSTROKES_PER_MINUTE = 40;

/**
 * Ceiling for a message with no predecessor to measure against (the first of a thread).
 * Five minutes: long enough for a considered opening prompt, short enough that a pasted brief
 * cannot become an hour.
 */
const FIRST_MESSAGE_CAP_MS = 5 * 60_000;

/**
 * Beyond this, a gap is someone having left rather than thinking. Applies to both directions:
 * an assistant reply 6 hours later is a resumed session, not 6 hours of computation.
 */
const ABANDONED_GAP_MS = 30 * 60_000;

/**
 * Lines that nobody types into a prompt, recognised one by one.
 *
 * These catch what the block rules below miss: material pasted with no fence around it, which is
 * how an error or a file usually arrives. Each rule had to be unambiguous before it earned a
 * place, because a rule that eats real prose under-counts the person's own work and makes the
 * figure hard to defend. Measured on this corpus, the set removes 61 hours from 2 029.
 *
 * Two candidates were rejected on that test rather than on taste. A line ending in a semicolon
 * looked like the biggest win at 35 hours, until counting showed 11 659 of the matches were
 * French list items, which end in a semicolon perfectly correctly — requiring code punctuation
 * alongside narrowed it to 15 hours and still misfired. Diff lines were unambiguous but worth one
 * hour, which does not pay for the risk of clipping a phone number written +33.
 */
const NEVER_TYPED: Array<(line: string) => boolean> = [
  // Stack traces, in the shapes Node, Python and Java produce them.
  (l) => /^\s+at \S/.test(l) || /^\s*(File "|Traceback \(|Caused by: )/.test(l),
  // Log lines opening with an ISO timestamp.
  (l) => /^\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(l),
  // A line ending in a brace is code. Prose does not end that way in any language.
  (l) => /[{}]\s*$/.test(l),
];

/**
 * Eighty characters with no space in them: a URL, a hash, a token, a base64 blob. Never typed.
 *
 * Removed on its own rather than through NEVER_TYPED, which drops whole lines. "Voici le lien
 * https://… et dis-moi ce que tu en penses" is a sentence somebody wrote, with one thing in it
 * they pasted; discarding the line would discard the sentence too.
 */
const PASTED_TOKEN = /\S{80,}/g;

/** Text a person plausibly typed, with what they clearly did not removed. */
export function typedCharacters(content: string): number {
  if (!content) return 0;

  const withoutBlocks = content
    // Tool wrappers: never typed by anyone.
    .replace(/<(system-reminder|recommended_plugins|environment_context|uploaded_files|command-name|command-message|command-args|local-command-stdout|ide_selection)\b[\s\S]*?<\/\1>/gi, '')
    // Fenced code and pasted output.
    .replace(/```[\s\S]*?```/g, '')
    // Quoted email or quoted reply — forwarded, not composed.
    .replace(/^>.*$/gm, '')
    // An indented block of four spaces or more is pasted code in markdown.
    .replace(/^(?: {4}|\t).*$/gm, '');

  const typed = withoutBlocks
    .split('\n')
    .filter((line) => !NEVER_TYPED.some((matches) => matches(line)))
    .join('\n')
    .replace(PASTED_TOKEN, '');

  return typed.trim().length;
}

export interface MessageForActivity {
  role: string;
  content: string;
  timestamp: string;
  /** Milliseconds since the previous message in the same thread, or null for the first one. */
  gapMs: number | null;
}

export interface ActivityDurations {
  /** Estimated time spent composing user messages. */
  typingMs: number;
  /** Measured interval between a user message and the reply to it. */
  thinkingMs: number;
}

/**
 * Typing and thinking time for one message.
 *
 * `gapMs` is what the caller observed between this message and the previous one in its thread;
 * it both caps typing (for a user turn) and *is* thinking time (for an assistant turn).
 */
export function durationsForMessage(message: MessageForActivity, keystrokesPerMinute: number): ActivityDurations {
  const rate = keystrokesPerMinute > 0 ? keystrokesPerMinute : DEFAULT_KEYSTROKES_PER_MINUTE;

  if (message.role === 'user') {
    const chars = typedCharacters(message.content);
    const naive = (chars / rate) * 60_000;
    // The cap is the whole point: an estimate that exceeds the time that actually passed is not
    // an estimate, it is arithmetic detached from what happened.
    const available = message.gapMs === null ? FIRST_MESSAGE_CAP_MS : Math.min(message.gapMs, ABANDONED_GAP_MS);
    return { typingMs: Math.min(naive, available), thinkingMs: 0 };
  }

  if (message.role === 'assistant') {
    const gap = message.gapMs ?? 0;
    return { typingMs: 0, thinkingMs: gap > ABANDONED_GAP_MS ? 0 : gap };
  }

  // System and tool turns are neither typed nor thought about.
  return { typingMs: 0, thinkingMs: 0 };
}

/** Which slice of the corpus to measure. Every field is optional; nothing set means everything. */
export interface ActivityScope {
  threadId?: string;
  projectId?: string;
  category?: string;
  startDate?: string;
  endDate?: string;
  /** The person's own typing pace; defaults to DEFAULT_KEYSTROKES_PER_MINUTE. */
  keystrokesPerMinute?: number;
}

interface ActivityBucket {
  typingMs: number;
  thinkingMs: number;
  messages: number;
}

export interface ActivitySummary {
  /** Estimated, and capped by elapsed time — see this module's opening note. */
  totalTypingMs: number;
  /** Measured, not estimated. */
  totalThinkingMs: number;
  messageCount: number;
  /** Turns the person took — what the average below is divided by. */
  promptCount: number;
  /**
   * How many user messages had their estimate cut down by the elapsed-time cap. High is expected
   * and is the point: it says how much of the figure rests on observation rather than on the rate.
   */
  cappedMessageCount: number;
  keystrokesPerMinute: number;
  byDate: Array<ActivityBucket & { date: string }>;
  byHour: Array<ActivityBucket & { hour: number }>;
  byProject: Array<ActivityBucket & { projectId: string; name: string }>;
}

/** Human-readable duration, e.g. "2 h 14 min", "38 min", "45 s". */
export function formatActivityDuration(ms: number): string {
  if (ms < 1000) return '0 s';
  // Test the raw value, not the rounded one: rounding first turned 45 s into "1 min".
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
