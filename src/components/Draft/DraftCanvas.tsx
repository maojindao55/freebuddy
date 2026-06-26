import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import type { ConversationMessage } from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";
import { useConversationStore } from "@/store/conversationStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";
import { DraftToolbar, type DraftViewport } from "./DraftToolbar";
import { MarkdownText } from "../CLI/StreamItem";

const EMPTY_MESSAGES: ConversationMessage[] = [];
const FRAME_WIDTH: Record<DraftViewport, number | null> = {
  responsive: null,
  desktop: 1440,
  tablet: 768,
  mobile: 390
};

const IMAGE_TARGET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "svg",
  "avif",
  "bmp"
]);

function targetExtension(target: string | undefined, url: string | undefined): string {
  const value = target || url || "";
  try {
    const parsed = new URL(value);
    return parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return value.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  }
}

function isMarkdownTarget(target: string | undefined, url: string | undefined): boolean {
  return targetExtension(target, url) === "md";
}

function isImageTarget(target: string | undefined, url: string | undefined): boolean {
  return IMAGE_TARGET_EXTENSIONS.has(targetExtension(target, url));
}

function markdownRel(target: string | undefined): string | null {
  if (!target || /^https?:\/\//i.test(target)) return null;
  const rel = target.split("?")[0].trim();
  return rel.toLowerCase().endsWith(".md") ? rel : null;
}

function extractLastFileEditPath(
  items: CliStreamItem[] | undefined,
  messages: ConversationMessage[]
): string | undefined {
  if (items && items.length) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "file-edit" && it.path) return it.path;
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (!Array.isArray(parsed)) continue;
      const parsedItems = parsed as CliStreamItem[];
      for (let j = parsedItems.length - 1; j >= 0; j -= 1) {
        const it = parsedItems[j];
        if (it.kind === "file-edit" && it.path) return it.path;
      }
    } catch {
      // ignore legacy plain content
    }
  }
  return undefined;
}

export function DraftCanvas({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<DraftViewport>("responsive");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [manualInput, setManualInput] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const [markdown, setMarkdown] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const activeId = useConversationStore((s) => s.activeId);
  const cwd = useConversationStore((s) => {
    const conv = s.conversations.find((c) => c.id === s.activeId);
    return conv?.cwd;
  });
  const liveItems = useConversationStore((s) =>
    s.activeId ? s.live[s.activeId]?.items : undefined
  );
  const messages = useConversationStore((s) =>
    s.activeId ? s.messages[s.activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const entry = useDraftPreviewStore((s) =>
    activeId ? s.byConv[activeId] : undefined
  );
  const hasEntry = Boolean(entry?.url);
  const isMarkdown = isMarkdownTarget(entry?.manualEntry, entry?.url);
  const isImage = isImageTarget(entry?.manualEntry, entry?.url);
  const frameWidth = FRAME_WIDTH[viewport];

  useEffect(() => {
    if (!activeId) return;
    void useDraftPreviewStore.getState().ensureFor(activeId, cwd);
  }, [activeId, cwd]);

  const lastEditPath = useMemo(
    () => extractLastFileEditPath(liveItems, messages),
    [liveItems, messages]
  );

  useEffect(() => {
    if (!activeId || !lastEditPath) return;
    const ext = lastEditPath.split(".").pop()?.toLowerCase();
    const delay = ext === "css" || ext === "html" || ext === "htm" ? 120 : 450;
    useDraftPreviewStore.getState().scheduleReload(activeId, delay);
  }, [activeId, lastEditPath]);

  useEffect(() => {
    if (!entry?.url) return;
    setIsLoading(true);
    setError(null);
    setMarkdown(null);
  }, [entry?.url]);

  useEffect(() => {
    const rel = markdownRel(entry?.manualEntry);
    if (!entry?.url || !isMarkdown || !cwd || !rel) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void cliClient
      .readDraftMarkdown(cwd, rel)
      .then((text) => {
        if (cancelled) return;
        if (text == null) throw new Error("Markdown not found");
        setMarkdown(text);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMarkdown(null);
        setIsLoading(false);
        setError(t("draft.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, entry?.manualEntry, entry?.url, isMarkdown, t]);

  const focusFrame = () => {
    frameRef.current?.focus();
    frameRef.current?.contentWindow?.focus();
  };

  const commitManual = () => {
    const trimmed = manualInput.trim();
    if (!activeId || !trimmed) return;
    useDraftPreviewStore.getState().setPreviewTarget(activeId, trimmed);
  };

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!isImage || zoom <= 1) return;
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      panStart.current = { ...pan };
    },
    [isImage, zoom, pan]
  );

  const resetPan = useCallback(() => setPan({ x: 0, y: 0 }), []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy });
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [zoom]);

  return (
    <div className="draft-canvas">
      <DraftToolbar
        url={entry?.url}
        viewport={viewport}
        zoom={zoom}
        onViewportChange={setViewport}
        onZoomChange={setZoom}
        onClose={onClose}
      />
      <div
        className={`draft-frame-wrap${isMarkdown ? " markdown" : ""}${isImage ? " image" : ""}`}
        onMouseDown={hasEntry && !isMarkdown && !isImage ? focusFrame : undefined}
      >
        {hasEntry ? (
          <>
            {isLoading && <div className="draft-status">{t("draft.loading")}</div>}
            {error && <div className="draft-status draft-error">{error}</div>}
            {isMarkdown ? (
              <div
                className="draft-markdown-wrap"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
              >
                {markdown != null && <MarkdownText content={markdown} />}
              </div>
            ) : isImage ? (
              <div
                className="draft-image-wrap"
                style={zoom > 1 ? { cursor: isDragging ? "grabbing" : "grab" } : undefined}
                onMouseDown={onDragStart}
                onDoubleClick={resetPan}
              >
                <img
                  src={entry!.url}
                  alt={entry?.manualEntry ?? t("draft.title")}
                  className="draft-image"
                  style={{
                    zoom,
                    transform: `translate(${pan.x}px, ${pan.y}px)`
                  }}
                  draggable={false}
                  onLoad={() => setIsLoading(false)}
                  onError={() => {
                    setIsLoading(false);
                    setError(t("draft.loadError"));
                  }}
                />
              </div>
            ) : (
              <iframe
                ref={frameRef}
                key={entry!.url}
                src={entry!.url}
                className="draft-frame"
                style={{
                  ...(frameWidth ? { width: frameWidth } : undefined),
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center"
                }}
                title={t("draft.title")}
                allow="autoplay; fullscreen; gamepad; pointer-lock; clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-same-origin"
                onLoad={() => {
                  setIsLoading(false);
                  focusFrame();
                }}
                onError={() => {
                  setIsLoading(false);
                  setError(t("draft.loadError"));
                }}
              />
            )}
          </>
        ) : (
          <div className="draft-empty">
            <p>{cwd ? t("draft.emptyNoEntry") : t("draft.emptyNoWorkspace")}</p>
            {cwd && (
              <input
                className="draft-manual-fallback"
                type="text"
                value={manualInput}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("draft.manualFallbackPlaceholder")}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && activeId && manualInput.trim()) {
                    e.preventDefault();
                    useDraftPreviewStore
                      .getState()
                      .setPreviewTarget(activeId, manualInput.trim());
                  }
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
