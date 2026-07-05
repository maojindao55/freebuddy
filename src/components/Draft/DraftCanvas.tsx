import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import type { ConversationMessage } from "@/services/cli/types";
import type { FeedItem } from "@/services/feed/types";
import { cliClient } from "@/services/cli/client";
import { useConversationStore } from "@/store/conversationStore";
import { useDraftPreviewStore } from "@/store/draftPreviewStore";
import { useFeedStore } from "@/store/feedStore";
import {
  buildFeedInterpretPrompt,
  clipFeedTitle,
  isFeedInterpretConversation
} from "../Feeds/feedInterpretation";
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

const DOCUMENT_TARGET_EXTENSIONS = new Set(["txt", "log", "json", "yaml", "yml", "csv"]);
const MIN_IMAGE_ZOOM = 0.5;
const MAX_IMAGE_ZOOM = 8;

function clampImageZoom(value: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value));
}

export function draftTargetExtension(
  target: string | undefined,
  url: string | undefined
): string {
  const value = target || url || "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "freebuddy-file:") {
      const filePath = parsed.searchParams.get("path") ?? parsed.pathname;
      return filePath.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
    }
    return parsed.pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return value.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  }
}

function isMarkdownTarget(target: string | undefined, url: string | undefined): boolean {
  return draftTargetExtension(target, url) === "md";
}

export function isImageDraftTarget(
  target: string | undefined,
  url: string | undefined
): boolean {
  return IMAGE_TARGET_EXTENSIONS.has(draftTargetExtension(target, url));
}

function isDocumentTarget(target: string | undefined, url: string | undefined): boolean {
  return DOCUMENT_TARGET_EXTENSIONS.has(draftTargetExtension(target, url));
}

function isPdfTarget(target: string | undefined, url: string | undefined): boolean {
  return draftTargetExtension(target, url) === "pdf";
}

export function isExternalOnlyDraftTarget(value: string | undefined): boolean {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function documentRel(target: string | undefined): string | null {
  if (!target || /^https?:\/\//i.test(target)) return null;
  const rel = target.split("?")[0].trim();
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || DOCUMENT_TARGET_EXTENSIONS.has(ext) ? rel : null;
}

function formatDocumentContent(ext: string, content: string): string {
  if (ext !== "json") return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function DocumentText({ content, extension }: { content: string; extension: string }) {
  return <pre className={`draft-document-text ${extension}`}>{formatDocumentContent(extension, content)}</pre>;
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
  const [documentText, setDocumentText] = useState<string | null>(null);
  const [feedActionId, setFeedActionId] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const activeId = useConversationStore((s) => s.activeId);
  const conversations = useConversationStore((s) => s.conversations);
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
  const members = useConversationStore((s) => s.members);
  const newConversation = useConversationStore((s) => s.newConversation);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const feedItems = useFeedStore((s) => s.items);
  const markInterpreted = useFeedStore((s) => s.markInterpreted);
  const entry = useDraftPreviewStore((s) =>
    activeId ? s.byConv[activeId] : undefined
  );
  const active = conversations.find((conv) => conv.id === activeId);
  const hasEntry = Boolean(entry?.url);
  const isMarkdown = isMarkdownTarget(entry?.manualEntry, entry?.url);
  const isImage = isImageDraftTarget(entry?.manualEntry, entry?.url);
  const isDocument = isDocumentTarget(entry?.manualEntry, entry?.url);
  const isPdf = isPdfTarget(entry?.manualEntry, entry?.url);
  const isExternalOnly = isExternalOnlyDraftTarget(entry?.manualEntry);
  const pdfUrl = isPdf && entry?.url ? `${entry.url}#view=FitH&navpanes=0` : "";
  const documentExtension = draftTargetExtension(entry?.manualEntry, entry?.url);
  const frameWidth = FRAME_WIDTH[viewport];
  const currentFeedItem = useMemo(
    () => feedItems.find((item) => item.link === entry?.manualEntry),
    [feedItems, entry?.manualEntry]
  );
  const isActiveFeedConversation = isFeedInterpretConversation(messages);

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
    setDocumentText(null);
  }, [entry?.url]);

  useEffect(() => {
    const rel = documentRel(entry?.manualEntry);
    if (!entry?.url || (!isMarkdown && !isDocument) || !cwd || !rel) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void cliClient
      .readDraftMarkdown(cwd, rel)
      .then((text) => {
        if (cancelled) return;
        if (text == null) throw new Error("Document not found");
        if (isMarkdown) {
          setMarkdown(text);
          setDocumentText(null);
        } else {
          setDocumentText(text);
          setMarkdown(null);
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMarkdown(null);
        setDocumentText(null);
        setIsLoading(false);
        setError(t("draft.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, entry?.manualEntry, entry?.url, isDocument, isMarkdown, t]);

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

  const handleMarkFeedItemRead = useCallback(
    async (item: FeedItem) => {
      setFeedActionId(item.id);
      try {
        await markInterpreted(item.id);
      } finally {
        setFeedActionId(null);
      }
    },
    [markInterpreted]
  );

  const handleInterpretFeedItem = useCallback(
    async (item: FeedItem) => {
      const member =
        members.find((entry) => entry.id === active?.agentId) ?? members[0];
      if (!member) return;
      setFeedActionId(item.id);
      try {
        const conv =
          active && isActiveFeedConversation
            ? active
            : await newConversation({
                member,
                cwd: active?.cwd,
                title: clipFeedTitle(item.title),
                approvalMode: active?.approvalMode ?? member.cli.approvalMode
              });
        await markInterpreted(item.id);
        await sendMessage({
          conversationId: conv.id,
          prompt: buildFeedInterpretPrompt(item, t),
          preserveConversationTitle: true
        });
      } finally {
        setFeedActionId(null);
      }
    },
    [
      active,
      isActiveFeedConversation,
      markInterpreted,
      members,
      newConversation,
      sendMessage,
      t
    ]
  );

  const onImageWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const gestureZoom = event.ctrlKey || event.metaKey;
    if (!gestureZoom) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.002);
    setZoom((current) => {
      const next = clampImageZoom(current * factor);
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

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

  return (
    <div className="draft-canvas">
      <DraftToolbar
        url={entry?.url}
        viewport={viewport}
        zoom={zoom}
        feedItem={currentFeedItem}
        feedActionBusy={Boolean(feedActionId)}
        onViewportChange={setViewport}
        onZoomChange={setZoom}
        onInterpretFeedItem={handleInterpretFeedItem}
        onMarkFeedItemRead={handleMarkFeedItemRead}
        onClose={onClose}
      />
      <div
        className={`draft-frame-wrap${isMarkdown || isDocument ? " markdown" : ""}${isImage ? " image" : ""}${isPdf ? " pdf" : ""}${isExternalOnly ? " external-only" : ""}`}
        onMouseDown={hasEntry && !isMarkdown && !isDocument && !isImage && !isPdf && !isExternalOnly ? focusFrame : undefined}
      >
        {hasEntry ? (
          <>
            {isLoading && <div className="draft-status">{t("draft.loading")}</div>}
            {error && <div className="draft-status draft-error">{error}</div>}
            {isExternalOnly ? (
              <div className="draft-external-only">
                <strong>{t("draft.externalOnlyTitle")}</strong>
                <p>{t("draft.externalOnlyBody")}</p>
                {entry?.url && (
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => void cliClient.openDraftExternal(entry.url)}
                  >
                    {t("draft.openExternal")}
                  </button>
                )}
              </div>
            ) : isMarkdown ? (
              <div
                className="draft-markdown-wrap"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
              >
                {markdown != null && <MarkdownText content={markdown} />}
              </div>
            ) : isDocument ? (
              <div
                className="draft-document-wrap"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
              >
                {documentText != null && (
                  <DocumentText content={documentText} extension={documentExtension} />
                )}
              </div>
            ) : isImage ? (
              <div
                className="draft-image-wrap"
                style={zoom > 1 ? { cursor: isDragging ? "grabbing" : "grab" } : undefined}
                onMouseDown={onDragStart}
                onWheel={onImageWheel}
                onDoubleClick={resetPan}
              >
                <img
                  src={entry!.url}
                  alt={entry?.manualEntry ?? t("draft.title")}
                  className="draft-image"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: "center center"
                  }}
                  draggable={false}
                  onLoad={() => setIsLoading(false)}
                  onError={() => {
                    setIsLoading(false);
                    setError(t("draft.loadError"));
                  }}
                />
              </div>
            ) : isPdf ? (
              <embed
                key={pdfUrl}
                src={pdfUrl}
                className="draft-pdf"
                type="application/pdf"
                onLoad={() => setIsLoading(false)}
                onError={() => {
                  setIsLoading(false);
                  setError(t("draft.loadError"));
                }}
              />
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
