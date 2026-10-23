import { useEffect } from "react";

import type {
  BrowserToolEvent,
  BrowserToolResult
} from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";
import { remoteBrowserOrigin, useBrowserStore } from "@/store/browserStore";

const NATIVE_BROWSER_TOOL_ACTIONS = new Set<BrowserToolEvent["action"]>([
  "inspect",
  "screenshot",
  "click",
  "fill",
  "type",
  "scroll",
  "eval",
  "get_dom",
  "extract"
]);

/**
 * Listens for agent -> FreeBuddy bridge events (local HTTP / OS scheme) and
 * dispatches them to the right store. Mounted once at the app root.
 */
export function AgentBridgeListener() {
  const notify = useAgentBridgeStore((s) => s.notify);

  useEffect(() => {
    const captureRect = () => {
      const element = document.querySelector<HTMLElement>(".browser-frame-wrap, .draft-frame-wrap");
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

    const browserResult = (
      conversationId: string,
      cwd: string,
      overrides: Partial<BrowserToolResult> = {}
    ): BrowserToolResult => {
      const browserState = useBrowserStore.getState();
      const entry = browserState.byConv[conversationId];
      const activeId = useConversationStore.getState().activeId;
      const visible =
        activeId === conversationId &&
        useDetailLayoutStore.getState().activeTab === "preview";
      return {
        ok: entry?.loadState !== "error",
        conversationId,
        cwd,
        target: entry?.manualEntry,
        resolvedUrl: browserState.nativeUrls[conversationId] || entry?.url,
        loadState: entry?.loadState ?? "idle",
        visible,
        error: entry?.error,
        updatedAt: entry?.updatedAt,
        ...overrides
      };
    };

    const waitForBrowser = async (
      conversationId: string,
      timeoutMs = 8_000
    ): Promise<void> => {
      const current = useBrowserStore.getState().byConv[conversationId];
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
        const unsubscribe = useBrowserStore.subscribe((state) => {
          const entry = state.byConv[conversationId];
          if (entry?.loadState === "ready" || entry?.loadState === "error") {
            finish();
          }
        });
        const timeout = window.setTimeout(finish, timeoutMs);
      });
    };

    const handleBrowserTool = async (event: BrowserToolEvent) => {
      const { requestId, conversationId, cwd, action, params } = event;
      let result: BrowserToolResult;
      try {
        await useBrowserStore.getState().ensureFor(conversationId, cwd);
        const requestedTarget =
          typeof params.url === "string"
            ? params.url.trim()
            : typeof params.target === "string"
              ? params.target.trim()
              : "";
        const browserState = useBrowserStore.getState();
        const currentTarget =
          browserState.nativeUrls[conversationId] ||
          browserState.byConv[conversationId]?.manualEntry;
        const usesNativeBrowser = Boolean(
          cliClient.supportsNativeBrowser() && remoteBrowserOrigin(currentTarget)
        );

        if (action === "navigate" || action === "show" || action === "open") {
          const target = requestedTarget;
          if (target) {
            useBrowserStore.getState().navigate(conversationId, target);
          }
          const isActive = useConversationStore.getState().activeId === conversationId;
          const shouldOpen = params.open !== false;
          if (isActive && shouldOpen) {
            useDetailLayoutStore.getState().setActiveTab("preview");
          }
          const entry = useBrowserStore.getState().byConv[conversationId];
          if (!entry?.url) {
            result = browserResult(conversationId, cwd, {
              ok: false,
              error:
                "Browser has no resolvable target. Provide a valid URL, localhost dev server, or workspace file path."
            });
          } else if (params.waitForReady !== false && isActive) {
            await waitForBrowser(conversationId);
            result = browserResult(conversationId, cwd, {
              message: "Browser navigated successfully."
            });
          } else {
            result = browserResult(conversationId, cwd, {
              message:
                isActive || !shouldOpen
                  ? "Browser navigated successfully."
                  : "Browser target updated for a background conversation; it will be visible when that conversation is opened."
            });
          }
        } else if (usesNativeBrowser && NATIVE_BROWSER_TOOL_ACTIONS.has(action)) {
          const nativeResult = await cliClient.runNativeBrowserTool(action, params);
          if (nativeResult.resolvedUrl) {
            useBrowserStore.getState().setNativeBrowserUrl(conversationId, nativeResult.resolvedUrl);
          }
          result = browserResult(conversationId, cwd, {
            ...nativeResult,
            ok: true
          });
        } else if (action === "inspect" || action === "screenshot") {
          result = browserResult(conversationId, cwd, {
            captureRect: params.screenshot === true || action === "screenshot" ? captureRect() : undefined
          });
        } else if (action === "report") {
          const message =
            typeof params.message === "string" ? params.message.trim() : "";
          if (message) notify(message);
          result = browserResult(conversationId, cwd, {
            ok: Boolean(message),
            message: message || undefined,
            error: message ? undefined : "Browser report requires a message."
          });
        } else {
          result = browserResult(conversationId, cwd, {
            ok: true
          });
        }
      } catch (error) {
        result = browserResult(conversationId, cwd, {
          ok: false,
          error: (error as Error)?.message || String(error)
        });
      }
      if (window.freebuddy?.window?.resolveBrowserTool) {
        await window.freebuddy.window.resolveBrowserTool({ requestId, result });
      }
    };

    const setTarget = (to: string | undefined, openPreview: boolean) => {
      const convId = useConversationStore.getState().activeId;
      if (to && convId) {
        const activeConv = useConversationStore
          .getState()
          .conversations.find((c) => c.id === convId);
        void useBrowserStore
          .getState()
          .ensureFor(convId, activeConv?.cwd)
          .then(() => {
            useBrowserStore.getState().navigate(convId, to);
            if (openPreview) {
              const layout = useDetailLayoutStore.getState();
              layout.setActiveTab("preview");
              layout.setDetailCollapsed(false);
            }
          });
      }
    };

    const offBridge = window.freebuddy?.window?.onBridge?.((event) => {
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

    const offBrowserTool = window.freebuddy?.window?.onBrowserTool?.((event) => {
      void handleBrowserTool(event);
    });

    return () => {
      offBridge?.();
      offBrowserTool?.();
    };
  }, [notify]);

  return null;
}
