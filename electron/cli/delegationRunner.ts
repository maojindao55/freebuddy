import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { cliRun } from "./runtime.js";
import type { CliRunArgs } from "./runtimeShared.js";
import { appendMessage, updateMessage } from "./conversations.js";
import { safeSendToWebContents } from "./ipcSend.js";
import { analyzeDelegationOutput } from "@freebuddy/delegation-core";

export interface DelegateRunResult {
  summary: string;
  exitCode: number | null;
  error: string | null;
  hasOutput: boolean;
  diagnostic: string | null;
}

export type DelegateAgentRunner = (args: CliRunArgs) => Promise<DelegateRunResult>;

export function summarizeDelegateOutput(items: unknown[]): string {
  return analyzeDelegationOutput(items).summary;
}

export function createDelegateAgentRunner(webContents: WebContents | undefined): DelegateAgentRunner {
  return async (args: CliRunArgs): Promise<DelegateRunResult> => {
    const collected: unknown[] = [];
    let exitCode: number | null = null;
    let errored: string | null = null;

    // When a conversation is present, mirror workflowRuntime.executeStep: post
    // a placeholder assistant message (taskId links it to the live cli://
    // stream), stream collected items into it on a debounce, then flip the
    // status once cliRun settles. Without a conversationId we harvest only.
    const conversationId = args.conversationId;
    let messageId: string | undefined;
    let flushTimer: NodeJS.Timeout | undefined;

    const broadcastMsg = (type: "appended" | "updated") => {
      if (messageId && conversationId) {
        safeSendToWebContents(webContents, `workflow://message/${conversationId}`, {
          type,
          conversationId,
          messageId
        });
      }
    };

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        if (messageId) {
          updateMessage({ id: messageId, content: JSON.stringify(collected) });
          broadcastMsg("updated");
        }
      }, 300);
    };

    if (conversationId) {
      messageId = randomUUID();
      appendMessage({
        id: messageId,
        conversationId,
        role: "assistant",
        status: "running",
        content: "[]",
        taskId: args.sessionId,
        agentId: args.agentId,
        agentName: args.agentName,
        adapter: args.adapter,
        roleLabel: args.roleLabel
      });
      broadcastMsg("appended");
    }

    try {
      await cliRun(webContents as WebContents, args, (e) => {
        if (e.type === "items") {
          const items = (e as { items?: unknown[] }).items;
          if (items?.length) {
            collected.push(...items);
            if (messageId) scheduleFlush();
          }
        } else if (e.type === "done") {
          exitCode = (e as { exitCode?: number }).exitCode ?? 0;
        } else if (e.type === "error") {
          errored = (e as { message: string }).message;
        }
      });
    } catch (error) {
      errored = error instanceof Error ? error.message : String(error);
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const evidence = analyzeDelegationOutput(collected);
      const processError =
        exitCode !== null && exitCode !== 0
          ? `Agent process exited with code ${exitCode}.`
          : null;
      if (messageId) {
        updateMessage({
          id: messageId,
          content: JSON.stringify(collected),
          status:
            errored || processError || (!evidence.hasOutput && evidence.toolError)
              ? "failed"
              : "done"
        });
        broadcastMsg("updated");
      }
    }
    const evidence = analyzeDelegationOutput(collected);
    const processError =
      exitCode !== null && exitCode !== 0
        ? `Agent process exited with code ${exitCode}.`
        : null;
    return {
      summary: evidence.summary,
      exitCode,
      error: errored ?? processError,
      hasOutput: evidence.hasOutput,
      diagnostic: evidence.toolError
        ? `Agent ended after a failed tool call without a final response or artifact: ${evidence.toolError}`
        : null
    };
  };
}
