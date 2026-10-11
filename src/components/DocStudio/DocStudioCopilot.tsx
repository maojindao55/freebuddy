import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  Languages,
  ListTree,
  MessageSquarePlus,
  PenLine,
  ScrollText,
  Sparkles,
  X
} from "lucide-react";
import type { DocTab } from "./types";
import { useConversationStore } from "../../store/conversationStore";
import type { CLIMember } from "../../config/aiMembers";
import type { ConversationMessage } from "../../services/cli/types";
import { ChatView } from "../CLI/ChatView";
import { AgentAvatar } from "../CLI/AgentAvatar";
import { AgentPicker } from "../CLI/AgentPicker";
import { cliClient } from "@/services/cli/client";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import {
  agentEntriesNeedingDetection,
  agentEntriesNeedingRefresh,
  buildAgentAvailabilityGroups
} from "@/utils/agentAvailability";
import { useAgentAvailabilityChecks } from "../CLI/useAgentAvailabilityChecks";

interface DocStudioCopilotProps {
  activeTab: DocTab | null;
  initialConversationId?: string;
  initialFilePath?: string;
  initialFilePending: boolean;
  blankConversationId: string | null;
  onBlankConversationChange: (id: string | null) => void;
  onCollapse: () => void;
}

const CONVERSATION_MAP_SETTING = "docStudio.conversationByFile";
const LAST_AGENT_SETTING = "docStudio.agentId";
const NO_MESSAGES: ConversationMessage[] = [];

function dirname(filePath: string): string | undefined {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : undefined;
}

export const DocStudioCopilot: React.FC<DocStudioCopilotProps> = ({
  activeTab,
  initialConversationId,
  initialFilePath,
  initialFilePending,
  blankConversationId,
  onBlankConversationChange,
  onCollapse
}) => {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [defaultDirectory, setDefaultDirectory] = useState<string | null | undefined>(undefined);
  const [officeEngineInstalled, setOfficeEngineInstalled] = useState<boolean | null>(null);
  const [officeEngineInstalling, setOfficeEngineInstalling] = useState(false);
  const [officeEngineProgress, setOfficeEngineProgress] = useState<{ receivedBytes: number; totalBytes: number | null } | null>(null);
  const [officeEngineError, setOfficeEngineError] = useState("");

  const members = useConversationStore((s) => s.members);
  const selectableMembers = useMemo(() => members.filter((member) => !member.profile), [members]);
  const conversations = useConversationStore((s) => s.conversations);
  const executorRuntimes = useCliExecutorStore((s) => s.runtimes);
  const agentAvailability = useMemo(
    () => buildAgentAvailabilityGroups(selectableMembers, executorRuntimes),
    [executorRuntimes, selectableMembers]
  );

  const settingsRef = useRef<{ map: Record<string, string>; agentId?: string; loaded: boolean }>({
    map: {},
    loaded: false
  });
  const storeLoadedRef = useRef(false);
  const resolvedTabPathRef = useRef<string | null | undefined>(undefined);
  const inflightRef = useRef(new Map<string, Promise<string | null>>());
  const reopenedConversationRef = useRef(initialConversationId);
  const { checkingAgentIds, checkAgentEntries } = useAgentAvailabilityChecks();

  useEffect(() => {
    let cancelled = false;
    const ds = window.freebuddy?.docStudio;
    if (!ds?.getDefaultDirectory) {
      setDefaultDirectory(null);
      return;
    }
    void ds.getDefaultDirectory().then(
      (directory) => { if (!cancelled) setDefaultDirectory(directory); },
      () => { if (!cancelled) setDefaultDirectory(null); }
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.getOfficeEngineAddonStatus) {
      setOfficeEngineInstalled(false);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void ds.getOfficeEngineAddonStatus().then(
        (status) => {
          if (cancelled) return;
          setOfficeEngineInstalled(status.installed);
          setOfficeEngineInstalling(status.installing);
        },
        (error: Error) => {
          if (cancelled) return;
          setOfficeEngineInstalled(false);
          setOfficeEngineError(error.message);
        }
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    const offProgress = ds.onOfficeEngineDownloadProgress?.((progress) => {
      if (!cancelled) setOfficeEngineProgress(progress);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      offProgress?.();
    };
  }, []);

  const downloadOfficeEngine = useCallback(async () => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.downloadOfficeEngineAddon) return;
    setOfficeEngineInstalling(true);
    setOfficeEngineProgress(null);
    setOfficeEngineError("");
    try {
      await ds.downloadOfficeEngineAddon();
      setOfficeEngineInstalled(true);
    } catch (error) {
      setOfficeEngineError(error instanceof Error ? error.message : String(error));
      setOfficeEngineInstalled(false);
    } finally {
      setOfficeEngineInstalling(false);
    }
  }, []);

  // Detect agent runtimes once on mount (same as ChatView's agent picker).
  const executorsLoaded = useCliExecutorStore((s) => s.loaded);
  const detectionStartedRef = useRef(false);
  useEffect(() => {
    void useCliExecutorStore.getState().load();
  }, []);
  useEffect(() => {
    if (!executorsLoaded) return;
    const entries = detectionStartedRef.current
      ? agentEntriesNeedingRefresh(agentAvailability)
      : agentEntriesNeedingDetection(agentAvailability);
    detectionStartedRef.current = true;
    void checkAgentEntries(entries);
  }, [executorsLoaded, agentAvailability, checkAgentEntries]);

  const loadSettings = useCallback(async () => {
    if (settingsRef.current.loaded) return;
    settingsRef.current.loaded = true;
    try {
      const [mapRaw, agentRaw] = await Promise.all([
        cliClient.getSetting(CONVERSATION_MAP_SETTING),
        cliClient.getSetting(LAST_AGENT_SETTING)
      ]);
      if (mapRaw) settingsRef.current.map = JSON.parse(mapRaw) as Record<string, string>;
      if (agentRaw) settingsRef.current.agentId = agentRaw;
    } catch {
      /* settings unavailable */
    }
  }, []);

  const pickMember = useCallback(
    (preferredId?: string): CLIMember | undefined => {
      const availableIds = new Set(agentAvailability.available.map((e) => e.member.id));
      const candidates = [
        preferredId,
        settingsRef.current.agentId,
        agentAvailability.available[0]?.member.id,
        selectableMembers[0]?.id
      ];
      for (const id of candidates) {
        if (!id) continue;
        const member = selectableMembers.find((m) => m.id === id);
        if (member && (availableIds.size === 0 || availableIds.has(id))) return member;
      }
      return selectableMembers[0];
    },
    [agentAvailability, selectableMembers]
  );

  const persistMapping = useCallback(async (filePath: string, convId: string) => {
    settingsRef.current.map[filePath] = convId;
    try {
      await cliClient.setSetting(CONVERSATION_MAP_SETTING, JSON.stringify(settingsRef.current.map));
    } catch {
      /* Conversation remains usable even if settings are unavailable. */
    }
  }, []);

  const resolveConversation = useCallback(
    async (tab: DocTab | null, preferredMemberId?: string): Promise<string | null> => {
      if (!cliClient.isAvailable()) return null;
      await loadSettings();
      if (!storeLoadedRef.current) {
        storeLoadedRef.current = true;
        await useConversationStore.getState().load();
      }
      const state = useConversationStore.getState();
      let mappedId = preferredMemberId
        ? undefined
        : tab
          ? (tab.filePath === initialFilePath ? reopenedConversationRef.current : undefined)
            ?? settingsRef.current.map[tab.filePath]
          : blankConversationId ?? undefined;
      if (tab && !preferredMemberId && !mappedId) {
        // The main process may have attached the just-created file to this
        // conversation before notifying the new tab.
        try {
          const raw = await cliClient.getSetting(CONVERSATION_MAP_SETTING);
          if (raw) settingsRef.current.map = JSON.parse(raw) as Record<string, string>;
          mappedId = settingsRef.current.map[tab.filePath];
        } catch {
          /* Fall back to a new conversation for this tab. */
        }
      }
      const existing = mappedId
        ? state.conversations.find((c) => c.id === mappedId)
        : undefined;
      if (existing) {
        if (tab && blankConversationId === existing.id) onBlankConversationChange(null);
        void state.setActive(existing.id);
        void state.loadMessages(existing.id);
        return existing.id;
      }
      const member = pickMember(preferredMemberId);
      if (!member) return null;
      const conv = await state.newConversation({
        member,
        title: tab ? `${t("docStudio.analysisTitle")}: ${tab.fileName}` : t("docStudio.createTitle"),
        kind: "doc-studio",
        metadata: tab ? { docStudioFilePath: tab.filePath } : {},
        cwd: tab ? dirname(tab.filePath) : defaultDirectory ?? undefined
      });
      if (!conv) return null;
      if (tab) await persistMapping(tab.filePath, conv.id);
      else onBlankConversationChange(conv.id);
      void state.loadMessages(conv.id);
      return conv.id;
    },
    [blankConversationId, defaultDirectory, initialFilePath, loadSettings, onBlankConversationChange, persistMapping, pickMember, t]
  );

  const ensureConversation = useCallback(
    (tab: DocTab | null, preferredMemberId?: string): Promise<string | null> => {
      const key = `${tab?.filePath ?? "__blank__"}::${preferredMemberId ?? ""}`;
      const inflight = inflightRef.current.get(key);
      if (inflight) return inflight;
      const promise = resolveConversation(tab, preferredMemberId).finally(() => {
        inflightRef.current.delete(key);
      });
      inflightRef.current.set(key, promise);
      return promise;
    },
    [resolveConversation]
  );

  // Resolve the current document's conversation, or a creation conversation
  // when the standalone studio has no document open.
  useEffect(() => {
    let cancelled = false;
    const tabPath = activeTab?.filePath ?? null;
    if (resolvedTabPathRef.current !== tabPath) {
      resolvedTabPathRef.current = tabPath;
      setConversationId(null);
    }
    if (officeEngineInstalled !== true || initialFilePending || (!activeTab && defaultDirectory === undefined)) {
      setConversationId(null);
      return;
    }
    void ensureConversation(activeTab).then((id) => {
      if (!cancelled) setConversationId(id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.filePath, defaultDirectory, initialFilePending, members, officeEngineInstalled]);

  const conversation = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId]
  );
  useEffect(() => {
    if (!conversationId) return;
    const docStudio = window.freebuddy?.docStudio;
    if (!docStudio?.setActiveConversation) return;
    void docStudio.setActiveConversation(conversationId).catch(() => {});
    return () => { void docStudio.setActiveConversation(null).catch(() => {}); };
  }, [conversationId]);
  const messages = useConversationStore((s) =>
    (conversationId ? s.messages[conversationId] : undefined) ?? NO_MESSAGES
  );
  const live = useConversationStore((s) =>
    conversationId ? s.live[conversationId] : undefined
  );
  const convRunning = live?.status === "starting" || live?.status === "running";
  const convIsEmpty = messages.length === 0 && !convRunning;
  const headerMember = useMemo(() => {
    const id = conversation?.agentId;
    return id ? members.find((m) => m.id === id) : undefined;
  }, [conversation?.agentId, members]);

  // Hidden context envelope prepended to every send (never displayed).
  // The engine handles either the active document or a new blank document.
  const buildHiddenContext = useCallback((): string | undefined => {
    if (!activeTab) {
      return (
        "DocStudio has no document open. The office-engine MCP server is connected. " +
        "When the user asks for a new document, use create_doc, create_sheet, or create_slide, " +
        "edit the returned file_id, then call save_file with that file_id and an explicit absolute " +
        `file_path${defaultDirectory ? ` under ${defaultDirectory} unless the user requests another location` : " chosen with the user"}. ` +
        "Use .docx, .xlsx, or .pptx to match the document type. A saved file opens in a new DocStudio tab. " +
        "Choose a filename that does not overwrite an existing file unless the user explicitly asks for that. " +
        "Do not leave the only copy in the engine's temporary upload directory.\n\n"
      );
    }
    return (
      `[Current Document]: ${activeTab.fileName}\nFile path: ${activeTab.filePath}\n` +
      "Note: This document is open in the embedded office editor and the office-engine MCP server is connected. " +
      "When working on the current document, call open_file with this exact file path, open_with_existing=true and wait=true first. " +
      "This reuses the preview's in-memory editor so unsaved AI edits appear immediately. " +
      "Then use the doc_* / slide_* / sheet_* tools " +
      "(doc_get_outline, doc_find, doc_insert_text, save_file, ...) to read and edit the document. " +
      "Use save_file on the current document only when the user asks to persist changes. " +
      "If the user asks for a separate new document, use create_doc, create_sheet, or create_slide, " +
      `then save_file to an explicit absolute path in ${dirname(activeTab.filePath) ?? "the user's requested directory"} unless the user requests another location. ` +
      "Use .docx, .xlsx, or .pptx and avoid overwriting an existing file unless the user asks. " +
      "The new file will open in another DocStudio tab.\n\n"
    );
  }, [activeTab, defaultDirectory]);

  const getPromptContext = buildHiddenContext;

  const sendQuickPrompt = useCallback(
    async (prompt: string) => {
      const convId = conversationId ?? (await ensureConversation(activeTab));
      if (!convId) return;
      setConversationId(convId);
      await useConversationStore.getState().sendMessage({
        conversationId: convId,
        prompt,
        hiddenContext: buildHiddenContext()
      });
    },
    [activeTab, conversationId, ensureConversation, buildHiddenContext]
  );

  const onAgentChange = useCallback(
    async (memberId: string) => {
      settingsRef.current.agentId = memberId;
      void cliClient.setSetting(LAST_AGENT_SETTING, memberId).catch(() => {});
      if (officeEngineInstalled !== true) return;
      const state = useConversationStore.getState();
      if (conversationId && convIsEmpty) {
        await state.deleteConversation(conversationId).catch(() => {});
      }
      const member = pickMember(memberId);
      if (!member) return;
      const conv = await state.newConversation({
        member,
        title: activeTab ? `${t("docStudio.analysisTitle")}: ${activeTab.fileName}` : t("docStudio.createTitle"),
        kind: "doc-studio",
        metadata: activeTab ? { docStudioFilePath: activeTab.filePath } : {},
        cwd: activeTab ? dirname(activeTab.filePath) : defaultDirectory ?? undefined
      });
      if (conv) {
        reopenedConversationRef.current = undefined;
        if (activeTab) await persistMapping(activeTab.filePath, conv.id);
        else onBlankConversationChange(conv.id);
        void state.loadMessages(conv.id);
        setConversationId(conv.id);
      }
    },
    [activeTab, conversationId, convIsEmpty, defaultDirectory, officeEngineInstalled, onBlankConversationChange, pickMember, persistMapping, t]
  );

  const onNewConversation = useCallback(async () => {
    if (convIsEmpty) return;
    const state = useConversationStore.getState();
    const member = pickMember(conversation?.agentId);
    if (!member) return;
    const conv = await state.newConversation({
      member,
      title: activeTab
        ? `${t("docStudio.analysisTitle")}: ${activeTab.fileName} (${new Date().toLocaleTimeString()})`
        : `${t("docStudio.createTitle")} (${new Date().toLocaleTimeString()})`,
      kind: "doc-studio",
      metadata: activeTab ? { docStudioFilePath: activeTab.filePath } : {},
      cwd: activeTab ? dirname(activeTab.filePath) : defaultDirectory ?? undefined
    });
    if (conv) {
      reopenedConversationRef.current = undefined;
      if (activeTab) await persistMapping(activeTab.filePath, conv.id);
      else onBlankConversationChange(conv.id);
      setConversationId(conv.id);
    }
  }, [activeTab, convIsEmpty, conversation?.agentId, defaultDirectory, onBlankConversationChange, pickMember, persistMapping, t]);
  const isSheet = activeTab ? [".xls", ".xlsx", ".xlt", ".xltx", ".xlsm", ".xltm"].includes(activeTab.ext) : false;
  const quickPrompts = isSheet
    ? [
        { icon: ScrollText, label: t("docStudio.insightLabel"), desc: t("docStudio.insightDesc"), prompt: t("docStudio.insightPrompt") },
        { icon: PenLine, label: t("docStudio.metricsLabel"), desc: t("docStudio.metricsDesc"), prompt: t("docStudio.metricsPrompt") },
        { icon: ListTree, label: t("docStudio.calcColumnLabel"), desc: t("docStudio.calcColumnDesc"), prompt: t("docStudio.calcColumnPrompt") },
        { icon: Languages, label: t("docStudio.anomalyLabel"), desc: t("docStudio.anomalyDesc"), prompt: t("docStudio.anomalyPrompt") }
      ]
    : [
        { icon: ScrollText, label: t("docStudio.summarizeLabel"), desc: t("docStudio.summarizeDesc"), prompt: t("docStudio.summarizePrompt") },
        { icon: PenLine, label: t("docStudio.polishLabel"), desc: t("docStudio.polishDesc"), prompt: t("docStudio.polishPrompt") },
        { icon: ListTree, label: t("docStudio.outlineLabel"), desc: t("docStudio.outlineDesc"), prompt: t("docStudio.outlinePrompt") },
        { icon: Languages, label: t("docStudio.translateLabel"), desc: t("docStudio.translateDesc"), prompt: t("docStudio.translatePrompt") }
      ];
  const extLabel = (activeTab?.ext ?? "").replace(/^\./, "").toUpperCase();

  const emptyState = activeTab ? (
    <div className="ds-copilot-empty">
      <div className="ds-copilot-hero">
        {headerMember && (
          <AgentAvatar
            adapter={headerMember.cli.adapter}
            agentId={headerMember.id}
            className="ds-copilot-hero-avatar"
          />
        )}
        <h4>{t("docStudio.helloTitle", { name: headerMember?.name ?? "" })}</h4>
        <p>{t("docStudio.copilotSubtitle")}</p>
      </div>
      <div className="ds-copilot-doc-card">
        <div className="ds-copilot-doc-icon">
          <FileText size={15} />
        </div>
        <div className="ds-copilot-doc-info">
          <div className="ds-copilot-doc-name" title={activeTab.fileName}>
            {activeTab.fileName}
          </div>
          <div className="ds-copilot-doc-meta">{extLabel}</div>
        </div>
      </div>
      <div className="ds-copilot-doc-tip">
        <FileText size={12} />
        <span>{t("docStudio.docCardTipEngine")}</span>
      </div>
      <div className="ds-copilot-try">{t("docStudio.tryAsking")}</div>
      <div className="ds-copilot-actions">
        {quickPrompts.map((qp, idx) => (
          <button
            key={idx}
            type="button"
            className="ds-copilot-action"
            onClick={() => void sendQuickPrompt(qp.prompt)}
          >
            <qp.icon size={16} className="ds-copilot-action-icon" />
            <span className="ds-copilot-action-title">{qp.label}</span>
            <span className="ds-copilot-action-desc">{qp.desc}</span>
          </button>
        ))}
      </div>
    </div>
  ) : (
    <div className="ds-copilot-empty">
      <div className="ds-copilot-hero">
        <h4>{t("docStudio.createTitle")}</h4>
        <p>{t("docStudio.copilotNoDocHint")}</p>
      </div>
      <div className="ds-copilot-try">{t("docStudio.tryAsking")}</div>
      <div className="ds-copilot-actions">
        {([
          { kind: "doc", labelKey: "docStudio.createDocLabel", promptKey: "docStudio.createDocPrompt" },
          { kind: "sheet", labelKey: "docStudio.createSheetLabel", promptKey: "docStudio.createSheetPrompt" },
          { kind: "slide", labelKey: "docStudio.createSlideLabel", promptKey: "docStudio.createSlidePrompt" }
        ] as const).map(({ kind, labelKey, promptKey }) => (
          <button
            key={kind}
            type="button"
            className="ds-copilot-action"
            onClick={() => void sendQuickPrompt(t(promptKey))}
          >
            <FileText size={16} className="ds-copilot-action-icon" />
            <span className="ds-copilot-action-title">{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ds-copilot">
      <div className="ds-copilot-header">
        {convIsEmpty || !conversationId ? (
          <AgentPicker
            className="ds-agent-title-picker"
            groups={agentAvailability}
            selectedId={conversation?.agentId ?? pickMember()?.id ?? ""}
            checkingIds={checkingAgentIds}
            onChange={(id) => void onAgentChange(id)}
            onOpen={() =>
              void checkAgentEntries(agentEntriesNeedingRefresh(agentAvailability))
            }
          />
        ) : (
          <div className="ds-copilot-agent-static">
            {headerMember && (
              <AgentAvatar
                adapter={headerMember.cli.adapter}
                agentId={headerMember.id}
                className="ds-copilot-agent-avatar"
              />
            )}
            <span className="ds-copilot-title">
              {headerMember?.name ?? t("docStudio.copilotLoading")}
            </span>
          </div>
        )}
        <div className="ds-copilot-header-actions">
          <button
            type="button"
            className="ds-icon-btn"
            onClick={() => void onNewConversation()}
            title={t("docStudio.newSession")}
          >
            <MessageSquarePlus size={15} />
          </button>
          <button
            type="button"
            className="ds-icon-btn"
            onClick={onCollapse}
            title={t("docStudio.collapseCopilot")}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {officeEngineInstalled !== true ? (
        <div className="ds-copilot-empty ds-copilot-empty-centered">
          <div className="ds-copilot-empty-icon"><FileText size={20} /></div>
          <h4>{t("officeEngineAddon.title")}</h4>
          <p>{t(officeEngineInstalled === null ? "docStudio.engineChecking" : "docStudio.engineRequired")}</p>
          {officeEngineInstalled === false && window.freebuddy?.platform === "win32" && window.freebuddy?.arch === "x64" && (
            <button
              type="button"
              className="ds-btn ds-btn-primary"
              disabled={officeEngineInstalling}
              onClick={() => void downloadOfficeEngine()}
            >
              {t(officeEngineInstalling ? "officeEngineAddon.working" : "officeEngineAddon.download")}
            </button>
          )}
          {officeEngineInstalling && officeEngineProgress && (
            <p>{officeEngineProgress.totalBytes
              ? t("officeEngineAddon.progressPercent", { percent: Math.min(100, Math.round(officeEngineProgress.receivedBytes / officeEngineProgress.totalBytes * 100)) })
              : t("officeEngineAddon.progressBytes", { mb: (officeEngineProgress.receivedBytes / 1048576).toFixed(1) })}</p>
          )}
          {officeEngineError && <p role="alert">{officeEngineError}</p>}
        </div>
      ) : conversationId ? (
        <>
        <ChatView
          variant="mini"
          hideHeader
          conversationId={conversationId}
          getPromptContext={getPromptContext}
          emptyState={emptyState}
          placeholder={t(activeTab ? "docStudio.copilotPlaceholder" : "docStudio.createPlaceholder")}
        />
        <div className="ds-copilot-disclaimer">{t("docStudio.aiDisclaimer")}</div>
        </>
      ) : (
        <div className="ds-copilot-empty ds-copilot-empty-centered">
          <div className="ds-copilot-empty-icon">
            <Sparkles size={20} />
          </div>
          <p>{t("docStudio.copilotLoading")}</p>
        </div>
      )}
    </div>
  );
};
