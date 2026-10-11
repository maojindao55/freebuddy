import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
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
  onCollapse: () => void;
}

const CONVERSATION_MAP_SETTING = "docStudio.conversationByFile";
const LAST_AGENT_SETTING = "docStudio.agentId";
const BUTLER_AGENT_ID = "cli-butlerbuddy";
const NO_MESSAGES: ConversationMessage[] = [];

function dirname(filePath: string): string | undefined {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : undefined;
}

export const DocStudioCopilot: React.FC<DocStudioCopilotProps> = ({
  activeTab,
  onCollapse
}) => {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);

  const members = useConversationStore((s) => s.members);
  const conversations = useConversationStore((s) => s.conversations);
  const executorRuntimes = useCliExecutorStore((s) => s.runtimes);
  const agentAvailability = useMemo(
    () => buildAgentAvailabilityGroups(members, executorRuntimes),
    [executorRuntimes, members]
  );

  const settingsRef = useRef<{ map: Record<string, string>; agentId?: string; loaded: boolean }>({
    map: {},
    loaded: false
  });
  const storeLoadedRef = useRef(false);
  const inflightRef = useRef(new Map<string, Promise<string | null>>());
  const { checkingAgentIds, checkAgentEntries } = useAgentAvailabilityChecks();

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
        BUTLER_AGENT_ID,
        agentAvailability.available[0]?.member.id,
        members[0]?.id
      ];
      for (const id of candidates) {
        if (!id) continue;
        const member = members.find((m) => m.id === id);
        if (member && (availableIds.size === 0 || availableIds.has(id))) return member;
      }
      return members[0];
    },
    [agentAvailability, members]
  );

  const persistMapping = useCallback((filePath: string, convId: string) => {
    settingsRef.current.map[filePath] = convId;
    void cliClient
      .setSetting(CONVERSATION_MAP_SETTING, JSON.stringify(settingsRef.current.map))
      .catch(() => {});
  }, []);

  const resolveConversation = useCallback(
    async (tab: DocTab, preferredMemberId?: string): Promise<string | null> => {
      if (!cliClient.isAvailable()) return null;
      await loadSettings();
      if (!storeLoadedRef.current) {
        storeLoadedRef.current = true;
        await useConversationStore.getState().load();
      }
      const member = pickMember(preferredMemberId);
      if (!member) return null;
      const state = useConversationStore.getState();
      const mappedId = preferredMemberId ? undefined : settingsRef.current.map[tab.filePath];
      const existing = mappedId
        ? state.conversations.find((c) => c.id === mappedId)
        : undefined;
      if (existing) {
        void state.setActive(existing.id);
        void state.loadMessages(existing.id);
        return existing.id;
      }
      const conv = await state.newConversation({
        member,
        title: `${t("docStudio.analysisTitle")}: ${tab.fileName}`,
        cwd: dirname(tab.filePath)
      });
      if (!conv) return null;
      persistMapping(tab.filePath, conv.id);
      void state.loadMessages(conv.id);
      return conv.id;
    },
    [loadSettings, persistMapping, pickMember, t]
  );

  const ensureConversation = useCallback(
    (tab: DocTab, preferredMemberId?: string): Promise<string | null> => {
      const key = `${tab.filePath}::${preferredMemberId ?? ""}`;
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

  // Resolve the conversation for the active document.
  useEffect(() => {
    let cancelled = false;
    if (!activeTab) {
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
  }, [activeTab?.filePath, members]);

  const conversation = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId]
  );
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
  // Engine-only: the document is open in the embedded office editor and the
  // office-engine MCP server is connected.
  const buildHiddenContext = useCallback((): string | undefined => {
    if (!activeTab) return undefined;
    return (
      `[Current Document]: ${activeTab.fileName}\nFile path: ${activeTab.filePath}\n` +
      "Note: This document is open in the embedded office editor and the office-engine MCP server is connected. " +
      "Call open_file with this exact file path, open_with_existing=true and wait=true first. " +
      "This reuses the preview's in-memory editor so unsaved AI edits appear immediately. " +
      "Then use the doc_* / slide_* / sheet_* tools " +
      "(doc_get_outline, doc_find, doc_insert_text, save_file, ...) to read and edit the document. " +
      "Use save_file only when the user asks to persist changes.\n\n"
    );
  }, [activeTab]);

  const getPromptContext = buildHiddenContext;

  const sendQuickPrompt = useCallback(
    async (prompt: string) => {
      if (!activeTab) return;
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
      if (!activeTab) return;
      settingsRef.current.agentId = memberId;
      void cliClient.setSetting(LAST_AGENT_SETTING, memberId).catch(() => {});
      const state = useConversationStore.getState();
      if (conversationId && convIsEmpty) {
        await state.deleteConversation(conversationId).catch(() => {});
      }
      const member = pickMember(memberId);
      if (!member) return;
      const conv = await state.newConversation({
        member,
        title: `${t("docStudio.analysisTitle")}: ${activeTab.fileName}`,
        cwd: dirname(activeTab.filePath)
      });
      if (conv) {
        persistMapping(activeTab.filePath, conv.id);
        void state.loadMessages(conv.id);
        setConversationId(conv.id);
      }
    },
    [activeTab, conversationId, convIsEmpty, pickMember, persistMapping, t]
  );

  const onNewConversation = useCallback(async () => {
    if (!activeTab || convIsEmpty) return;
    const state = useConversationStore.getState();
    const member = pickMember(conversation?.agentId);
    if (!member) return;
    const conv = await state.newConversation({
      member,
      title: `${t("docStudio.analysisTitle")}: ${activeTab.fileName} (${new Date().toLocaleTimeString()})`,
      cwd: dirname(activeTab.filePath)
    });
    if (conv) {
      persistMapping(activeTab.filePath, conv.id);
      setConversationId(conv.id);
    }
  }, [activeTab, convIsEmpty, conversation?.agentId, pickMember, persistMapping, t]);
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
  ) : undefined;

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
            <button
              type="button"
              className="ds-icon-btn ds-copilot-open-main"
              onClick={() =>
                void window.freebuddy?.docStudio?.openConversationInMain(conversationId)
              }
              title={t("docStudio.openInMain")}
            >
              <ArrowUpRight size={13} />
            </button>
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

      {activeTab ? (
        conversationId ? (
        <>
        <ChatView
          variant="mini"
          hideHeader
          conversationId={conversationId}
          getPromptContext={getPromptContext}
          emptyState={emptyState}
          placeholder={t("docStudio.copilotPlaceholder")}
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
        )
      ) : (
        <div className="ds-copilot-empty ds-copilot-empty-centered">
          <div className="ds-copilot-empty-icon">
            <Sparkles size={20} />
          </div>
          <h4>{t("docStudio.copilotTitle")}</h4>
          <p>{t("docStudio.copilotNoDocHint")}</p>
        </div>
      )}
    </div>
  );
};
