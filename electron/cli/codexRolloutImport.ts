import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nanoid } from "nanoid";
import { getDb } from "./db.js";
import {
  createConversation,
  getConversation,
  type Conversation
} from "./conversations.js";
import { saveToolSession } from "./store.js";
import type { AcpStreamItem } from "./acp.js";

/**
 * Imports a Codex CLI/Desktop session rollout file
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`) into a
 * FreeBuddy conversation so the full transcript is visible and resumable.
 *
 * The rollout JSONL is a stream of `{ timestamp, type, payload }` lines. We
 * reconstruct turns from `event_msg` user messages and build assistant message
 * bodies (serialized `AcpStreamItem[]`, the same shape the live codex-acp
 * stream produces) from the `response_item` transcript entries.
 */

const SOURCE_ADAPTER = "codex-rollout";
const CODEX_AGENT_ID = "cli-codex-acp";
const CODEX_AGENT_NAME = "Codex";
const CODEX_ADAPTER = "codex-acp";
const MAX_OUTPUT_CHARS = 50_000;

export interface ImportCodexSessionResult {
  conversation: Conversation;
  created: boolean;
  rolloutPath: string;
  turns: number;
  messages: number;
  warning?: string;
}

export function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), ".codex");
}

/** Recursively locate `rollout-*<sessionId>.jsonl` under `<codexHome>/sessions`. */
export function findRolloutFile(
  sessionId: string,
  codexHome: string = resolveCodexHome()
): string | undefined {
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsRoot)) return undefined;
  const suffix = `-${sessionId}.jsonl`;
  const stack: string[] = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.endsWith(suffix)
      ) {
        return full;
      }
    }
  }
  return undefined;
}

interface RolloutEvent {
  ts: number;
  iso: string;
  payload: any;
}

interface ParsedRollout {
  sessionMeta: any | undefined;
  /** User turns, in order. Each marks the start of a turn window. */
  userTurns: { ts: number; iso: string; text: string }[];
  responseItems: RolloutEvent[];
  threadTitle: string | undefined;
}

function tryParseLine(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function toMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function readThreadTitle(
  sessionId: string,
  codexHome: string
): string | undefined {
  const indexFile = path.join(codexHome, "session_index.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(indexFile, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split(/\r?\n/)) {
    const obj = tryParseLine(line);
    if (obj && (obj.id === sessionId || obj.session_id === sessionId)) {
      const name = obj.thread_name ?? obj.name ?? obj.title;
      if (typeof name === "string" && name.trim()) return name.trim();
    }
  }
  return undefined;
}

function parseRollout(filePath: string, codexHome: string): ParsedRollout {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  let sessionMeta: any | undefined;
  const userTurns: ParsedRollout["userTurns"] = [];
  const responseItems: ParsedRollout["responseItems"] = [];

  for (const line of lines) {
    if (!line) continue;
    const obj = tryParseLine(line);
    if (!obj) continue;
    const iso: string | undefined = obj.timestamp;
    const ts = toMs(iso);
    const type: string = obj.type ?? "";
    const payload = obj.payload;

    if (type === "session_meta") {
      if (!sessionMeta) sessionMeta = payload;
      continue;
    }
    if (!payload || typeof payload !== "object") continue;

    if (type === "event_msg") {
      const ptype: string = payload.type ?? "";
      if (ptype === "user_message") {
        const text = typeof payload.message === "string" ? payload.message : "";
        userTurns.push({ ts, iso: iso ?? new Date(ts).toISOString(), text });
      }
      // agent_message is intentionally ignored: the matching assistant text
      // is reconstructed from response_item messages with full tool detail.
      continue;
    }
    if (type === "response_item") {
      responseItems.push({ ts, iso: iso ?? new Date(ts).toISOString(), payload });
    }
  }

  return {
    sessionMeta,
    userTurns,
    responseItems,
    threadTitle: readThreadTitle(
      sessionMeta?.session_id ?? sessionMeta?.id ?? "",
      codexHome
    )
  };
}

function safeParseArgs(argsStr: unknown): unknown {
  if (typeof argsStr !== "string") return argsStr;
  try {
    return JSON.parse(argsStr);
  } catch {
    return argsStr;
  }
}

/**
 * exec_command outputs are wrapped with bookkeeping metadata. Extract the real
 * payload following the `Output:\n---\n` marker when present.
 */
function extractExecOutput(raw: string): string {
  const marker = "\nOutput:\n---\n";
  const idx = raw.indexOf(marker);
  let body = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  // Strip a trailing `\n---\nChunk ID: ...` continuation marker if present.
  const tail = body.indexOf("\n---\nChunk ID:");
  if (tail >= 0) body = body.slice(0, tail);
  return body;
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`;
}

type OutputEntry = { output: string; isError: boolean };

/** Index tool outputs by call_id so calls can attach their result inline. */
function indexOutputs(responseItems: RolloutEvent[]): Map<string, OutputEntry> {
  const byCallId = new Map<string, OutputEntry>();
  for (const { payload } of responseItems) {
    const ptype: string = payload?.type ?? "";
    if (
      ptype === "function_call_output" ||
      ptype === "custom_tool_call_output"
    ) {
      const callId: string | undefined =
        payload.call_id ?? payload.callId ?? payload.id;
      const output =
        typeof payload.output === "string"
          ? payload.output
          : typeof payload.content === "string"
            ? payload.content
            : "";
      if (callId) {
        byCallId.set(callId, { output, isError: payload.is_error === true });
      }
    }
  }
  return byCallId;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : ""
    )
    .join("");
}

/** Build the serialized assistant body for the response_items in a turn window. */
function buildAssistantItems(
  windowItems: RolloutEvent[],
  outputs: Map<string, OutputEntry>
): AcpStreamItem[] {
  const items: AcpStreamItem[] = [];
  for (const { payload } of windowItems) {
    const ptype: string = payload?.type ?? "";
    if (ptype === "reasoning") {
      const summary = payload.summary;
      if (Array.isArray(summary)) {
        for (const s of summary) {
          const text =
            s && typeof s === "object" && typeof s.text === "string"
              ? s.text
              : typeof s === "string"
                ? s
                : "";
          if (text.trim()) items.push({ kind: "thinking", content: text });
        }
      }
      continue;
    }
    if (ptype === "message") {
      if (payload.role === "assistant") {
        const text = textFromContent(payload.content).trim();
        if (text) items.push({ kind: "text", role: "assistant", content: text });
      }
      // user/developer/system messages are injected context — skip.
      continue;
    }
    if (ptype === "function_call" || ptype === "custom_tool_call") {
      const name: string = payload.name ?? payload.tool ?? "tool";
      const callId: string | undefined =
        payload.call_id ?? payload.callId ?? payload.id;
      const rawArgs =
        ptype === "custom_tool_call" ? payload.input : payload.arguments;
      const input = safeParseArgs(rawArgs);

      if (name === "exec_command" || name === "shell") {
        const cmd =
          typeof input === "object" && input && "cmd" in input
            ? String((input as any).cmd ?? "")
            : typeof input === "string"
              ? input
              : "";
        const cwd =
          typeof input === "object" &&
          input &&
          ("workdir" in input || "cwd" in input)
            ? String((input as any).workdir ?? (input as any).cwd ?? "")
            : undefined;
        items.push({ kind: "command", command: cmd, ...(cwd ? { cwd } : {}) });
        const out = callId ? outputs.get(callId) : undefined;
        if (out) {
          items.push({
            kind: "command-output",
            content: truncateOutput(extractExecOutput(out.output))
          });
        }
        continue;
      }

      items.push({
        kind: "tool-call",
        tool: name,
        input,
        ...(callId ? { id: callId } : {}),
        status: "completed"
      });
      const out = callId ? outputs.get(callId) : undefined;
      if (out) {
        items.push({
          kind: "tool-result",
          tool: name,
          ...(callId ? { id: callId } : {}),
          content: truncateOutput(out.output),
          isError: out.isError
        });
      }
    }
  }
  return items;
}

function deriveTitle(
  threadTitle: string | undefined,
  firstUserText: string | undefined,
  sessionId: string
): string {
  if (threadTitle) return threadTitle.slice(0, 120);
  const text = (firstUserText ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 48);
  return `Codex ${sessionId.slice(0, 8)}`;
}

interface TurnPlan {
  userIso: string | undefined;
  userText: string;
  assistantIso: string;
  items: AcpStreamItem[];
}

function planTurns(parsed: ParsedRollout): TurnPlan[] {
  const { userTurns, responseItems } = parsed;
  const outputs = indexOutputs(responseItems);
  const turns: TurnPlan[] = [];

  if (userTurns.length === 0) {
    // No user turns recorded: fold everything into a single assistant turn.
    const items = buildAssistantItems(responseItems, outputs);
    const iso =
      responseItems[0]?.iso ?? new Date(Date.now()).toISOString();
    if (items.length) {
      turns.push({
        userIso: undefined,
        userText: "",
        assistantIso: iso,
        items
      });
    }
    return turns;
  }

  for (let i = 0; i < userTurns.length; i++) {
    const start = userTurns[i].ts;
    const end =
      i + 1 < userTurns.length ? userTurns[i + 1].ts : Number.POSITIVE_INFINITY;
    const windowItems = responseItems.filter(
      (r) => r.ts >= start && r.ts < end
    );
    const items = buildAssistantItems(windowItems, outputs);
    turns.push({
      userIso: userTurns[i].iso,
      userText: userTurns[i].text,
      assistantIso:
        windowItems[0]?.iso ?? userTurns[i].iso,
      items
    });
  }
  return turns;
}

function insertMessageRow(row: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  status: string;
  content: string;
  agentId: string;
  agentName: string;
  adapter: string;
  iso: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_messages
         (id, conversation_id, role, status, content, attachments, task_id,
          agent_id, agent_name, adapter, role_label,
          workflow_run_id, workflow_step_row_id, author_username,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`
    )
    .run(
      row.id,
      row.conversationId,
      row.role,
      row.status,
      row.content,
      row.agentId,
      row.agentName,
      row.adapter,
      row.iso,
      row.iso
    );
}

export function importCodexSession(
  sessionId: string
): ImportCodexSessionResult {
  const trimmedId = sessionId.trim();
  if (!trimmedId) throw new Error("A session id is required.");

  const codexHome = resolveCodexHome();
  const rolloutPath = findRolloutFile(trimmedId, codexHome);
  if (!rolloutPath) {
    throw new Error(
      `No Codex rollout file found for session ${trimmedId} under ${path.join(
        codexHome,
        "sessions"
      )}.`
    );
  }

  // Idempotency: a conversation already imported from this rollout is returned
  // as-is instead of being duplicated.
  const existing = getDb()
    .prepare(
      `SELECT id FROM conversations
       WHERE source_conversation_id = ? AND source_adapter = ?`
    )
    .get(trimmedId, SOURCE_ADAPTER) as { id: string } | undefined;
  if (existing) {
    const conversation = getConversation(existing.id);
    if (conversation) {
      return {
        conversation,
        created: false,
        rolloutPath,
        turns: 0,
        messages: 0
      };
    }
  }

  const parsed = parseRollout(rolloutPath, codexHome);
  const turns = planTurns(parsed);
  const nonEmptyTurns = turns.filter(
    (t) => t.userText.trim() || t.items.length
  );

  const cwd =
    typeof parsed.sessionMeta?.cwd === "string"
      ? parsed.sessionMeta.cwd
      : undefined;
  const title = deriveTitle(
    parsed.threadTitle,
    nonEmptyTurns[0]?.userText,
    trimmedId
  );
  const firstIso =
    nonEmptyTurns[0]?.userIso ??
    nonEmptyTurns[0]?.assistantIso ??
    new Date().toISOString();
  const lastIso =
    nonEmptyTurns[nonEmptyTurns.length - 1]?.assistantIso ?? firstIso;

  const conversationId = nanoid();
  let warning: string | undefined;

  const result = getDb().transaction(() => {
    const conversation = createConversation({
      id: conversationId,
      title,
      agentId: CODEX_AGENT_ID,
      agentName: CODEX_AGENT_NAME,
      adapter: CODEX_ADAPTER,
      cwd,
      approvalMode: "auto",
      titleSource: parsed.threadTitle ? "agent" : "prompt",
      sourceConversationId: trimmedId,
      sourceAdapter: SOURCE_ADAPTER,
      sourceAgentName: CODEX_AGENT_NAME
    });

    let messageCount = 0;
    nonEmptyTurns.forEach((turn, index) => {
      if (turn.userText.trim()) {
        insertMessageRow({
          id: nanoid(),
          conversationId,
          role: "user",
          status: "sent",
          content: turn.userText,
          agentId: CODEX_AGENT_ID,
          agentName: CODEX_AGENT_NAME,
          adapter: CODEX_ADAPTER,
          iso: turn.userIso ?? turn.assistantIso
        });
        messageCount++;
      }

      // Prepend a session marker on the first assistant turn so the renderer
      // picks up the codex session id for resume, mirroring the live stream.
      const items =
        index === 0
          ? [
              { kind: "session", sessionId: trimmedId } as AcpStreamItem,
              ...turn.items
            ]
          : turn.items;

      // Skip turns where the agent produced no recorded output (e.g. the
      // session was interrupted right after the user's message).
      if (items.length === 0) return;

      insertMessageRow({
        id: nanoid(),
        conversationId,
        role: "assistant",
        status: "done",
        content: JSON.stringify(items),
        agentId: CODEX_AGENT_ID,
        agentName: CODEX_AGENT_NAME,
        adapter: CODEX_ADAPTER,
        iso: turn.assistantIso
      });
      messageCount++;
    });

    // Preserve the original timeline (createConversation stamps "now").
    getDb()
      .prepare(
        `UPDATE conversations
         SET created_at = ?, updated_at = ?, last_message_at = ?
         WHERE id = ?`
      )
      .run(firstIso, lastIso, lastIso, conversationId);

    return { conversation, messageCount };
  })();

  // Best-effort: bind the codex session id so the imported conversation can be
  // resumed with the live codex-acp agent. Requires a workspace path.
  if (cwd) {
    try {
      saveToolSession(CODEX_AGENT_ID, cwd, CODEX_ADAPTER, trimmedId, title);
    } catch {
      warning = "resume_session_not_linked";
    }
  } else {
    warning = "resume_session_not_linked";
  }

  return {
    conversation: result.conversation,
    created: true,
    rolloutPath,
    turns: nonEmptyTurns.length,
    messages: result.messageCount,
    warning
  };
}
