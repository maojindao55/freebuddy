import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { FREEBIE_HANDSHAKE_TIMEOUT_MS, FREEBIE_PAGE_ORIGIN } from "@/config/freebie";
import { cliClient } from "@/services/cli/client";
import {
  parseFreebiePageMessage,
  wrapHostMessage,
  type FreebieHostMessage,
  type FreebieHostState,
  type FreebieProviderPreset
} from "@/services/freebie/protocol";

export type FreebieBridgeStatus = "connecting" | "ready" | "failed";

export type FreebieImportResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string };

interface UseFreebieBridgeOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Bumped by the caller when the iframe is remounted so the handshake restarts. */
  sessionKey: string | number;
  locale: string;
  theme: "light" | "dark";
  hostState: FreebieHostState;
  onImportRequest: (preset: FreebieProviderPreset) => Promise<FreebieImportResult>;
}

/**
 * Host side of the freebie page bridge. Accepts messages only when they come
 * from the configured page origin *and* from the iframe we rendered, validates
 * every payload, and answers with typed host messages.
 */
export function useFreebieBridge({
  iframeRef,
  sessionKey,
  locale,
  theme,
  hostState,
  onImportRequest
}: UseFreebieBridgeOptions): { status: FreebieBridgeStatus } {
  const [status, setStatus] = useState<FreebieBridgeStatus>("connecting");
  const statusRef = useRef<FreebieBridgeStatus>("connecting");
  const hostStateRef = useRef(hostState);
  const onImportRef = useRef(onImportRequest);
  const localeRef = useRef(locale);
  const themeRef = useRef(theme);
  hostStateRef.current = hostState;
  onImportRef.current = onImportRequest;
  localeRef.current = locale;
  themeRef.current = theme;

  const post = useCallback(
    (message: FreebieHostMessage) => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return;
      target.postMessage(wrapHostMessage(message), FREEBIE_PAGE_ORIGIN);
    },
    [iframeRef]
  );

  useEffect(() => {
    statusRef.current = "connecting";
    setStatus("connecting");
    const timeout = window.setTimeout(() => {
      if (statusRef.current === "connecting") {
        statusRef.current = "failed";
        setStatus("failed");
      }
    }, FREEBIE_HANDSHAKE_TIMEOUT_MS);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== FREEBIE_PAGE_ORIGIN) return;
      if (!event.source || event.source !== iframeRef.current?.contentWindow) return;
      const parsed = parseFreebiePageMessage(event.data);
      if (!parsed) return;
      if (!parsed.ok) {
        if (import.meta.env?.DEV) {
          console.warn("[FreeBuddy] rejected freebie bridge message:", parsed.error);
        }
        return;
      }
      const message = parsed.value;
      switch (message.type) {
        case "ready": {
          statusRef.current = "ready";
          setStatus("ready");
          post({
            type: "hello",
            locale: localeRef.current,
            theme: themeRef.current,
            platform: window.freebuddy?.platform ?? "web",
            ...hostStateRef.current
          });
          return;
        }
        case "getState": {
          post({ type: "state", ...hostStateRef.current });
          return;
        }
        case "openExternal": {
          void cliClient.openBrowserExternal(message.url);
          return;
        }
        case "importAgent": {
          void onImportRef
            .current(message.preset)
            .then((result) => {
              if (result.ok) {
                post({ type: "result", requestId: message.requestId, ok: true, agentId: result.agentId });
              } else {
                post({ type: "result", requestId: message.requestId, ok: false, error: result.error });
              }
            })
            .catch((err: unknown) => {
              post({
                type: "result",
                requestId: message.requestId,
                ok: false,
                error: err instanceof Error ? err.message : String(err)
              });
            });
          return;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
    };
  }, [iframeRef, post, sessionKey]);

  // Push state changes (e.g. a new import) to the page once connected.
  const stateSignature = JSON.stringify(hostState);
  useEffect(() => {
    if (statusRef.current !== "ready") return;
    post({ type: "state", ...hostStateRef.current });
  }, [post, stateSignature]);

  return { status };
}
