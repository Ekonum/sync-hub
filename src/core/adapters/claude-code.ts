import { createHash } from 'node:crypto';
import { existsSync, readdirSync} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Db } from '../db.js';
import type { ProjectRegistry } from '../registry.js';
import { computeMessageHash } from '../hash.js';
import { ensureChatGptProject, loadChatGptProjectNames } from './chatgpt-export.js';
import { UNASSIGNED_PROJECT_ID, type Message, type MessageRole, type Thread, type ToolCall, type ToolResult, type TokenUsage } from '../../types.js';
import { readJsonlFrom } from '../jsonl-tail.js';
import { deriveThreadTitle } from '../thread-title.js';

export const CLAUDE_CODE_STORAGE_ROOT = join(homedir(), '.claude', 'projects');

// Claude Code can be launched directly inside Codex's own ChatGPT-Project cache mirror
// (~/.codex/.chatgpt-projects/g-p-<id>/) — real find: a session there landed in "unassigned"
// because Claude Code's own slug encoding turns BOTH "/" and a leading "." into "-" (so
// ".codex/.chatgpt-projects/" becomes "--codex--chatgpt-projects-", not the single-dash form
// sync-hub's own pathToClaudeSlug produces for a path with no dots in it — the two only diverge
// when a path segment starts with ".", which no real registered project path does, so this went
// unnoticed elsewhere). Detected directly off the slug rather than fixing pathToClaudeSlug's
// general transform, since only this one dotted-path case is confirmed to actually occur.
const CHATGPT_PROJECT_CACHE_SLUG = /--codex--chatgpt-projects-(g-p-[a-zA-Z0-9]+)(?:-|$)/;

function resolveClaudeSlug(db: Db, registry: ProjectRegistry, slug: string, chatGptProjectsCacheRoot?: string): string {
  const cacheMatch = slug.match(CHATGPT_PROJECT_CACHE_SLUG);
  if (cacheMatch) {
    const templateId = cacheMatch[1];
    const name = loadChatGptProjectNames(chatGptProjectsCacheRoot).get(templateId) ?? templateId;
    return ensureChatGptProject(db, templateId, name, new Date().toISOString());
  }
  return registry.resolveByClaudeSlug(slug);
}

export interface SessionFileRef {
  filePath: string;
  /** Directory name under .claude/projects — Claude Code's own slug for the project path. */
  slug: string;
  sessionId: string;
  /**
   * For a sub-agent transcript, the session that spawned it.
   *
   * Claude Code writes a sub-agent's conversation to its own file, in a `subagents/` folder beside
   * the session that started it: `<slug>/<session>/subagents/agent-<id>.jsonl`. Read as an ordinary
   * session — which is what happened until this — each one becomes a separate conversation in the
   * dashboard, titled with the instruction the assistant gave it, and lands in whatever project the
   * directory name "subagents" happens to resolve to, which is none.
   */
  parentSessionId?: string;
}

/**
 * Reads the layout of a Claude Code transcript path.
 *
 * Two shapes exist: `<slug>/<session>.jsonl` for a conversation, and
 * `<slug>/<session>/subagents/agent-<id>.jsonl` for a sub-agent one of its turns started. The
 * slug is what resolves the project, so for a sub-agent it has to be read from the grandparent
 * rather than from the immediate directory — otherwise the project is decided by the literal word
 * "subagents".
 */
function refFromParts(filePath: string): SessionFileRef {
  const sessionId = basename(filePath, '.jsonl');
  const dir = dirname(filePath);
  if (basename(dir) === SUBAGENT_DIR) {
    const parentDir = dirname(dir);
    return { filePath, slug: basename(dirname(parentDir)), sessionId, parentSessionId: basename(parentDir) };
  }
  return { filePath, slug: basename(dir), sessionId };
}

const SUBAGENT_DIR = 'subagents';

/** Event types in Claude Code's JSONL that carry no conversational content — UI/session bookkeeping. */
const NON_MESSAGE_TYPES = new Set([
  'attachment',
  'system',
  'mode',
  'last-prompt',
  'ai-title',
  'custom-title',
  'queue-operation',
  'frame-link',
]);

export function discoverSessionFiles(root: string = CLAUDE_CODE_STORAGE_ROOT): SessionFileRef[] {
  if (!existsSync(root)) return [];
  const refs: SessionFileRef[] = [];
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    let entries: string[];
    try {
      entries = readdirSync(slugDir);
    } catch {
      continue;
    }
    for (const file of entries.filter((f) => f.endsWith('.jsonl'))) {
      refs.push({ filePath: join(slugDir, file), slug, sessionId: basename(file, '.jsonl') });
    }
    // A session with sub-agents gets a folder of its own name holding them. The watcher already
    // saw these files (it walks the tree); a full scan did not, so the two disagreed about what
    // exists — which is how six sub-agents came to be conversations only the watcher had heard of.
    for (const entry of entries) {
      const subagentDir = join(slugDir, entry, SUBAGENT_DIR);
      let agents: string[];
      try {
        agents = readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of agents) {
        refs.push({ filePath: join(subagentDir, file), slug, sessionId: basename(file, '.jsonl'), parentSessionId: entry });
      }
    }
  }
  return refs;
}

interface ParsedLine {
  role: MessageRole;
  content: string;
  /** True when Claude Code marked the event `isMeta` — see the `user` branch of parseLine. */
  isInjected?: boolean;
  thought?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: string;
  uuid: string;
  model?: string;
  usage?: TokenUsage;
}

/**
 * Claude Code's own `usage` object on an assistant event, mapped to the shared TokenUsage shape —
 * verified against real sessions: `cache_creation` already splits 5-minute vs 1-hour writes, so
 * both are captured exactly rather than assumed. `model: "<synthetic>"` marks an event Claude Code
 * generated itself (no real API call, no real usage) — never priced, so it's dropped entirely
 * rather than kept as a model id with no matching price.
 */
function usageFromClaudeCodeMessage(message: any): { model?: string; usage?: TokenUsage } {
  const model = typeof message?.model === 'string' && message.model !== '<synthetic>' ? message.model : undefined;
  const rawUsage = message?.usage;
  if (!model || !rawUsage) return { model };
  const usage: TokenUsage = {
    inputTokens: rawUsage.input_tokens ?? 0,
    outputTokens: rawUsage.output_tokens ?? 0,
    cacheCreation5mInputTokens: rawUsage.cache_creation?.ephemeral_5m_input_tokens || undefined,
    cacheCreation1hInputTokens: rawUsage.cache_creation?.ephemeral_1h_input_tokens || undefined,
    cacheReadInputTokens: rawUsage.cache_read_input_tokens || undefined,
  };
  return { model, usage };
}

/** Parses one raw JSONL line. Returns null for non-conversational event types (system/UI bookkeeping). */
export function parseLine(rawLine: string): ParsedLine | null {
  const line = rawLine.trim();
  if (!line) return null;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const type = event.type;
  if (NON_MESSAGE_TYPES.has(type)) return null;
  if (type !== 'user' && type !== 'assistant') return null;

  const content = event.message?.content;
  const timestamp = event.timestamp ?? new Date(0).toISOString();
  const uuid = event.uuid ?? createHash('sha256').update(line).digest('hex').slice(0, 16);

  if (typeof content === 'string') {
    // A turn in the person's own slot — which is not the same as a turn the person wrote.
    //
    // Claude Code delivers injected material this way too: a skill body, the caveat banner before
    // a resumed session, an image placeholder. It marks each one `isMeta`, and that flag is
    // reliable here — across this corpus it covers 58 events, every one of them injected, and no
    // typed prompt carries it. Without it, an 11 687-character skill sat in the transcript looking
    // exactly like something Robin had written.
    return { role: 'user', content, timestamp, uuid, isInjected: event.isMeta === true };
  }

  if (!Array.isArray(content)) return null;

  if (type === 'user') {
    // Tool results are delivered as type:"user" events with tool_result blocks in this schema.
    const toolResults: ToolResult[] = [];
    const textParts: string[] = [];
    for (const block of content) {
      if (block?.type === 'tool_result') {
        toolResults.push({
          toolCallId: block.tool_use_id,
          name: block.tool_use_id, // Claude Code doesn't echo the tool name on the result block; id is the join key.
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          status: block.is_error ? 'error' : 'success',
        });
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (toolResults.length === 0 && textParts.length === 0) return null;
    return {
      role: toolResults.length > 0 && textParts.length === 0 ? 'tool' : 'user',
      content: textParts.join('\n'),
      toolResults: toolResults.length ? toolResults : undefined,
      timestamp,
      uuid,
    };
  }

  // type === 'assistant'
  const textParts: string[] = [];
  const thoughtParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
      thoughtParts.push(block.thinking);
    } else if (block?.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
    }
  }
  if (textParts.length === 0 && thoughtParts.length === 0 && toolCalls.length === 0) return null;
  return {
    role: 'assistant',
    content: textParts.join('\n'),
    thought: thoughtParts.length ? thoughtParts.join('\n') : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    timestamp,
    uuid,
    ...usageFromClaudeCodeMessage(event.message),
  };
}

const deriveTitle = deriveThreadTitle;

/**
 * Claude Code lets a session carry a real title distinct from the raw first prompt — an
 * AI-suggested one (`ai-title` events) and, when the user explicitly renames the conversation in
 * the Claude Code UI, a `custom-title` event that overrides it. Both are re-emitted repeatedly
 * across the file (verified on real sessions — dozens of identical repeats), so only the last of
 * each matters; custom (user-authored) wins over ai-suggested when both are present. These events
 * used to be skipped purely as non-conversational, with sync-hub deriving its own title from the
 * first ~80 chars of the raw first prompt instead — discarding a title the user may have
 * deliberately set. Real find: "Processus mise à jour Ekonum" (set via custom-title) was never
 * used; the derived title was a mangled prefix of an unrelated instruction paragraph, and search
 * for the real title then found nothing.
 */
function extractRealTitle(lines: string[]): string | undefined {
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim()) aiTitle = event.aiTitle.trim();
    else if (event.type === 'custom-title' && typeof event.customTitle === 'string' && event.customTitle.trim()) customTitle = event.customTitle.trim();
  }
  return customTitle ?? aiTitle;
}

/**
 * Full ingestion of one session file: resolves its project via the Claude-Code-native slug
 * (never guessed), upserts the thread, and inserts every message (hash-deduped, so re-running
 * this on an already-ingested file is a no-op).
 */
export function ingestSessionFile(
  db: Db,
  registry: ProjectRegistry,
  ref: SessionFileRef,
  opts: { fromOffset?: number; projectIdOverride?: string; chatGptProjectsCacheRoot?: string } = {},
): number {
  const raw = readJsonlFrom(ref.filePath, opts.fromOffset);
  if (raw === null) {
    db.logIngestEvent({
      engine: 'claude-code',
      filePath: ref.filePath,
      eventType: opts.fromOffset ? 'watch_tail' : 'full_scan',
      status: 'error',
      message: 'unreadable',
      timestamp: new Date().toISOString(),
    });
    return 0;
  }

  const lines = raw.split('\n');
  // Cowork sessions pass an override here: their slug is derived from a VM-sandboxed cwd and is
  // meaningless for project resolution — the real signal is the user-selected folder, if any.
  const defaultProjectId = opts.projectIdOverride ?? resolveClaudeSlug(db, registry, ref.slug, opts.chatGptProjectsCacheRoot);
  const existingThread = db.getThread(ref.sessionId);
  // A sub-agent belongs wherever its parent belongs. Resolving it on its own would classify it by
  // the instruction it was given, which describes a task, not a project.
  const parentProjectId = ref.parentSessionId ? db.getThread(ref.parentSessionId)?.projectId : undefined;
  const projectId =
    existingThread && existingThread.projectId !== UNASSIGNED_PROJECT_ID
      ? existingThread.projectId
      : (parentProjectId && parentProjectId !== UNASSIGNED_PROJECT_ID ? parentProjectId : defaultProjectId);
  let sequence = existingThread ? db.getMessagesForThread(ref.sessionId).length : 0;
  let firstUserContent: string | undefined;
  let inserted = 0;
  let latestTimestamp = existingThread?.updatedAt;

  if (!existingThread) {
    // messages.thread_id is a foreign key — the thread row must exist before any message does.
    const now = new Date().toISOString();
    db.upsertThread({
      id: ref.sessionId,
      projectId,
      title: `Session ${ref.sessionId.slice(0, 8)}`,
      originEngine: 'claude-code',
      engineIds: { 'claude-code': ref.sessionId },
      sourceRef: ref.slug,
      sourceFilePath: ref.filePath,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      parentThreadId: ref.parentSessionId,
    } as Thread);
  }

  for (const rawLine of lines) {
    const parsed = parseLine(rawLine);
    if (!parsed) continue;
    if (parsed.role === 'user' && firstUserContent === undefined) firstUserContent = parsed.content;

    const hash = computeMessageHash({
      threadId: ref.sessionId, timestamp: parsed.timestamp, role: parsed.role,
      content: parsed.content, thought: parsed.thought, toolCalls: parsed.toolCalls, toolResults: parsed.toolResults,
    });
    const message: Message = {
      id: parsed.uuid,
      threadId: ref.sessionId,
      projectId,
      sourceEngine: 'claude-code',
      role: parsed.role,
      content: parsed.content,
      thought: parsed.thought,
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
      timestamp: parsed.timestamp,
      sequence: sequence++,
      hash,
      model: parsed.model,
      usage: parsed.usage,
      isInjected: parsed.isInjected,
    };
    if (db.insertMessage(message)) inserted++;
    latestTimestamp = parsed.timestamp;
  }

  const now = new Date().toISOString();
  db.upsertThread({
    id: ref.sessionId,
    projectId,
    title: extractRealTitle(lines) ?? existingThread?.title ?? deriveTitle(firstUserContent, ref.sessionId),
    originEngine: 'claude-code',
    engineIds: { 'claude-code': ref.sessionId },
    sourceRef: ref.slug,
      sourceFilePath: ref.filePath,
    messageCount: sequence,
    createdAt: existingThread?.createdAt ?? latestTimestamp ?? now,
    updatedAt: latestTimestamp ?? now,
    status: 'active',
    parentThreadId: ref.parentSessionId,
  } as Thread);

  if (projectId) db.touchProjectActivity(projectId, latestTimestamp ?? now);

  db.logIngestEvent({
    engine: 'claude-code',
    filePath: ref.filePath,
    eventType: opts.fromOffset ? 'watch_tail' : 'full_scan',
    status: 'ok',
    message: `${inserted} nouveau(x) message(s)`,
    timestamp: now,
  });

  return inserted;
}

export function ingestAll(
  db: Db,
  registry: ProjectRegistry,
  root: string = CLAUDE_CODE_STORAGE_ROOT,
  chatGptProjectsCacheRoot?: string,
): number {
  let total = 0;
  for (const ref of discoverSessionFiles(root)) {
    total += ingestSessionFile(db, registry, ref, { chatGptProjectsCacheRoot });
  }
  return total;
}

export function storageRootExists(root: string = CLAUDE_CODE_STORAGE_ROOT): boolean {
  return existsSync(root);
}

// Re-exported for the watch engine, which needs to know a file's slug from its path alone.
export function refFromFilePath(filePath: string): SessionFileRef {
  return refFromParts(filePath);
}
