import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import type { ConversationMessage, NativeBrowserState } from "@/services/cli/types";
import type { FeedItem } from "@/services/feed/types";
import { cliClient } from "@/services/cli/client";
import { useConversationStore } from "@/store/conversationStore";
import {
  bundledGameEntry,
  isBundledGameType,
  remoteBrowserOrigin,
  splitAbsoluteLocalFile,
  useBrowserStore
} from "@/store/browserStore";
import { useFeedStore } from "@/store/feedStore";
import {
  buildFeedInterpretPrompt,
  clipFeedTitle,
  isFeedInterpretConversation
} from "../Feeds/feedInterpretation";
import { builtinCliMembers, type CLIMember } from "@/config/aiMembers";
import { getAgentIconId } from "@/config/agentIcon";
import { lobehubAvatarUrl } from "@/utils/lobehubAvatar";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { BrowserToolbar, type BrowserViewport } from "./BrowserToolbar";
import { MarkdownText } from "../CLI/StreamItem";

function resolveAgentAvatarUrl(agentId?: string, member?: CLIMember, fallbackAdapter?: string): string | undefined {
  if (!agentId && !member && !fallbackAdapter) return undefined;
  if (agentId === "cli-butlerbuddy") return lobehubAvatarUrl("Bilibili");

  const overrideId = agentId?.startsWith("cli-") ? agentId.slice(4) : undefined;
  const overrides = useCliExecutorStore.getState().overrides;
  const storedIcon = (overrideId && overrides[overrideId]?.icon) ||
                     (member?.avatar) ||
                     (fallbackAdapter && overrides[fallbackAdapter]?.icon);

  const adapter = member?.cli?.adapter || member?.runtimeKey || fallbackAdapter;
  const iconId = getAgentIconId(adapter, storedIcon);
  return iconId ? lobehubAvatarUrl(iconId) : undefined;
}

const EMPTY_MESSAGES: ConversationMessage[] = [];
const FRAME_WIDTH: Record<BrowserViewport, number | null> = {
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
const EMPTY_NATIVE_BROWSER_STATE: NativeBrowserState = {
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  visible: false
};

function clampImageZoom(value: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, value));
}

function extensionFromLocalPath(filePath: string): string {
  return filePath.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}

export function browserTargetExtension(
  target: string | undefined,
  url: string | undefined
): string {
  const value = target || url || "";
  try {
    const parsed = new URL(value, "http://local.invalid");
    if (
      parsed.protocol === "freebuddy-file:" ||
      parsed.pathname === "/api/attachment"
    ) {
      const filePath = parsed.searchParams.get("path") ?? parsed.pathname;
      return extensionFromLocalPath(filePath);
    }
    return extensionFromLocalPath(parsed.pathname);
  } catch {
    return extensionFromLocalPath(value);
  }
}

function isMarkdownTarget(target: string | undefined, url: string | undefined): boolean {
  return browserTargetExtension(target, url) === "md";
}

export function isImageBrowserTarget(
  target: string | undefined,
  url: string | undefined
): boolean {
  return IMAGE_TARGET_EXTENSIONS.has(browserTargetExtension(target, url));
}

function isDocumentTarget(target: string | undefined, url: string | undefined): boolean {
  return DOCUMENT_TARGET_EXTENSIONS.has(browserTargetExtension(target, url));
}

function isPdfTarget(target: string | undefined, url: string | undefined): boolean {
  return browserTargetExtension(target, url) === "pdf";
}

export function isExternalOnlyBrowserTarget(value: string | undefined): boolean {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    const { hostname } = new URL(value);
    return hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function extractAssistantText(content: string): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item: any) => {
          if (typeof item === "string") return item;
          if (item?.type === "text" || item?.kind === "text") return item.text || item.content || "";
          if (item?.type === "message" || item?.kind === "message") return item.text || item.content || "";
          return item?.text || item?.content || "";
        })
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    /* plain text */
  }
  return content;
}

function extractAgentMoveFromText(text: string): {
  action: string;
  speech?: string;
  thought?: string;
  mood?: "confident" | "mocking" | "nervous" | "calm" | "admiring";
} | null {
  if (!text) return null;

  // 1. Try finding json code blocks
  const jsonBlocks = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  if (jsonBlocks) {
    for (const block of jsonBlocks) {
      const clean = block.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
      try {
        const parsed = JSON.parse(clean);
        if (parsed && typeof parsed === "object") {
          const action = parsed.action || parsed.actionId || parsed.move || parsed.position || parsed.coord;
          if (typeof action === "string" && /^(?:[A-O]\d{1,2}|[a-i]\d[a-i]\d)$/i.test(action.trim())) {
            return {
              action: action.trim(),
              speech: parsed.speech || parsed.chat || parsed.message || parsed.reply,
              thought: parsed.thought || parsed.reason,
              mood: parsed.mood
            };
          }
        }
      } catch {
        /* try next block */
      }
    }
  }

  // 2. Try parsing raw JSON
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object") {
      const action = parsed.action || parsed.actionId || parsed.move || parsed.position || parsed.coord;
      if (typeof action === "string" && /^(?:[A-O]\d{1,2}|[a-i]\d[a-i]\d)$/i.test(action.trim())) {
        return {
          action: action.trim(),
          speech: parsed.speech || parsed.chat || parsed.message,
          thought: parsed.thought || parsed.reason,
          mood: parsed.mood
        };
      }
    }
  } catch {
    /* fallback to regex */
  }

  // 3. Fallback regex for move commands e.g. "move: H8" or "move: b2e2"
  const regexMatch = text.match(/(?:\u843d\u5b50|\u8d70\u5b50|\u8d70\u6b65|action|move|coordinate|\u5750\u6807|\u8d70|\u4e0b\u5728)[:\uff1a\s*#]+([A-O]\d{1,2}|[a-i]\d[a-i]\d)\b/i);
  if (regexMatch) {
    return {
      action: regexMatch[1].trim(),
      speech: text.replace(/[#*`]/g, "").slice(0, 100).trim()
    };
  }

  return null;
}

function buildHardModeCommentaryPrompt(
  snapshot: any,
  t: (key: string, options?: any) => string
): string {
  const isXiangqi = snapshot?.gameType === "xiangqi";
  const history = snapshot?.moveHistory || [];
  const agentMove = snapshot?.lastMove || (history.length > 0 ? history[history.length - 1] : null);
  if (!agentMove) return "";

  const prevMove = history.length >= 2 ? history[history.length - 2] : null;

  const formatMove = (m: any) => {
    if (!m) return "";
    if (isXiangqi && m.chineseMove) {
      return `${m.chineseMove} (${m.actionId})`;
    }
    return String(m.actionId || "");
  };

  const cleanReason = (rawReason?: string, moveStr?: string) => {
    if (!rawReason) return "";
    let r = rawReason.trim();
    if (moveStr && r.startsWith(moveStr)) {
      r = r.slice(moveStr.length).replace(/^[，,\s]+/, "").trim();
    } else if (r.includes("，")) {
      r = r.split("，").slice(1).join("，").trim();
    } else if (r.includes(",")) {
      r = r.split(",").slice(1).join(",").trim();
    }
    return r ? `（${r}）` : "";
  };

  const agentMoveLabel = formatMove(agentMove);
  const playerMoveLabel = formatMove(prevMove);
  const reasonText = isXiangqi
    ? cleanReason(agentMove.reason, agentMove.chineseMove)
    : "";

  if (snapshot.status === "agent_won") {
    return isXiangqi
      ? t("game.hardModeWonAgentXiangqi", { agentMove: agentMoveLabel })
      : t("game.hardModeWonAgentGomoku", { agentMove: agentMoveLabel });
  }

  if (prevMove) {
    return isXiangqi
      ? t("game.hardModeTurnCommentaryXiangqi", {
          playerMove: playerMoveLabel,
          agentMove: agentMoveLabel,
          reason: reasonText
        })
      : t("game.hardModeTurnCommentaryGomoku", {
          playerMove: playerMoveLabel,
          agentMove: agentMoveLabel
        });
  }

  return isXiangqi
    ? t("game.hardModeOpeningCommentaryXiangqi", {
        agentMove: agentMoveLabel,
        reason: reasonText
      })
    : t("game.hardModeOpeningCommentaryGomoku", {
        agentMove: agentMoveLabel
      });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function isNativeRemoteBrowserTarget(value: string | undefined): boolean {
  return remoteBrowserOrigin(value) !== null;
}

function isInsecureRemoteBrowserTarget(value: string | undefined): boolean {
  if (!value || !/^http:\/\//i.test(value)) return false;
  try {
    return !isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

export const isExternalOnlyDraftTarget = isExternalOnlyBrowserTarget;

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
  return <pre className={`browser-document-text draft-document-text ${extension}`}>{formatDocumentContent(extension, content)}</pre>;
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

export function BrowserCanvas({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<BrowserViewport>("responsive");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [documentText, setDocumentText] = useState<string | null>(null);
  const [feedActionId, setFeedActionId] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const nativeHostRef = useRef<HTMLDivElement | null>(null);
  const [nativeBrowserState, setNativeBrowserState] = useState<NativeBrowserState>(
    EMPTY_NATIVE_BROWSER_STATE
  );
  const [containerWidth, setContainerWidth] = useState(440);

  useEffect(() => {
    if (!bodyRef.current) return;
    const update = () => {
      if (bodyRef.current) {
        const w = bodyRef.current.clientWidth;
        if (w > 0) setContainerWidth(w);
      }
    };
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(bodyRef.current);
    return () => observer.disconnect();
  }, []);
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
  const currentUser = useConversationStore((s) => s.currentUser);
  const newConversation = useConversationStore((s) => s.newConversation);
  const sendMessage = useConversationStore((s) => s.sendMessage);
  const isRunning = useConversationStore((s) => (s.activeId ? s.isRunning(s.activeId) : false));
  const feedItems = useFeedStore((s) => s.items);
  const markInterpreted = useFeedStore((s) => s.markInterpreted);
  const entry = useBrowserStore((s) =>
    activeId ? s.byConv[activeId] : undefined
  );
  const active = conversations.find((conv) => conv.id === activeId);
  const hasEntry = Boolean(entry?.url);
  const isMarkdown = isMarkdownTarget(entry?.manualEntry, entry?.url);
  const isImage = isImageBrowserTarget(entry?.manualEntry, entry?.url);
  const isDocument = isDocumentTarget(entry?.manualEntry, entry?.url);
  const isPdf = isPdfTarget(entry?.manualEntry, entry?.url);
  const nativeBrowserAvailable = cliClient.supportsNativeBrowser();
  const isNativeRemote =
    nativeBrowserAvailable && isNativeRemoteBrowserTarget(entry?.manualEntry);
  const isExternalOnly =
    (!isNativeRemote && isExternalOnlyBrowserTarget(entry?.manualEntry)) ||
    (!nativeBrowserAvailable && isInsecureRemoteBrowserTarget(entry?.manualEntry));
  const pdfUrl = isPdf && entry?.url ? `${entry.url}#view=FitH&navpanes=0` : "";
  const documentExtension = browserTargetExtension(entry?.manualEntry, entry?.url);
  const frameWidth = FRAME_WIDTH[viewport];
  const baseScale = frameWidth && frameWidth > containerWidth ? containerWidth / frameWidth : 1;
  const effectiveScale = (isImage ? 1 : zoom) * baseScale;
  const currentFeedItem = useMemo(
    () => feedItems.find((item) => item.link === entry?.manualEntry),
    [feedItems, entry?.manualEntry]
  );
  const isActiveFeedConversation = isFeedInterpretConversation(messages);

  const canGoBack = isNativeRemote
    ? nativeBrowserState.canGoBack
    : Boolean(entry && entry.historyIndex > 0);
  const canGoForward = isNativeRemote
    ? nativeBrowserState.canGoForward
    : Boolean(entry && entry.history && entry.historyIndex < entry.history.length - 1);

  useEffect(() => {
    if (!activeId) return;
    void useBrowserStore.getState().ensureFor(activeId, cwd);
  }, [activeId, cwd]);

  useEffect(() => {
    if (!activeId || active?.kind !== "game") return;
    const gameType = active.metadata?.gameType;
    if (!isBundledGameType(gameType)) return;
    const current = useBrowserStore.getState().byConv[activeId];
    if (current?.manualEntry) return;
    useBrowserStore.getState().navigate(activeId, bundledGameEntry(gameType));
  }, [activeId, active?.kind, active?.metadata]);

  const lastEditPath = useMemo(
    () => extractLastFileEditPath(liveItems, messages),
    [liveItems, messages]
  );

  useEffect(() => {
    if (!activeId || !lastEditPath) return;
    const ext = lastEditPath.split(".").pop()?.toLowerCase();
    const delay = ext === "css" || ext === "html" || ext === "htm" ? 120 : 450;
    useBrowserStore.getState().scheduleReload(activeId, delay);
  }, [activeId, lastEditPath]);

  useEffect(() => {
    if (!entry?.url) return;
    setIsLoading(true);
    setError(null);
    setMarkdown(null);
    setDocumentText(null);
    if (activeId) {
      useBrowserStore.getState().setLoadState(activeId, "loading");
    }
  }, [activeId, entry?.url]);

  useEffect(() => {
    if (!activeId || !entry?.url || !isExternalOnly) return;
    setIsLoading(false);
    useBrowserStore.getState().setLoadState(activeId, "ready");
  }, [activeId, entry?.url, isExternalOnly]);

  useEffect(() => {
    if (!nativeBrowserAvailable) return;
    return cliClient.onNativeBrowserState((state) => {
      setNativeBrowserState(state);
      if (!activeId || !isNativeRemote) return;
      if (state.url) {
        useBrowserStore.getState().setNativeBrowserUrl(activeId, state.url);
      }
      setIsLoading(state.isLoading);
      useBrowserStore
        .getState()
        .setLoadState(activeId, state.isLoading ? "loading" : "ready");
    });
  }, [activeId, isNativeRemote, nativeBrowserAvailable]);

  // Bridge game canvas iframe with FreeBuddy Game Service and Agent session
  const processedMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingGameTurnPromptRef = useRef<{
    conversationId: string;
    prompt: string;
    stepCount: number;
    memberOverride?: CLIMember;
    configOptionOverrides?: Record<string, string>;
  } | null>(null);
  const autoRemindCountRef = useRef(0);
  const lastEngineCommentedStepRef = useRef<number>(-1);

  useEffect(() => {
    pendingGameTurnPromptRef.current = null;
    autoRemindCountRef.current = 0;
    processedMessageIdsRef.current.clear();
    lastEngineCommentedStepRef.current = -1;
  }, [activeId]);

  const activeConversation = useConversationStore((s) =>
    activeId ? s.conversations.find((c) => c.id === activeId) : undefined
  );

  const participants = useMemo(() => {
    if (!activeConversation) return null;
    const meta = (activeConversation.metadata || {}) as Record<string, any>;
    const mode = meta.gameMode || "player_vs_agent";

    if (mode === "agent_vs_agent") {
      const m1 = members.find((m) => m.id === meta.agent1Id) || builtinCliMembers.find((m) => m.id === meta.agent1Id);
      const m2 = members.find((m) => m.id === meta.agent2Id) || builtinCliMembers.find((m) => m.id === meta.agent2Id);

      const avatarUrl1 = resolveAgentAvatarUrl(meta.agent1Id, m1);
      const avatarUrl2 = resolveAgentAvatarUrl(meta.agent2Id, m2);

      return {
        side1: {
          id: String(meta.agent1Id || "agent1"),
          name: String(meta.agent1Name || m1?.name || "AI 1"),
          avatarUrl: avatarUrl1,
          model: meta.agent1Model ? String(meta.agent1Model) : undefined,
          side: 1 as const,
          kind: "agent" as const
        },
        side2: {
          id: String(meta.agent2Id || "agent2"),
          name: String(meta.agent2Name || m2?.name || "AI 2"),
          avatarUrl: avatarUrl2,
          model: meta.agent2Model ? String(meta.agent2Model) : undefined,
          side: 2 as const,
          kind: "agent" as const
        }
      };
    } else if (mode === "agent_vs_engine") {
      const agentSide = (meta.agentSide === 2 ? 2 : 1) as 1 | 2;
      const engSide = (agentSide === 1 ? 2 : 1) as 1 | 2;
      const m = members.find((mem) => mem.id === meta.opponentAgentId || mem.id === activeConversation.agentId) ||
                builtinCliMembers.find((mem) => mem.id === meta.opponentAgentId || mem.id === activeConversation.agentId);
      const agentAvatar = resolveAgentAvatarUrl(meta.opponentAgentId || activeConversation.agentId, m, activeConversation.adapter);
      const agentParticipant = {
        id: String(meta.opponentAgentId || activeConversation.agentId || "agent"),
        name: String(activeConversation.agentName || m?.name || "AI Agent"),
        avatarUrl: agentAvatar,
        model: meta.opponentModel ? String(meta.opponentModel) : undefined,
        side: agentSide,
        kind: "agent" as const
      };
      const engineParticipant = {
        id: "engine",
        name: t("game.engine"),
        side: engSide,
        kind: "engine" as const
      };
      return {
        side1: agentSide === 1 ? agentParticipant : engineParticipant,
        side2: agentSide === 2 ? agentParticipant : engineParticipant
      };
    } else {
      const m = members.find((mem) => mem.id === activeConversation.agentId) ||
                builtinCliMembers.find((mem) => mem.id === activeConversation.agentId);
      const agentAvatar = resolveAgentAvatarUrl(activeConversation.agentId, m, activeConversation.adapter);
      const playerSide = (meta.playerSide ?? 1) as 1 | 2;
      const agSide = (playerSide === 1 ? 2 : 1) as 1 | 2;
      const platform = window.freebuddy?.platform;
      const userAuthor = currentUser?.username?.trim() || (platform !== "web" ? t("sidebar.hostAccount") : "");
      const userInitial = (userAuthor[0] ?? (platform !== "web" ? "H" : "?")).toUpperCase();
      const playerParticipant = {
        id: "player",
        name: userAuthor || t("game.player"),
        initial: userInitial,
        side: playerSide,
        kind: "player" as const
      };
      const agentParticipant = {
        id: activeConversation.agentId,
        name: activeConversation.agentName || m?.name || "AI Agent",
        avatarUrl: agentAvatar,
        side: agSide,
        kind: "agent" as const
      };
      return {
        side1: playerSide === 1 ? playerParticipant : agentParticipant,
        side2: playerSide === 2 ? playerParticipant : agentParticipant
      };
    }
  }, [activeConversation, members, currentUser, t]);

  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  const agentInfo = useMemo(() => {
    if (!activeConversation) return null;
    const member = builtinCliMembers.find((m) => m.id === activeConversation.agentId) ||
                   members.find((m) => m.id === activeConversation.agentId);
    const avatarUrl = resolveAgentAvatarUrl(activeConversation.agentId, member, activeConversation.adapter);
    const model =
      activeConversation.configOptionOverrides?.model ||
      activeConversation.configOptionOverrides?.model_config ||
      (activeConversation.metadata as any)?.model ||
      "";

    return {
      agentId: activeConversation.agentId,
      agentName: activeConversation.agentName || member?.name || "AI Agent",
      avatarUrl: avatarUrl || "",
      modelName: model ? String(model) : ""
    };
  }, [activeConversation, members]);

  const agentInfoRef = useRef(agentInfo);
  agentInfoRef.current = agentInfo;

  useEffect(() => {
    if (frameRef.current?.contentWindow && agentInfo) {
      frameRef.current.contentWindow.postMessage(
        { type: "AGENT_INFO_UPDATE", payload: agentInfo },
        "*"
      );
    }
  }, [agentInfo]);

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !activeId ||
        event.source !== frameRef.current?.contentWindow
      ) return;

      if (data.type === "PLAYER_MOVE" && data.payload?.actionId) {
        const actionId = String(data.payload.actionId);
        try {
          const moveRes = await window.freebuddy?.game?.playerMove(activeId, actionId);

          // Engine rejected the move (e.g. it does not resolve a check).
          // Tell the board so it can revert, and never prompt the agent for
          // an illegal move.
          if (moveRes && moveRes.ok === false) {
            if (frameRef.current?.contentWindow) {
              frameRef.current.contentWindow.postMessage(
                {
                  type: "MOVE_REJECTED",
                  payload: { actionId, error: String(moveRes.error || "") }
                },
                "*"
              );
              try {
                const state = await window.freebuddy?.game?.getState(activeId);
                if (state && frameRef.current?.contentWindow) {
                  frameRef.current.contentWindow.postMessage(
                    {
                      type: "FREEBUDDY_GAME_SYNC",
                      payload: {
                        ...state,
                        participants: participants || state.participants,
                        agentInfo
                      }
                    },
                    "*"
                  );
                }
              } catch {
                /* best effort */
              }
            }
            return;
          }

          const legalMoves = moveRes?.gameState?.legalMoves;
          const candidateList = legalMoves && legalMoves.length > 0
            ? legalMoves.slice(0, 12).map((m: any) => `${m.coord}(${m.description || ""})`).join(", ")
            : "H8, G7, I9, H9";
          const suggestedCoord = legalMoves?.[0]?.coord || "H8";

          if (moveRes?.agentAutoPlayScheduled === true) return;
          if (sendMessage) {
            const isXiangqi = moveRes?.gameState?.gameType === "xiangqi";
            const isWon = moveRes?.gameState?.status === "player_won";
            const promptText = isWon
              ? (isXiangqi ? t("game.playerMoveWonXiangqi", { actionId }) : t("game.playerMoveWonGomoku", { actionId }))
              : (isXiangqi ? t("game.playerMoveXiangqi", { actionId }) : t("game.playerMoveGomoku", { actionId }));

            // The agent may still be streaming its reply for the previous
            // move; sendMessage drops prompts while a run is active, so queue
            // the turn prompt and flush it when generation ends.
            if (useConversationStore.getState().isRunning(activeId)) {
              pendingGameTurnPromptRef.current = {
                conversationId: activeId,
                prompt: promptText,
                stepCount: Number(moveRes?.gameState?.stepCount ?? 0)
              };
            } else {
              void sendMessage({
                conversationId: activeId,
                prompt: promptText
              });
            }
          }
        } catch (err) {
          console.error("[FreeBuddy] Failed to process player game move:", err);
        }
      } else if (data.type === "GAME_CANVAS_READY" || data.type === "REQUEST_SYNC") {
        try {
          const state = await window.freebuddy?.game?.getState(activeId);
          const snapshot = (state as any)?.gameState || state;
          if (snapshot && frameRef.current?.contentWindow) {
            frameRef.current.contentWindow.postMessage(
              {
                type: "FREEBUDDY_GAME_SYNC",
                payload: {
                  ...snapshot,
                  participants: participants || snapshot.participants,
                  agentInfo
                }
              },
              "*"
            );
          }
        } catch (err) {
          console.error("[FreeBuddy] Failed to fetch game state:", err);
        }
      } else if (data.type === "GAME_RESET") {
        try {
          const resetRes = await window.freebuddy?.game?.resetGame(activeId);
          if (sendMessage && resetRes?.agentAutoPlayScheduled !== true) {
            void sendMessage({
              conversationId: activeId,
              prompt: t("game.promptGameReset")
            });
          }
        } catch (err) {
          console.error("[FreeBuddy] Failed to reset game:", err);
        }
      } else if (data.type === "REMIND_AGENT") {
        if (sendMessage) {
          const conv = useConversationStore.getState().conversations.find((c) => c.id === activeId);
          const mode = conv?.metadata?.gameMode || "player_vs_agent";
          let memberOverride: any;
          let configOverrides: any;
          let promptText = t("game.promptRemindAgent");

          if (mode === "agent_vs_agent") {
            const gameStateRes = await window.freebuddy?.game?.getState?.(activeId);
            const snapshot = (gameStateRes as any)?.snapshot;
            if (snapshot && snapshot.status === "playing") {
              const nextSide = snapshot.turn; // 1 or 2
              const nextAgentId = nextSide === 1 ? conv?.metadata?.agent1Id : conv?.metadata?.agent2Id;
              const nextModel = nextSide === 1 ? conv?.metadata?.agent1Model : conv?.metadata?.agent2Model;
              const nextAgentName = nextSide === 1
                ? (conv?.metadata?.agent1Name || "AI 1")
                : (conv?.metadata?.agent2Name || "AI 2");

              memberOverride =
                useConversationStore.getState().members.find((m) => m.id === nextAgentId) ||
                builtinCliMembers.find((m) => m.id === nextAgentId);
              configOverrides = nextModel ? { model: String(nextModel) } : undefined;
              promptText = t("game.promptAvARemind", { nextAgent: nextAgentName });
            }
          }

          void sendMessage({
            conversationId: activeId,
            prompt: promptText,
            memberOverride,
            configOptionOverrides: configOverrides
          });
        }
      } else if (data.type === "GAME_RESIGN") {
        const resignRes = await window.freebuddy?.game?.playerResign(activeId);
        if (resignRes?.ok !== false && sendMessage) {
          void sendMessage({
            conversationId: activeId,
            prompt: t("game.promptResign")
          });
        }
      }
    };

    window.addEventListener("message", handleMessage);
    const unbindGameEvent = window.freebuddy?.game?.onGameEvent((event: any) => {
      if (!activeId || (event?.conversationId && event.conversationId !== activeId)) return;
      if (frameRef.current?.contentWindow && event?.payload) {
        const curParts = participantsRef.current;
        const curAgentInfo = agentInfoRef.current;
        const mergedParts = curParts ? {
          side1: {
            ...(event.payload.participants?.side1 || {}),
            ...curParts.side1,
            avatarUrl: (curParts.side1 as any)?.avatarUrl || event.payload.participants?.side1?.avatarUrl
          },
          side2: {
            ...(event.payload.participants?.side2 || {}),
            ...curParts.side2,
            avatarUrl: (curParts.side2 as any)?.avatarUrl || event.payload.participants?.side2?.avatarUrl
          }
        } : event.payload.participants;

        frameRef.current.contentWindow.postMessage(
          {
            type: "FREEBUDDY_GAME_SYNC",
            payload: {
              ...event.payload,
              participants: mergedParts,
              agentInfo: curAgentInfo
            }
          },
          "*"
        );
      }

      // Multi-mode turn dispatch and commentary
      const snapshot = event?.payload;
      if (
        snapshot &&
        snapshot.lastMove &&
        lastEngineCommentedStepRef.current !== snapshot.stepCount &&
        sendMessage
      ) {
        const conv = useConversationStore.getState().conversations.find((c) => c.id === activeId);
        const mode = conv?.metadata?.gameMode || "player_vs_agent";

        if (mode === "agent_vs_agent") {
          lastEngineCommentedStepRef.current = snapshot.stepCount;
          const moveLabel = snapshot.lastMove.chineseMove
            ? `${snapshot.lastMove.chineseMove} (${snapshot.lastMove.actionId})`
            : snapshot.lastMove.actionId;
          const reasonText = snapshot.lastMove.reason ? `（${snapshot.lastMove.reason}）` : "";

          if (snapshot.status === "playing") {
            const nextSide = snapshot.turn; // 1 or 2
            const nextAgentId = nextSide === 1 ? conv?.metadata?.agent1Id : conv?.metadata?.agent2Id;
            const nextModel = nextSide === 1 ? conv?.metadata?.agent1Model : conv?.metadata?.agent2Model;
            const moverName = nextSide === 1
              ? (conv?.metadata?.agent2Name || t("game.opponent"))
              : (conv?.metadata?.agent1Name || t("game.opponent"));
            const nextAgentName = nextSide === 1
              ? (conv?.metadata?.agent1Name || "AI 1")
              : (conv?.metadata?.agent2Name || "AI 2");

            const member =
              useConversationStore.getState().members.find((m) => m.id === nextAgentId) ||
              builtinCliMembers.find((m) => m.id === nextAgentId);

            const promptText = t("game.promptAvATurn", {
              mover: moverName,
              move: moveLabel,
              reason: reasonText,
              nextAgent: nextAgentName,
              step: snapshot.stepCount
            });

            const configOverrides = nextModel ? { model: String(nextModel) } : undefined;

            if (useConversationStore.getState().isRunning(activeId)) {
              pendingGameTurnPromptRef.current = {
                conversationId: activeId,
                prompt: promptText,
                stepCount: Number(snapshot.stepCount ?? 0),
                memberOverride: member,
                configOptionOverrides: configOverrides
              };
            } else {
              void sendMessage({
                conversationId: activeId,
                prompt: promptText,
                memberOverride: member,
                configOptionOverrides: configOverrides
              });
            }
          } else if (snapshot.status === "player_won" || snapshot.status === "agent_won" || snapshot.winner) {
            const winnerName = snapshot.winner === 1
              ? (conv?.metadata?.agent1Name || "Side 1 AI")
              : (conv?.metadata?.agent2Name || "Side 2 AI");
            const promptText = t("game.promptAvAWon", {
              winner: winnerName,
              move: moveLabel
            });
            if (useConversationStore.getState().isRunning(activeId)) {
              pendingGameTurnPromptRef.current = {
                conversationId: activeId,
                prompt: promptText,
                stepCount: Number(snapshot.stepCount ?? 0)
              };
            } else {
              void sendMessage({ conversationId: activeId, prompt: promptText });
            }
          }
        } else if (mode === "agent_vs_engine") {
          const engSide = typeof conv?.metadata?.engineSide === "number"
            ? conv.metadata.engineSide
            : (conv?.metadata?.hand === "agent_first" ? 2 : 1);

          if (snapshot.lastMove.player === engSide) {
            lastEngineCommentedStepRef.current = snapshot.stepCount;
            const moveLabel = snapshot.lastMove.chineseMove
              ? `${snapshot.lastMove.chineseMove} (${snapshot.lastMove.actionId})`
              : snapshot.lastMove.actionId;

            if (snapshot.status === "playing") {
              const promptText = t("game.promptEngineTurn", {
                engineMove: moveLabel,
                step: snapshot.stepCount
              });
              if (useConversationStore.getState().isRunning(activeId)) {
                pendingGameTurnPromptRef.current = {
                  conversationId: activeId,
                  prompt: promptText,
                  stepCount: Number(snapshot.stepCount ?? 0)
                };
              } else {
                void sendMessage({ conversationId: activeId, prompt: promptText });
              }
            } else if (snapshot.status === "player_won" || snapshot.status === "agent_won" || snapshot.winner) {
              const isAgentWon = snapshot.winner === conv?.metadata?.agentSide;
              const promptText = isAgentWon
                ? t("game.promptAgentVsEngineAgentWon")
                : t("game.promptAgentVsEngineEngineWon");
              if (useConversationStore.getState().isRunning(activeId)) {
                pendingGameTurnPromptRef.current = {
                  conversationId: activeId,
                  prompt: promptText,
                  stepCount: Number(snapshot.stepCount ?? 0)
                };
              } else {
                void sendMessage({ conversationId: activeId, prompt: promptText });
              }
            }
          }
        } else {
          // player_vs_agent
          if (
            conv?.metadata?.gameDifficulty === "hard" &&
            snapshot.lastMove.player === snapshot.agentSide
          ) {
            lastEngineCommentedStepRef.current = snapshot.stepCount;
            const promptText = buildHardModeCommentaryPrompt(snapshot, t);
            if (promptText) {
              if (useConversationStore.getState().isRunning(activeId)) {
                pendingGameTurnPromptRef.current = {
                  conversationId: activeId,
                  prompt: promptText,
                  stepCount: Number(snapshot.stepCount ?? 0)
                };
              } else {
                void sendMessage({
                  conversationId: activeId,
                  prompt: promptText
                });
              }
            }
          }
        }
      }
    });

    return () => {
      window.removeEventListener("message", handleMessage);
      unbindGameEvent?.();
    };
  }, [activeId, agentInfo, participants, sendMessage, t]);

  // Observe assistant messages in game conversations to extract moves or commentary
  useEffect(() => {
    if (!activeId || !messages.length) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      const text = extractAssistantText(lastMsg.content);
      const move = extractAgentMoveFromText(text);
      if (move) {
        const moveKey = `${lastMsg.id}:${move.action}`;
        if (!processedMessageIdsRef.current.has(moveKey)) {
          processedMessageIdsRef.current.add(moveKey);
          void (async () => {
            const state = await window.freebuddy?.game?.getState(activeId);
            if (!state || state.status !== "playing") return;
            // If the move was already placed on the board (e.g. via MCP game_make_move), do not replay it.
            if (state.lastMove?.actionId === move.action) return;

            const conv = useConversationStore.getState().conversations.find((c) => c.id === activeId);
            const mode = conv?.metadata?.gameMode || "player_vs_agent";
            if (mode === "player_vs_agent" && state.turn !== state.agentSide) return;
            if (mode === "agent_vs_engine" && state.turn !== conv?.metadata?.agentSide) return;

            const moveRes = await window.freebuddy?.game?.agentMove(
              activeId,
              move.action,
              move.thought,
              move.speech,
              move.mood
            );
            if (moveRes?.ok !== false) return;

            const refreshed = await window.freebuddy?.game?.getState(activeId);
            if (!refreshed || refreshed.status !== "playing" || refreshed.lastMove?.actionId === move.action) return;
            if (mode === "player_vs_agent" && refreshed.turn !== refreshed.agentSide) return;
            if (mode === "agent_vs_engine" && refreshed.turn !== conv?.metadata?.agentSide) return;

            if (frameRef.current?.contentWindow) {
              frameRef.current.contentWindow.postMessage(
                {
                  type: "FREEBUDDY_GAME_SYNC",
                  payload: {
                    ...refreshed,
                    participants: participants || refreshed.participants,
                    agentInfo
                  }
                },
                "*"
              );
            }
            const prompt = t("game.promptAgentMoveRejected", {
              actionId: move.action,
              error: String(moveRes.error || "illegal move"),
              step: refreshed.stepCount
            });
            if (useConversationStore.getState().isRunning(activeId)) {
              pendingGameTurnPromptRef.current = {
                conversationId: activeId,
                prompt,
                stepCount: refreshed.stepCount
              };
            } else if (sendMessage) {
              void sendMessage({ conversationId: activeId, prompt });
            }
          })().catch((err) => {
            console.error("[FreeBuddy] Failed to recover rejected Agent move:", err);
          });
        }
      }
    }
  }, [activeId, agentInfo, messages, sendMessage, t]);

  // Monitor for abnormal stalls (Agent finished generation but turn has not advanced)
  useEffect(() => {
    if (!activeId) return;
    let timer: NodeJS.Timeout | null = null;

    const checkStall = async () => {
      try {
        const state = await window.freebuddy?.game?.getState(activeId);
        const conv = useConversationStore.getState().conversations.find((c) => c.id === activeId);
        const mode = conv?.metadata?.gameMode || "player_vs_agent";
        const isAgentTurn =
          state &&
          state.status === "playing" &&
          (mode === "agent_vs_agent"
            ? true
            : mode === "agent_vs_engine"
              ? state.turn === conv?.metadata?.agentSide
              : state.turn === state.agentSide);

        if (isAgentTurn) {
          if (frameRef.current?.contentWindow) {
            frameRef.current.contentWindow.postMessage(
              { type: "AGENT_STALLED", payload: { stalled: false } },
              "*"
            );
          }
          if (!isRunning) {
            timer = setTimeout(() => {
              if (autoRemindCountRef.current < 1 && sendMessage) {
                autoRemindCountRef.current += 1;
                let targetMember: CLIMember | undefined;
                let targetModel: string | undefined;
                if (mode === "agent_vs_agent") {
                  const turnAgentId = state.turn === 1 ? conv?.metadata?.agent1Id : conv?.metadata?.agent2Id;
                  const rawModel = state.turn === 1 ? conv?.metadata?.agent1Model : conv?.metadata?.agent2Model;
                  targetModel = rawModel ? String(rawModel) : undefined;
                  targetMember =
                    useConversationStore.getState().members.find((m) => m.id === turnAgentId) ||
                    builtinCliMembers.find((m) => m.id === turnAgentId);
                }
                void sendMessage({
                  conversationId: activeId,
                  prompt: t("game.promptRemindAgentWithTurn", {
                    step: state.stepCount
                  }),
                  memberOverride: targetMember,
                  configOptionOverrides: targetModel ? { model: targetModel } : undefined
                });
                return;
              }
              if (frameRef.current?.contentWindow) {
                frameRef.current.contentWindow.postMessage(
                  { type: "AGENT_STALLED", payload: { stalled: true } },
                  "*"
                );
              }
            }, 3500);
          }
        } else {
          autoRemindCountRef.current = 0;
          if (frameRef.current?.contentWindow) {
            frameRef.current.contentWindow.postMessage(
              { type: "AGENT_STALLED", payload: { stalled: false } },
              "*"
            );
          }
        }
      } catch {
        /* best effort */
      }
    };

    void checkStall();

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [activeId, isRunning, messages, sendMessage, t]);

  // Flush a queued game-turn prompt once the agent finishes generating. This
  // covers the race where a move was processed while the agent was still streaming
  // its reply for the previous move.
  useEffect(() => {
    if (!activeId || isRunning) return;
    const pending = pendingGameTurnPromptRef.current;
    if (!pending || pending.conversationId !== activeId) return;
    pendingGameTurnPromptRef.current = null;
    void (async () => {
      try {
        const state = await window.freebuddy?.game?.getState(activeId);
        if (
          !state ||
          state.status !== "playing" ||
          state.stepCount !== pending.stepCount
        ) return;
        if (!sendMessage) return;
        void sendMessage({
          conversationId: activeId,
          prompt: pending.prompt,
          memberOverride: pending.memberOverride,
          configOptionOverrides: pending.configOptionOverrides
        });
      } catch (err) {
        console.error("[FreeBuddy] Failed to flush queued game turn prompt:", err);
      }
    })();
  }, [activeId, isRunning, messages.length, sendMessage]);

  // RUN_END_RESYNC: converge the board with backend truth whenever a
  // generation run finishes. Protects the iframe from any missed broadcast
  // leaving it stuck on a stale turn indicator.
  useEffect(() => {
    if (!activeId || isRunning) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await window.freebuddy?.game?.getState(activeId);
        if (cancelled || !state || !frameRef.current?.contentWindow) return;
        frameRef.current.contentWindow.postMessage(
          { type: "FREEBUDDY_GAME_SYNC", payload: { ...state, agentInfo } },
          "*"
        );
      } catch {
        /* best effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, isRunning, agentInfo]);

  useEffect(() => {
    if (!nativeBrowserAvailable || !isNativeRemote || !entry?.manualEntry) {
      if (nativeBrowserAvailable) void cliClient.hideNativeBrowser();
      setNativeBrowserState(EMPTY_NATIVE_BROWSER_STATE);
      return;
    }

    let cancelled = false;
    const syncNativeBrowser = async (navigate: boolean) => {
      const host = nativeHostRef.current;
      if (!host || cancelled) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const bounds = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      };
      try {
        const state = navigate
          ? await cliClient.showNativeBrowser(entry.manualEntry!, bounds)
          : await cliClient.setNativeBrowserBounds(bounds);
        if (!cancelled) {
          setNativeBrowserState(state);
          if (activeId && state.url) {
            useBrowserStore.getState().setNativeBrowserUrl(activeId, state.url);
          }
          setIsLoading(state.isLoading);
        }
      } catch (nativeError) {
        if (cancelled) return;
        void cliClient.hideNativeBrowser();
        setError((nativeError as Error)?.message || t("browser.loadError"));
        setIsLoading(false);
        if (activeId) {
          useBrowserStore
            .getState()
            .setLoadState(activeId, "error", t("browser.loadError"));
        }
      }
    };

    const frame = window.requestAnimationFrame(() => void syncNativeBrowser(true));
    const observer = new ResizeObserver(() => void syncNativeBrowser(false));
    if (nativeHostRef.current) observer.observe(nativeHostRef.current);
    const onWindowResize = () => void syncNativeBrowser(false);
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
      void cliClient.hideNativeBrowser();
    };
  }, [activeId, entry?.manualEntry, isNativeRemote, nativeBrowserAvailable, t]);

  useEffect(() => {
    if (!activeId || !entry?.url || (!isMarkdown && !isDocument)) return;
    const absolute = splitAbsoluteLocalFile(entry.manualEntry ?? "");
    const rel = documentRel(entry?.manualEntry);
    const root = absolute?.root ?? cwd;
    const fileRel = absolute?.rel ?? rel;
    if (!root || !fileRel) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    void cliClient
      .readBrowserMarkdown(root, fileRel)
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
        useBrowserStore.getState().setLoadState(activeId, "ready");
      })
      .catch(() => {
        if (cancelled) return;
        setMarkdown(null);
        setDocumentText(null);
        setIsLoading(false);
        setError(t("browser.loadError"));
        useBrowserStore
          .getState()
          .setLoadState(activeId, "error", t("browser.loadError"));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, entry?.manualEntry, entry?.url, isDocument, isMarkdown, t]);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!isImage || zoom <= 1) return;
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX, y: e.clientY };
      panStart.current = { ...pan };
    },
    [isImage, pan, zoom]
  );

  const onDragMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPan({
        x: panStart.current.x + dx,
        y: panStart.current.y + dy
      });
    },
    [isDragging]
  );

  const onImageWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!isImage) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const delta = event.deltaY < 0 ? 0.25 : -0.25;
        setZoom((prev) => clampImageZoom(prev + delta));
      }
    },
    [isImage]
  );

  const onDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleInterpretFeedItem = async (item: FeedItem) => {
    if (!item.link || feedActionId) return;
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
        preserveConversationTitle: true,
        internalPrompt: true
      });
      if (!active || !isActiveFeedConversation) {
        useBrowserStore.getState().navigate(conv.id, item.link);
      }
    } finally {
      setFeedActionId(null);
    }
  };

  const handleMarkFeedItemRead = (item: FeedItem) => {
    markInterpreted(item.id);
  };

  return (
    <div className="browser-canvas draft-canvas">
      <BrowserToolbar
        url={isNativeRemote ? nativeBrowserState.url || entry?.manualEntry : entry?.url}
        target={isNativeRemote ? nativeBrowserState.url || entry?.manualEntry : entry?.manualEntry}
        viewport={viewport}
        zoom={zoom}
        showViewport={!isNativeRemote && !isImage && !isDocument && !isMarkdown && !isPdf}
        showZoom={isImage || isPdf}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isNativeRemote ? nativeBrowserState.isLoading : isLoading}
        feedItem={currentFeedItem}
        feedActionBusy={feedActionId === currentFeedItem?.id}
        onNavigate={(target) => activeId && useBrowserStore.getState().navigate(activeId, target)}
        onGoBack={() => {
          if (isNativeRemote) void cliClient.goBackNativeBrowser();
          else if (activeId) useBrowserStore.getState().goBack(activeId);
        }}
        onGoForward={() => {
          if (isNativeRemote) void cliClient.goForwardNativeBrowser();
          else if (activeId) useBrowserStore.getState().goForward(activeId);
        }}
        onReload={() => {
          if (isNativeRemote) void cliClient.reloadNativeBrowser();
          else if (activeId) useBrowserStore.getState().reload(activeId);
        }}
        onViewportChange={setViewport}
        onZoomChange={setZoom}
        onInterpretFeedItem={handleInterpretFeedItem}
        onMarkFeedItemRead={handleMarkFeedItemRead}
        onClose={onClose}
      />

      <div className="browser-body draft-body" ref={bodyRef}>
        {!hasEntry || !entry ? (
          <div className="browser-empty draft-empty">
            <p>
              {!cwd
                ? t("browser.emptyNoWorkspace")
                : t("browser.emptyNoEntry")}
            </p>
          </div>
        ) : isNativeRemote ? (
          <div
            ref={nativeHostRef}
            className="browser-frame-wrap native-browser-host"
            aria-label={t("browser.isolatedSession")}
          >
            <div className="browser-status draft-status">
              {t("browser.isolatedSessionLoading")}
            </div>
          </div>
        ) : isExternalOnly ? (
          <div className="browser-frame-wrap draft-frame-wrap external-only">
            <div className="browser-external-only draft-external-only">
              <strong>{t("browser.externalOnlyTitle")}</strong>
              <p>
                {t("browser.externalOnlyBody")}
              </p>
              <button
                type="button"
                className="browser-open-external-btn"
                onClick={() => entry.url && cliClient.openBrowserExternal(entry.url)}
              >
                {t("browser.openExternal")}
              </button>
            </div>
          </div>
        ) : isMarkdown ? (
          <div className="browser-frame-wrap draft-frame-wrap markdown">
            <div className="browser-markdown-wrap draft-markdown-wrap">
              {markdown ? <MarkdownText content={markdown} cwd={cwd} /> : <div className="browser-status draft-status">{t("browser.loading")}</div>}
            </div>
          </div>
        ) : isDocument ? (
          <div className="browser-frame-wrap draft-frame-wrap document">
            <div className="browser-document-wrap draft-document-wrap">
              {documentText ? (
                <DocumentText content={documentText} extension={documentExtension} />
              ) : (
                <div className="browser-status draft-status">{t("browser.loading")}</div>
              )}
            </div>
          </div>
        ) : isImage ? (
          <div
            className="browser-frame-wrap draft-frame-wrap image"
            onMouseDown={onDragStart}
            onMouseMove={onDragMove}
            onMouseUp={onDragEnd}
            onMouseLeave={onDragEnd}
            onWheel={onImageWheel}
          >
            <div
              className="browser-image-wrap draft-image-wrap"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                cursor: zoom > 1 ? (isDragging ? "grabbing" : "grab") : "default"
              }}
            >
              <img
                src={entry.url}
                alt={entry.manualEntry || "Image preview"}
                className="browser-image draft-image"
                onLoad={() => {
                  setIsLoading(false);
                  if (activeId) useBrowserStore.getState().setLoadState(activeId, "ready");
                }}
                onError={() => {
                  setIsLoading(false);
                  setError(t("browser.loadError"));
                  if (activeId) useBrowserStore.getState().setLoadState(activeId, "error", "Image load error");
                }}
              />
            </div>
          </div>
        ) : isPdf ? (
          <div className="browser-frame-wrap draft-frame-wrap pdf">
            <iframe
              ref={frameRef}
              src={pdfUrl}
              className="browser-frame draft-frame draft-pdf"
              title={entry.manualEntry || "PDF preview"}
              onLoad={() => {
                setIsLoading(false);
                if (activeId) useBrowserStore.getState().setLoadState(activeId, "ready");
              }}
              onError={() => {
                setIsLoading(false);
                setError(t("browser.loadError"));
                if (activeId) useBrowserStore.getState().setLoadState(activeId, "error", "PDF load error");
              }}
            />
          </div>
        ) : (
          <div
            className="browser-frame-wrap draft-frame-wrap"
            style={{
              width: "100%",
              height: "100%",
              overflow: "hidden",
              display: "flex",
              justifyContent: "center",
              alignItems: "flex-start"
            }}
          >
            <div
              style={
                frameWidth || effectiveScale !== 1
                  ? {
                      width: frameWidth ? `${frameWidth}px` : "100%",
                      height: `${100 / effectiveScale}%`,
                      transform: `scale(${effectiveScale})`,
                      transformOrigin: "top center",
                      flexShrink: 0
                    }
                  : { width: "100%", height: "100%" }
              }
            >
              <iframe
                ref={frameRef}
                src={entry.url}
                className="browser-frame draft-frame"
                title={entry.manualEntry || "Browser frame"}
                sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-same-origin"
                style={{ width: "100%", height: "100%", border: 0 }}
                onLoad={() => {
                  setIsLoading(false);
                  if (activeId) useBrowserStore.getState().setLoadState(activeId, "ready");
                }}
                onError={() => {
                  setIsLoading(false);
                  setError(t("browser.loadError"));
                  if (activeId) useBrowserStore.getState().setLoadState(activeId, "error", "Frame load error");
                }}
              />
            </div>
          </div>
        )}

        {isLoading && <div className="browser-loading-bar draft-loading-bar" />}
        {error && <div className="browser-error-banner draft-error">{error}</div>}
      </div>
    </div>
  );
}

export const DraftCanvas = BrowserCanvas;
