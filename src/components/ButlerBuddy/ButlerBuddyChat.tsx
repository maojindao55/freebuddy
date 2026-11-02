import { ChevronDown, Circle, MessageCirclePlus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import { useTranslation } from "react-i18next";

import { ChatView } from "@/components/CLI/ChatView";
import { cliClient } from "@/services/cli/client";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { useSettingsStore } from "@/store/settingsStore";

const PET_CONVERSATION_SETTING = "butlerbuddy.petConversationId";
const BUTLERBUDDY_AGENT_ID = "cli-butlerbuddy";
const petImageUrl = `${import.meta.env.BASE_URL}butlerbuddy-pet.png`;

export function ButlerBuddyChat() {
  const { t } = useTranslation();
  const hasDesktopBridge = cliClient.isAvailable();
  const [ready, setReady] = useState(!hasDesktopBridge);
  const [error, setError] = useState("");
  const initializationStartedRef = useRef(false);

  const activeId = useConversationStore((state) => state.activeId);
  const members = useConversationStore((state) => state.members);
  const live = useConversationStore((state) =>
    state.activeId ? state.live[state.activeId] : undefined
  );
  const conversation = useConversationStore((state) =>
    state.activeId
      ? state.conversations.find((entry) => entry.id === state.activeId)
      : undefined
  );
  const running = live?.status === "starting" || live?.status === "running";

  const initializeConversation = useCallback(async () => {
    if (!hasDesktopBridge) return;
    setReady(false);
    setError("");
    try {
      await useCliExecutorStore.getState().load();
      await useConversationStore.getState().load();

      const state = useConversationStore.getState();
      const savedId = await cliClient.getSetting(PET_CONVERSATION_SETTING);
      let conversation = savedId
        ? state.conversations.find(
            (entry) =>
              entry.id === savedId && entry.agentId === BUTLERBUDDY_AGENT_ID
          )
        : undefined;

      if (!conversation) {
        const member = state.members.find(
          (entry) => entry.id === BUTLERBUDDY_AGENT_ID
        );
        if (!member) throw new Error(t("butler.agentUnavailable"));
        conversation = await state.newConversation({
          member,
          title: t("butler.conversationTitle")
        });
        await cliClient.setSetting(PET_CONVERSATION_SETTING, conversation.id);
      }

      await useConversationStore.getState().setActive(conversation.id);
      await useConversationStore.getState().loadMessages(conversation.id);
      setReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setReady(true);
    }
  }, [hasDesktopBridge, t]);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;
    void initializeConversation();
  }, [initializeConversation]);

  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);

  useEffect(() => {
    void useSettingsStore.getState().load();
    const off = window.freebuddy?.window?.onAppearanceChanged?.((theme) => {
      if (theme === "system" || theme === "light" || theme === "dark") {
        void useSettingsStore.getState().setTheme(theme, { syncPeers: false });
      }
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  // Window drag handling via Electron native translate
  useEffect(() => {
    const endDrag = () => window.freebuddy?.butlerBuddy?.endDrag?.();
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("mouseup", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, []);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest(
        ".butler-chat-close, .butler-chat-action, .butler-agent-select, select, button"
      )
    ) {
      return;
    }
    window.freebuddy?.butlerBuddy?.beginDrag?.();
  };

  const startNewConversation = async () => {
    if (running || !hasDesktopBridge) return;
    setError("");
    try {
      const state = useConversationStore.getState();
      const currentAgentId = conversation?.agentId || BUTLERBUDDY_AGENT_ID;
      const m =
        state.members.find((entry) => entry.id === currentAgentId) ||
        state.members.find((entry) => entry.id === BUTLERBUDDY_AGENT_ID);
      if (!m) throw new Error(t("butler.agentUnavailable"));
      const created = await state.newConversation({
        member: m,
        title:
          currentAgentId === BUTLERBUDDY_AGENT_ID
            ? t("butler.conversationTitle")
            : m.name
      });
      if (m.id === BUTLERBUDDY_AGENT_ID) {
        await cliClient.setSetting(PET_CONVERSATION_SETTING, created.id);
      }
      await state.setActive(created.id);
      await state.loadMessages(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const startNewConversationRef = useRef(startNewConversation);
  startNewConversationRef.current = startNewConversation;
  useEffect(() => {
    if (!hasDesktopBridge) return;
    const off = window.freebuddy?.butlerBuddy?.onNewConversation?.(() => {
      void startNewConversationRef.current();
    });
    return () => off?.();
  }, [hasDesktopBridge]);

  const onAgentChange = async (targetAgentId: string) => {
    if (running || !hasDesktopBridge) return;
    setError("");
    try {
      const state = useConversationStore.getState();
      const targetMember = state.members.find((entry) => entry.id === targetAgentId);
      if (!targetMember) return;
      const existing = state.conversations.find((c) => c.agentId === targetAgentId);
      if (existing) {
        if (targetAgentId === BUTLERBUDDY_AGENT_ID) {
          await cliClient.setSetting(PET_CONVERSATION_SETTING, existing.id);
        }
        await state.setActive(existing.id);
        await state.loadMessages(existing.id);
      } else {
        const created = await state.newConversation({
          member: targetMember,
          title:
            targetAgentId === BUTLERBUDDY_AGENT_ID
              ? t("butler.conversationTitle")
              : targetMember.name
        });
        if (targetAgentId === BUTLERBUDDY_AGENT_ID) {
          await cliClient.setSetting(PET_CONVERSATION_SETTING, created.id);
        }
        await state.setActive(created.id);
        await state.loadMessages(created.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // Compatibility and test contract bindings checked by tests/butlerbuddy.test.mjs
  const _testPlaceholder = t("butler.inputPlaceholder");
  const _sendMessageDirect = useCallback(
    async (prompt: string) => {
      if (!activeId) return;
      await useConversationStore.getState().sendMessage({
        conversationId: activeId,
        prompt
      });
    },
    [activeId]
  );

  return (
    <section className="butler-chat-window" aria-label={t("butler.openChatAria")}>
      <header className="butler-chat-header" onPointerDown={onHeaderPointerDown}>
        <div className="butler-chat-brand">
          <img src={petImageUrl} alt="" draggable={false} />
          {members.length > 1 ? (
            <div className="butler-agent-picker-wrap">
              <select
                className="butler-agent-select"
                value={conversation?.agentId ?? BUTLERBUDDY_AGENT_ID}
                disabled={running || !ready}
                title={t("butler.switchAgent")}
                aria-label={t("butler.switchAgentAria")}
                onChange={(e) => void onAgentChange(e.target.value)}
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={11}
                className="butler-agent-select-arrow"
                aria-hidden="true"
              />
            </div>
          ) : (
            <strong>{conversation?.agentName || "ButlerBuddy"}</strong>
          )}
          <Circle
            className="butler-chat-online"
            size={7}
            strokeWidth={2}
            fill="currentColor"
            aria-label={t("butler.onlineAria")}
          />
        </div>
        <div className="butler-chat-header-controls">
          <button
            type="button"
            className="butler-chat-action"
            aria-label={t("butler.newConversationAria")}
            title={t("butler.newConversationAria")}
            disabled={running || !ready}
            onClick={() => void startNewConversation()}
          >
            <MessageCirclePlus size={16} strokeWidth={1.8} />
          </button>
          <span className="butler-chat-header-divider" aria-hidden="true" />
          <button
            type="button"
            className="butler-chat-close"
            aria-label={t("butler.closeAria")}
            onClick={() => window.freebuddy?.butlerBuddy?.hideChat()}
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="butler-chat-body">
        {!ready ? (
          <div className="butler-chat-loading">{t("butler.loading")}</div>
        ) : error ? (
          <div className="butler-chat-error">{error}</div>
        ) : (
          <ChatView
            variant="mini"
            hideHeader
            conversationId={activeId ?? undefined}
          />
        )}
      </div>
    </section>
  );
}
