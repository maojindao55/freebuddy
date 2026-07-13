import { useEffect } from "react";

import type {
  DraftToolEvent,
  DraftToolResult
} from "@/services/cli/types";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";

/**
 * Listens for agent -> FreeBuddy bridge events (local HTTP / OS scheme) and
 * dispatches them to the right store. Mounted once at the app root.
 */
export function AgentBridgeListener() {
  const notify = useAgentBridgeStore((s) => s.notify);

  useEffect(() => {
    const captureRect = () => {
      const element = document.querySelector<HTMLElement>(".draft-frame-wrap");
      if (!element) return undefined;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return undefined;
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
    };

    const draftResult = (
      conversationId: string,
      cwd: string,
      overrides: Partial<DraftToolResult> = {}
    ): DraftToolResult => {
      const entry = useDraftPreviewStore.getState().byConv[conversationId];
      const activeId = useConversationStore.getState().activeId;
      const visible =
        activeId === conversationId &&
        useDetailLayoutStore.getState().activeTab === "preview";
      return {
        ok: entry?.loadState !== "error",
        conversationId,
        cwd,
        target: entry?.manualEntry,
        resolvedUrl: entry?.url,
        loadState: entry?.loadState ?? "idle",
        visible,
        error: entry?.error,
        updatedAt: entry?.updatedAt,
        ...overrides
      };
    };

    const waitForDraft = async (
      conversationId: string,
      timeoutMs = 8_000
    ): Promise<void> => {
      const current = useDraftPreviewStore.getState().byConv[conversationId];
      if (current?.loadState === "ready" || current?.loadState === "error") return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        };
        const unsubscribe = useDraftPreviewStore.subscribe((state) => {
          const entry = state.byConv[conversationId];
          if (entry?.loadState === "ready" || entry?.loadState === "error") {
            finish();
          }
        });
        const timeout = window.setTimeout(finish, timeoutMs);
      });
    };

    const handleDraftTool = async (event: DraftToolEvent) => {
      const { requestId, conversationId, cwd, action, params } = event;
      let result: DraftToolResult;
      try {
        await useDraftPreviewStore.getState().ensureFor(conversationId, cwd);
        if (action === "show") {
          const target = typeof params.target === "string" ? params.target.trim() : "";
          if (target) {
            useDraftPreviewStore.getState().setPreviewTarget(conversationId, target);
          }
          const isActive = useConversationStore.getState().activeId === conversationId;
          const shouldOpen = params.open !== false;
          if (isActive && shouldOpen) {
            useDetailLayoutStore.getState().setActiveTab("preview");
          }
          const entry = useDraftPreviewStore.getState().byConv[conversationId];
          if (!entry?.url) {
            result = draftResult(conversationId, cwd, {
              ok: false,
              error:
                "Draft has no resolvable preview target. Select a working directory for workspace-relative files, or pass an absolute local path or URL to draft_show."
            });
          } else if (params.waitForReady !== false && isActive) {
            await waitForDraft(conversationId);
            result = draftResult(conversationId, cwd, {
              message: "Draft preview updated."
            });
          } else {
            result = draftResult(conversationId, cwd, {
              message:
                isActive || !shouldOpen
                  ? "Draft preview updated."
                  : "Draft target updated for a background conversation; it will be visible when that conversation is opened."
            });
          }
        } else if (action === "inspect") {
          result = draftResult(conversationId, cwd, {
            captureRect: params.screenshot === true ? captureRect() : undefined
          });
        } else {
          const message =
            typeof params.message === "string" ? params.message.trim() : "";
          if (message) notify(message);
          result = draftResult(conversationId, cwd, {
            ok: Boolean(message),
            message: message || undefined,
            error: message ? undefined : "Draft report requires a message."
          });
        }
      } catch (error) {
        result = draftResult(conversationId, cwd, {
          ok: false,
          error: (error as Error)?.message || String(error)
        });
      }
      await window.freebuddy?.window?.resolveDraftTool?.({ requestId, result });
    };

    const setTarget = (to: string | undefined, openPreview: boolean) => {
      const convId = useConversationStore.getState().activeId;
      if (to && convId) {
        useDraftPreviewStore.getState().setPreviewTarget(convId, to);
        if (openPreview) useDetailLayoutStore.getState().setActiveTab("preview");
      }
    };

    const off = window.freebuddy?.window?.onBridge?.((event) => {
      const { action, params } = event;
      if (action === "preview") {
        useDetailLayoutStore.getState().setActiveTab("preview");
        return;
      }
      if (action === "navigate") {
        setTarget(params?.to, true);
        return;
      }
      if (action === "entry") {
        setTarget(params?.to, false);
        return;
      }
      if (action === "status") {
        const text = params?.text;
        if (text) notify(text);
        return;
      }
      if (action === "error") {
        const text = params?.text;
        if (text) notify(text);
        return;
      }
      if (action === "notify") {
        const text = params?.text;
        if (text) notify(text);
        return;
      }
    });
    const offDraftTool = window.freebuddy?.window?.onDraftTool?.((event) => {
      void handleDraftTool(event);
    });
    return () => {
      off?.();
      offDraftTool?.();
    };
  }, [notify]);

  return null;
}
