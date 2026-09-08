import { createHash } from 'node:crypto';
import type { MessageRole, ToolCall, ToolResult } from '../types.js';

/**
 * The single anti-duplicate-ingestion key, shared by every adapter (enforced as messages.hash
 * UNIQUE).
 *
 * It must identify a message's *place in a conversation*, not merely its text. An earlier version
 * hashed only role, content, thought and tool fields, on the reasoning that identical content is
 * the same message. It is not: across this corpus the word "Oui" appeared exactly once in 197 893
 * messages and 5 456 threads, "Ok" once, "Continue" once. Every later time the same short answer
 * was typed, the UNIQUE constraint rejected it and the turn was lost — 14 of 104 turns in one
 * thread alone, and the gap it left is visible in the dashboard as two headers with nothing
 * between them. A verbatim archive that silently drops "Oui" is not a verbatim archive.
 *
 * So thread and timestamp are part of the key. Re-reading a file still dedups exactly as before —
 * same thread, same instant, same text — and so does the same message arriving both by local
 * ingestion and by a remote push, which is what this guards.
 *
 * `thought` is included for a related reason: a reasoning-only turn has empty content, so without
 * the reasoning text two genuinely different ones in a thread collide.
 */
export function computeMessageHash(message: {
  /** The conversation this turn belongs to. */
  threadId: string;
  /** When it happened — what separates two identical answers in the same thread. */
  timestamp: string;
  role: MessageRole;
  content: string;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}): string {
  const payload = JSON.stringify({
    threadId: message.threadId,
    timestamp: message.timestamp,
    role: message.role,
    content: message.content,
    thought: message.thought,
    toolCalls: message.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })),
    toolResults: message.toolResults?.map((r) => ({ name: r.name, output: r.output.slice(0, 500) })),
  });
  return createHash('sha256').update(payload).digest('hex');
}
