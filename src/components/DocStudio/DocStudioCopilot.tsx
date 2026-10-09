import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  CheckCircle2,
  FileText,
  Languages,
  ListTree,
  LoaderCircle,
  MessageSquarePlus,
  PenLine,
  ScrollText,
  ShieldCheck,
  Sigma,
  Sparkles,
  Table,
  TrendingUp,
  X
} from "lucide-react";
import type { DocTab, SelectionContext } from "./types";
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
import { CellUpdatesSummary } from "./CellUpdatesSummary";
import { usedExtent } from "./utils/sheetParser";

interface DocStudioCopilotProps {
  activeTab: DocTab | null;
  selectionContext: SelectionContext | null;
  onClearSelectionContext: () => void;
  onApplyCellUpdates: (updates: Array<{ cell: string; value: string | number | null; formula?: string }>) => void;
  onAutoApply: (updates: Array<{ cell: string; value: string | number | null; formula?: string }>, messageId: string) => void;
  onUndoAutoApply: () => void;
  autoApplyUndoable: boolean;
  onCollapse: () => void;
}

const CONVERSATION_MAP_SETTING = "docStudio.conversationByFile";
const LAST_AGENT_SETTING = "docStudio.agentId";
const BUTLER_AGENT_ID = "cli-butlerbuddy";
const NO_MESSAGES: ConversationMessage[] = [];

function messageText(msg: ConversationMessage): string {
  if (msg.role === "user" || msg.role === "system") return msg.content;
  try {
    const parsed = JSON.parse(msg.content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) =>
          item?.kind === "text" || item?.kind === "raw" ? item.content || "" : ""
        )
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    return msg.content;
  }
  return msg.content;
}

function parseCellUpdates(text: string): Array<{ cell: string; value: string | number | null; formula?: string }> | null {
  try {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (!match) return null;
    const parsed = JSON.parse(match[1]);
    if (parsed && Array.isArray(parsed.updates) && parsed.updates.length > 0) {
      return parsed.updates;
    }
  } catch {
    return null;
  }
  return null;
}

function dirname(filePath: string): string | undefined {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : undefined;
}

export const DocStudioCopilot: React.FC<DocStudioCopilotProps> = ({
  activeTab,
  selectionContext,
  onClearSelectionContext,
  onApplyCellUpdates,
  onAutoApply,
  onUndoAutoApply,
  autoApplyUndoable,
  onCollapse
}) => {
  const { t } = useTranslation();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [appliedMessageIds, setAppliedMessageIds] = useState<Set<string>>(new Set());
  const [autoAppliedInfo, setAutoAppliedInfo] = useState<{ messageId: string; count: number } | null>(null);

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
  const isSheet = activeTab?.kind === "sheet";
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

  // Auto-apply updates JSON once when a message observed mid-stream turns done.
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const autoAppliedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (live?.messageId && (live.status === "starting" || live.status === "running")) {
      pendingIdsRef.current.add(live.messageId);
    }
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      if (m.status !== "done") {
        pendingIdsRef.current.add(m.id);
        continue;
      }
      if (
        !pendingIdsRef.current.has(m.id) ||
        autoAppliedIdsRef.current.has(m.id)
      ) {
        continue;
      }
      const updates = isSheet ? parseCellUpdates(messageText(m)) : null;
      if (updates && updates.length > 0) {
        autoAppliedIdsRef.current.add(m.id);
        setAutoAppliedInfo({ messageId: m.id, count: updates.length });
        onAutoApply(updates, m.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, live, isSheet]);

  // Hidden context envelope prepended to every send (never displayed).
  const tableSummary = useMemo(() => {
    if (!activeTab) return "";
    if (activeTab.kind === "sheet" && activeTab.sheetData) {
      const sheet = activeTab.sheetData.sheets[activeTab.sheetData.activeSheetIndex || 0];
      if (!sheet) return "";
      const rowsSample: string[] = [];
      const maxRows = Math.min(sheet.rowCount, 10);
      const maxCols = Math.min(sheet.colCount, 12);
      for (let r = 0; r < maxRows; r++) {
        const rowVals: string[] = [];
        let hasVal = false;
        for (let c = 0; c < maxCols; c++) {
          const val = sheet.cells[`${r}:${c}`]?.value ?? "";
          if (val !== "") hasVal = true;
          rowVals.push(String(val));
        }
        if (hasVal) rowsSample.push(`| ${rowVals.join(" | ")} |`);
      }
      return `Sheet: ${sheet.name} (${sheet.rowCount} rows, ${sheet.colCount} cols)\nSample rows:\n${rowsSample.join("\n")}`;
    }
    if (activeTab.content) {
      return `Preview (first 800 chars):\n${activeTab.content.slice(0, 800)}`;
    }
    return "";
  }, [activeTab]);

  const buildHiddenContext = useCallback((): string | undefined => {
    if (!activeTab) return undefined;
    let ctx = "";
    if (selectionContext) {
      ctx += `[Selected Range]: ${selectionContext.rangeLabel}\n`;
      if (selectionContext.headers) {
        ctx += `[Headers]: ${selectionContext.headers.join(", ")}\n`;
      }
      ctx += `[Selection Data]:\n\`\`\`json\n${JSON.stringify(selectionContext.dataPreview.slice(0, 15))}\n\`\`\`\n\n`;
    } else if (tableSummary) {
      ctx += `[Current Document]: ${activeTab.fileName}\n${tableSummary}\n\n`;
    }
    if (activeTab.kind === "sheet") {
      ctx += `Note: To modify the spreadsheet, return the changes as a JSON block in this format — it is applied live to the open sheet:\n\`\`\`json\n{\n  "updates": [\n    { "cell": "F2", "value": 100, "formula": "=SUM(C2:E2)" }\n  ]\n}\n\`\`\`\nDo not rewrite the file on disk unless the user explicitly asks you to.`;
    }
    return ctx || undefined;
  }, [activeTab, selectionContext, tableSummary]);

  const getPromptContext = useCallback(() => {
    const ctx = buildHiddenContext();
    if (selectionContext) onClearSelectionContext();
    return ctx;
  }, [buildHiddenContext, selectionContext, onClearSelectionContext]);

  // "AI Edit" entry point from the sheet: an explicit prompt sends immediately.
  const selectionPromptRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prompt = selectionContext?.initialPrompt;
    if (!prompt || prompt === selectionPromptRef.current) return;
    selectionPromptRef.current = prompt;
    void (async () => {
      if (!activeTab) return;
      const convId = conversationId ?? (await ensureConversation(activeTab));
      if (!convId) return;
      setConversationId(convId);
      await useConversationStore.getState().sendMessage({
        conversationId: convId,
        prompt,
        hiddenContext: getPromptContext()
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionContext]);

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
  const quickPrompts = isSheet
    ? [
        { icon: ScrollText, label: t("docStudio.insightLabel"), desc: t("docStudio.insightDesc"), prompt: t("docStudio.insightPrompt") },
        { icon: TrendingUp, label: t("docStudio.metricsLabel"), desc: t("docStudio.metricsDesc"), prompt: t("docStudio.metricsPrompt") },
        { icon: Sigma, label: t("docStudio.calcColumnLabel"), desc: t("docStudio.calcColumnDesc"), prompt: t("docStudio.calcColumnPrompt") },
        { icon: ShieldCheck, label: t("docStudio.anomalyLabel"), desc: t("docStudio.anomalyDesc"), prompt: t("docStudio.anomalyPrompt") }
      ]
    : [
        { icon: ScrollText, label: t("docStudio.summarizeLabel"), desc: t("docStudio.summarizeDesc"), prompt: t("docStudio.summarizePrompt") },
        { icon: PenLine, label: t("docStudio.polishLabel"), desc: t("docStudio.polishDesc"), prompt: t("docStudio.polishPrompt") },
        { icon: ListTree, label: t("docStudio.outlineLabel"), desc: t("docStudio.outlineDesc"), prompt: t("docStudio.outlinePrompt") },
        { icon: Languages, label: t("docStudio.translateLabel"), desc: t("docStudio.translateDesc"), prompt: t("docStudio.translatePrompt") }
      ];

  const activeSheet =
    activeTab?.kind === "sheet" && activeTab.sheetData
      ? activeTab.sheetData.sheets[activeTab.sheetData.activeSheetIndex || 0]
      : undefined;
  const extLabel = (activeTab?.ext ?? "").replace(/^\./, "").toUpperCase();
  const docMeta = activeTab
    ? isSheet && activeSheet
      ? t("docStudio.docMetaSheet", { ...usedExtent(activeSheet), ext: extLabel })
      : t("docStudio.docMetaText", { chars: (activeTab.content ?? "").length, ext: extLabel })
    : "";

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
          {isSheet ? <Table size={15} /> : <FileText size={15} />}
        </div>
        <div className="ds-copilot-doc-info">
          <div className="ds-copilot-doc-name" title={activeTab.fileName}>
            {activeTab.fileName}
          </div>
          <div className="ds-copilot-doc-meta">{docMeta}</div>
        </div>
      </div>
      <div className="ds-copilot-doc-tip">
        {isSheet ? <Table size={12} /> : <FileText size={12} />}
        <span>{isSheet ? t("docStudio.docCardTipSheet") : t("docStudio.docCardTipText")}</span>
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

  const renderCodeBlock = useCallback(
    (lang: string, code: string, closed: boolean) => {
      if (!/^json$/i.test(lang)) return null;
      if (closed) {
        try {
          const parsed = JSON.parse(code);
          if (Array.isArray(parsed?.updates) && parsed.updates.length > 0) {
            return <CellUpdatesSummary updates={parsed.updates} />;
          }
        } catch {
          return null;
        }
        return null;
      }
      if (code.includes('"updates"')) {
        return (
          <div className="ds-updates-generating">
            <LoaderCircle size={12} className="ds-status-spin" />
            <span>{t("docStudio.updatesGenerating")}</span>
          </div>
        );
      }
      return null;
    },
    [t]
  );

  const selectionChip = selectionContext ? (
    <div className="ds-selection-chip">
      <Table size={13} />
      <span className="ds-selection-chip-label">
        {t("docStudio.selectionAttached", { range: selectionContext.rangeLabel })}
      </span>
      <span className="ds-selection-chip-dims">
        {t("docStudio.rowsCols", {
          rows: selectionContext.endRow - selectionContext.startRow + 1,
          cols: selectionContext.endCol - selectionContext.startCol + 1
        })}
      </span>
      <button
        type="button"
        onClick={onClearSelectionContext}
        title={t("docStudio.removeSelection")}
        aria-label={t("docStudio.removeSelection")}
      >
        <X size={12} />
      </button>
    </div>
  ) : null;

  const renderMessageFooter = useCallback(
    (m: ConversationMessage) => {
      if (!isSheet || m.status !== "done") return null;
      if (autoAppliedInfo?.messageId === m.id) {
        return (
          <div className="ds-apply-card ds-apply-card-applied">
            <CheckCircle2 size={13} />
            <span>{t("docStudio.autoApplied", { count: autoAppliedInfo.count })}</span>
            {autoApplyUndoable && (
              <button
                type="button"
                className="ds-btn ds-btn-secondary ds-btn-sm"
                onClick={onUndoAutoApply}
              >
                {t("docStudio.undo")}
              </button>
            )}
          </div>
        );
      }
      if (appliedMessageIds.has(m.id)) {
        return (
          <div className="ds-apply-card ds-apply-card-applied">
            <CheckCircle2 size={13} />
            <span>{t("docStudio.appliedToTable")}</span>
          </div>
        );
      }
      const updates = parseCellUpdates(messageText(m));
      if (!updates || updates.length === 0) return null;
      return (
        <div className="ds-apply-card">
          <div className="ds-apply-card-info">
            <CheckCircle2 size={13} />
            <span>{t("docStudio.detectedUpdates", { count: updates.length })}</span>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-primary ds-btn-sm"
            onClick={() => {
              onApplyCellUpdates(updates);
              setAppliedMessageIds((prev) => new Set(prev).add(m.id));
            }}
          >
            {t("docStudio.applyToTable")}
          </button>
        </div>
      );
    },
    [isSheet, appliedMessageIds, autoAppliedInfo, autoApplyUndoable, onApplyCellUpdates, onUndoAutoApply, t]
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
          composerAccessory={selectionChip}
          renderMessageFooter={renderMessageFooter}
          renderCodeBlock={isSheet ? renderCodeBlock : undefined}
          emptyState={emptyState}
          placeholder={
            selectionContext
              ? t("docStudio.askPlaceholder", { range: selectionContext.rangeLabel })
              : t("docStudio.copilotPlaceholder")
          }
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
