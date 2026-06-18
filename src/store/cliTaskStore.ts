import { create } from "zustand";
import { nanoid } from "nanoid";

import { builtinCliMembers, type CLIMember } from "@/config/aiMembers";
import { cliClient } from "@/services/cli/client";
import {
  getParser,
  type CliStreamItem,
  type ParseContext
} from "@/services/cli/parsers";
import type { CliEvent, CliRunArgs } from "@/services/cli/types";
import { useCliExecutorStore } from "./cliExecutorStore";

export interface CliTaskState {
  sessionId: string;
  agentId: string;
  agentName: string;
  adapter: string;
  prompt: string;
  cwd?: string;
  status: "starting" | "running" | "done" | "failed" | "killed";
  pid?: number;
  exitCode?: number;
  errorMessage?: string;
  startedAt: number;
  endedAt?: number;
  items: CliStreamItem[];
  capturedSessionId?: string;
  resumedFromSessionId?: string;
}

interface State {
  members: CLIMember[];
  tasks: Record<string, CliTaskState>;
  taskOrder: string[]; // newest first

  selectMember(id: string): CLIMember | undefined;

  start(input: {
    member: CLIMember;
    prompt: string;
    cwd?: string;
  }): Promise<{ sessionId: string; resumed: boolean }>;

  kill(sessionId: string): Promise<void>;
  clearFinished(): void;
}

interface InternalCtx {
  parseCtx: ParseContext;
  unsubscribe: () => void;
}

const ctxMap = new Map<string, InternalCtx>();

function appendItems(prev: CliStreamItem[], next: CliStreamItem[]): CliStreamItem[] {
  if (!next.length) return prev;
  const out = [...prev];
  for (const item of next) {
    const last = out[out.length - 1];
    if (
      item.kind === "text" &&
      item.append &&
      last &&
      last.kind === "text" &&
      last.role === item.role
    ) {
      out[out.length - 1] = {
        ...last,
        content: last.content + item.content
      };
      continue;
    }
    if (
      item.kind === "thinking" &&
      item.append &&
      last &&
      last.kind === "thinking"
    ) {
      out[out.length - 1] = {
        ...last,
        content: last.content + item.content
      };
      continue;
    }
    out.push(item);
  }
  return out;
}

export const useCliTaskStore = create<State>((set, get) => ({
  members: builtinCliMembers,
  tasks: {},
  taskOrder: [],

  selectMember(id) {
    return get().members.find((m) => m.id === id);
  },

  async start({ member, prompt, cwd }) {
    const sessionId = nanoid();
    const resolved = useCliExecutorStore.getState().resolve(member.cli.adapter);
    const binary = member.cli.binary || resolved?.binary;
    const extraArgs = [
      ...(resolved?.extraArgs ?? []),
      ...(member.cli.extraArgs ?? [])
    ];

    // Look up resume sessionId so we can surface it in UI.
    let resumed = false;
    let resumedFromSessionId: string | undefined;
    if (cwd) {
      const prev = await cliClient.getToolSession(member.id, cwd);
      if (prev && prev.adapter === member.cli.adapter) {
        resumed = true;
        resumedFromSessionId = prev.sessionId;
      }
    }

    const runArgs: CliRunArgs = {
      sessionId,
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      binary,
      extraArgs,
      prompt,
      cwd,
      env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
      approvalMode: member.cli.approvalMode,
      showStderr: member.cli.showStderr,
      resumeToolSession: true
    };

    const initial: CliTaskState = {
      sessionId,
      agentId: member.id,
      agentName: member.name,
      adapter: member.cli.adapter,
      prompt,
      cwd,
      status: "starting",
      startedAt: Date.now(),
      items: [],
      resumedFromSessionId
    };
    set((s) => ({
      tasks: { ...s.tasks, [sessionId]: initial },
      taskOrder: [sessionId, ...s.taskOrder]
    }));

    const parser = getParser(resolved?.streamMode ?? "raw");
    const parseCtx: ParseContext = {};
    const unsubscribe = cliClient.onEvent(sessionId, (e: CliEvent) => {
      handleEvent(set, sessionId, e, parser, parseCtx);
    });
    ctxMap.set(sessionId, { parseCtx, unsubscribe });

    try {
      await cliClient.run(runArgs);
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      set((s) => {
        const t = s.tasks[sessionId];
        if (!t) return s;
        return {
          tasks: {
            ...s.tasks,
            [sessionId]: {
              ...t,
              status: "failed",
              errorMessage: msg,
              endedAt: Date.now(),
              items: appendItems(t.items, [{ kind: "error", message: msg }])
            }
          }
        };
      });
      ctxMap.get(sessionId)?.unsubscribe();
      ctxMap.delete(sessionId);
    }

    return { sessionId, resumed };
  },

  async kill(sessionId) {
    await cliClient.kill(sessionId);
  },

  clearFinished() {
    set((s) => {
      const keepIds = s.taskOrder.filter((id) => {
        const t = s.tasks[id];
        return t && (t.status === "starting" || t.status === "running");
      });
      const kept: Record<string, CliTaskState> = {};
      keepIds.forEach((id) => (kept[id] = s.tasks[id]));
      return { tasks: kept, taskOrder: keepIds };
    });
  }
}));

function handleEvent(
  set: (
    fn: (state: State) => Partial<State> | State
  ) => void,
  sessionId: string,
  e: CliEvent,
  parser: ReturnType<typeof getParser>,
  parseCtx: ParseContext
) {
  set((s) => {
    const t = s.tasks[sessionId];
    if (!t) return s;
    const next: CliTaskState = { ...t };

    if (e.type === "started") {
      next.status = "running";
      next.pid = e.pid;
    } else if (e.type === "stdout") {
      const items = parser.parseStdoutLine(e.content, parseCtx);
      next.items = appendItems(next.items, items);
      if (parseCtx.sessionId) next.capturedSessionId = parseCtx.sessionId;
    } else if (e.type === "stderr") {
      next.items = appendItems(next.items, [
        { kind: "command-output", content: e.content, stream: "stderr" }
      ]);
    } else if (e.type === "error") {
      next.items = appendItems(next.items, [
        { kind: "error", message: e.message }
      ]);
      next.errorMessage = e.message;
    } else if (e.type === "done") {
      next.status = e.exitCode === 0 ? "done" : "failed";
      next.exitCode = e.exitCode;
      next.endedAt = Date.now();
      next.items = appendItems(next.items, [
        { kind: "done", exitCode: e.exitCode }
      ]);
      const ctx = ctxMap.get(sessionId);
      ctx?.unsubscribe();
      ctxMap.delete(sessionId);
    }

    return { tasks: { ...s.tasks, [sessionId]: next } };
  });
}
