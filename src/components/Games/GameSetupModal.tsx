import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Swords, User, ShieldAlert, X } from "lucide-react";

import type { CLIMember } from "@/config/aiMembers";
import { builtinCliMembers } from "@/config/aiMembers";
import { cliClient } from "@/services/cli/client";
import type {
  SessionConfigOption,
  SessionConfigProbeInput
} from "@/services/cli/types";
import { findMainModelConfigOption } from "@/utils/sessionConfigOptions";
import { bundledGameEntry, useBrowserStore } from "@/store/browserStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { useDetailLayoutStore } from "@/store/detailLayoutStore";

export interface GameSetupModalProps {
  open: boolean;
  onClose: () => void;
}

export type SupportedGameType = "gomoku" | "chinese_chess" | "go";
export type GameBattleMode = "player_vs_agent" | "agent_vs_agent" | "agent_vs_engine";

interface GameOptionDef {
  id: SupportedGameType;
  titleKey: string;
  ready: boolean;
  tagKey?: string;
}

const AVAILABLE_GAMES: GameOptionDef[] = [
  {
    id: "gomoku",
    titleKey: "game.gomoku",
    ready: true
  },
  {
    id: "chinese_chess",
    titleKey: "game.xiangqi",
    ready: true
  },
  {
    id: "go",
    titleKey: "game.go",
    ready: false,
    tagKey: "game.comingSoon"
  }
];

const AVAILABLE_MODES: {
  id: GameBattleMode;
  titleKey: string;
  descKey: string;
  icon: typeof User;
}[] = [
  {
    id: "player_vs_agent",
    titleKey: "game.modePlayerVsAgent",
    descKey: "game.modePlayerVsAgentDesc",
    icon: User
  },
  {
    id: "agent_vs_agent",
    titleKey: "game.modeAgentVsAgent",
    descKey: "game.modeAgentVsAgentDesc",
    icon: Swords
  },
  {
    id: "agent_vs_engine",
    titleKey: "game.modeAgentVsEngine",
    descKey: "game.modeAgentVsEngineDesc",
    icon: ShieldAlert
  }
];

export function GameSetupModal({ open, onClose }: GameSetupModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const modalRef = useRef<HTMLDivElement>(null);

  const convStore = useConversationStore();
  const isPlayableGameAgent = useCallback(
    (m: CLIMember) => m.enabled !== false && !m.profile,
    []
  );

  const playableMembers = useMemo(
    () => convStore.members.filter(isPlayableGameAgent),
    [convStore.members, isPlayableGameAgent]
  );
  const fallbackBuiltin = useMemo(
    () => builtinCliMembers.filter(isPlayableGameAgent),
    [isPlayableGameAgent]
  );
  const members = useMemo(
    () => (playableMembers.length > 0 ? playableMembers : fallbackBuiltin),
    [playableMembers, fallbackBuiltin]
  );

  const [selectedMode, setSelectedMode] = useState<GameBattleMode>("player_vs_agent");
  const [selectedGame, setSelectedGame] = useState<SupportedGameType>("gomoku");
  const [selectedDifficulty, setSelectedDifficulty] = useState<"easy" | "hard">("easy");
  const [isLaunching, setIsLaunching] = useState(false);

  // Player vs Agent fields
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedHand, setSelectedHand] = useState<"player_first" | "agent_first">("player_first");

  // Agent vs Agent fields
  const [agent1Id, setAgent1Id] = useState<string>("");
  const [agent1Model, setAgent1Model] = useState<string>("");
  const [agent2Id, setAgent2Id] = useState<string>("");
  const [agent2Model, setAgent2Model] = useState<string>("");

  // Agent vs Engine fields
  const [challengerHand, setChallengerHand] = useState<"agent_first" | "engine_first">("agent_first");

  // Model probing states
  const [modelOptionsByAgent, setModelOptionsByAgent] = useState<
    Record<string, SessionConfigOption[]>
  >({});
  const [modelLoadingByAgent, setModelLoadingByAgent] = useState<
    Record<string, boolean>
  >({});

  // Initialize selected agents
  useEffect(() => {
    if (!open) return;
    const defaultAgent = members[0] || fallbackBuiltin[0] || builtinCliMembers[0];

    if (!selectedAgentId || !members.some((m) => m.id === selectedAgentId)) {
      if (defaultAgent) setSelectedAgentId(defaultAgent.id);
    }
    if (!agent1Id || !members.some((m) => m.id === agent1Id)) {
      if (defaultAgent) setAgent1Id(defaultAgent.id);
    }
    if (!agent2Id || !members.some((m) => m.id === agent2Id)) {
      const secondAgent =
        members.find((m) => m.id !== defaultAgent?.id) || members[0] || defaultAgent;
      if (secondAgent) setAgent2Id(secondAgent.id);
    }
  }, [open, members, fallbackBuiltin, selectedAgentId, agent1Id, agent2Id]);

  const selectedMember: CLIMember | undefined = useMemo(() => {
    return (
      members.find((m) => m.id === selectedAgentId) ||
      fallbackBuiltin.find((m) => m.id === selectedAgentId) ||
      members[0] ||
      fallbackBuiltin[0]
    );
  }, [members, fallbackBuiltin, selectedAgentId]);

  const agent1Member: CLIMember | undefined = useMemo(() => {
    return (
      members.find((m) => m.id === agent1Id) ||
      fallbackBuiltin.find((m) => m.id === agent1Id) ||
      selectedMember
    );
  }, [members, fallbackBuiltin, agent1Id, selectedMember]);

  const agent2Member: CLIMember | undefined = useMemo(() => {
    return (
      members.find((m) => m.id === agent2Id) ||
      fallbackBuiltin.find((m) => m.id === agent2Id) ||
      members[1] ||
      selectedMember
    );
  }, [members, fallbackBuiltin, agent2Id, selectedMember]);

  // Session probe input helper
  const sessionProbeInputForAgent = useCallback(
    (agentId: string): SessionConfigProbeInput | undefined => {
      const member =
        members.find((entry) => entry.id === agentId) ||
        builtinCliMembers.find((entry) => entry.id === agentId);
      if (!member) return undefined;
      const resolved = useCliExecutorStore
        .getState()
        .resolve(member.cli.adapter);
      return {
        agentId: member.id,
        adapter: member.cli.adapter,
        binary: member.cli.binary || resolved?.binary,
        extraArgs: [
          ...(resolved?.extraArgs ?? []),
          ...(member.cli.extraArgs ?? [])
        ],
        env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) }
      };
    },
    [members]
  );

  // Probe models for selected agent
  const refreshAgentModels = useCallback(
    async (agentId: string) => {
      if (!agentId || !cliClient.isAvailable()) return;
      const input = sessionProbeInputForAgent(agentId);
      if (!input) return;

      setModelLoadingByAgent((prev) => ({ ...prev, [agentId]: true }));
      try {
        const cached = await cliClient.getCachedSessionConfigOptions(input);
        if (cached && cached.length > 0) {
          setModelOptionsByAgent((prev) => ({ ...prev, [agentId]: cached }));
        }
        const fresh = await cliClient.inspectSessionConfigOptions(input);
        if (fresh && fresh.length > 0) {
          setModelOptionsByAgent((prev) => ({ ...prev, [agentId]: fresh }));
        }
      } catch (err) {
        console.warn("[FreeBuddy] Failed to probe model options for agent:", agentId, err);
      } finally {
        setModelLoadingByAgent((prev) => ({ ...prev, [agentId]: false }));
      }
    },
    [sessionProbeInputForAgent]
  );

  // Load models whenever active agents change
  useEffect(() => {
    if (!open) return;
    if (selectedAgentId && !modelOptionsByAgent[selectedAgentId]) {
      void refreshAgentModels(selectedAgentId);
    }
    if (agent1Id && !modelOptionsByAgent[agent1Id]) {
      void refreshAgentModels(agent1Id);
    }
    if (agent2Id && !modelOptionsByAgent[agent2Id]) {
      void refreshAgentModels(agent2Id);
    }
  }, [open, selectedAgentId, agent1Id, agent2Id, modelOptionsByAgent, refreshAgentModels]);

  const getAvailableModelsForAgent = (agentId: string) => {
    if (!agentId) return [];
    const options = modelOptionsByAgent[agentId] ?? [];
    const opt = findMainModelConfigOption(options);
    return opt?.values ?? [];
  };

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleLaunchMatch = async () => {
    if (isLaunching) return;
    setIsLaunching(true);
    try {
      const gameName = selectedGame === "chinese_chess" ? t("game.xiangqi") : t("game.gomoku");
      const gamePath = selectedGame === "chinese_chess" ? "xiangqi" : selectedGame;

      if (selectedMode === "player_vs_agent") {
        if (!selectedMember) return;
        const modelName = selectedModel ? ` (${selectedModel})` : "";
        const title = `[${gameName}] vs ${selectedMember.name}${modelName}`;

        const modelOptions = modelOptionsByAgent[selectedMember.id] ?? [];
        const modelOption = findMainModelConfigOption(modelOptions);
        const modelOptionId = modelOption?.id ?? "model";
        const configOverrides = selectedModel ? { [modelOptionId]: selectedModel } : undefined;

        const conv = await convStore.newConversation({
          member: selectedMember,
          title,
          kind: "game",
          metadata: {
            gameType: gamePath,
            gameMode: "player_vs_agent",
            opponentAgentId: selectedMember.id,
            opponentModel: selectedModel || undefined,
            hand: selectedHand,
            gameDifficulty: selectedDifficulty,
            playerSide: selectedHand === "player_first" ? 1 : 2,
            agentSide: selectedHand === "player_first" ? 2 : 1
          },
          configOptionOverrides: configOverrides,
          skillIds: ["game-arena"]
        });

        useBrowserStore.getState().navigate(conv.id, bundledGameEntry(gamePath));
        useDetailLayoutStore.getState().setActiveTab("preview");
        useDetailLayoutStore.getState().setDetailCollapsed(false);

        if (!(selectedDifficulty === "hard" && selectedHand === "agent_first")) {
          if (selectedGame === "chinese_chess") {
            void convStore.sendMessage({
              conversationId: conv.id,
              prompt: selectedHand === "player_first"
                ? t("game.promptXiangqiPlayerFirst")
                : t("game.promptXiangqiAgentFirst")
            });
          } else {
            void convStore.sendMessage({
              conversationId: conv.id,
              prompt: selectedHand === "player_first"
                ? t("game.promptGomokuPlayerFirst")
                : t("game.promptGomokuAgentFirst")
            });
          }
        }
      } else if (selectedMode === "agent_vs_agent") {
        if (!agent1Member || !agent2Member) return;
        const title = `[${gameName} ${t("game.modeAgentVsAgent")}] ${agent1Member.name} VS ${agent2Member.name}`;

        const modelOptions1 = modelOptionsByAgent[agent1Member.id] ?? [];
        const modelOption1 = findMainModelConfigOption(modelOptions1);
        const modelOptionId1 = modelOption1?.id ?? "model";
        const configOverrides1 = agent1Model ? { [modelOptionId1]: agent1Model } : undefined;

        const conv = await convStore.newConversation({
          member: agent1Member,
          title,
          kind: "game",
          metadata: {
            gameType: gamePath,
            gameMode: "agent_vs_agent",
            agent1Id: agent1Member.id,
            agent1Name: agent1Member.name,
            agent1Model: agent1Model || undefined,
            agent2Id: agent2Member.id,
            agent2Name: agent2Member.name,
            agent2Model: agent2Model || undefined,
            gameDifficulty: "easy",
            playerSide: 0,
            agentSide: 1
          },
          configOptionOverrides: configOverrides1,
          skillIds: ["game-arena"]
        });

        useBrowserStore.getState().navigate(conv.id, bundledGameEntry(gamePath));
        useDetailLayoutStore.getState().setActiveTab("preview");
        useDetailLayoutStore.getState().setDetailCollapsed(false);

        const startPrompt = selectedGame === "chinese_chess"
          ? t("game.promptXiangqiAvAStart", { agent1: agent1Member.name, agent2: agent2Member.name })
          : t("game.promptGomokuAvAStart", { agent1: agent1Member.name, agent2: agent2Member.name });

        void convStore.sendMessage({
          conversationId: conv.id,
          prompt: startPrompt,
          memberOverride: agent1Member,
          configOptionOverrides: configOverrides1
        });
      } else if (selectedMode === "agent_vs_engine") {
        if (!selectedMember) return;
        const title = `[${gameName} ${t("game.modeAgentVsEngine")}] ${selectedMember.name} VS AlphaEngine`;

        const modelOptions = modelOptionsByAgent[selectedMember.id] ?? [];
        const modelOption = findMainModelConfigOption(modelOptions);
        const modelOptionId = modelOption?.id ?? "model";
        const configOverrides = selectedModel ? { [modelOptionId]: selectedModel } : undefined;

        const agentSide = challengerHand === "agent_first" ? 1 : 2;
        const engineSide = challengerHand === "agent_first" ? 2 : 1;

        const conv = await convStore.newConversation({
          member: selectedMember,
          title,
          kind: "game",
          metadata: {
            gameType: gamePath,
            gameMode: "agent_vs_engine",
            opponentAgentId: selectedMember.id,
            opponentModel: selectedModel || undefined,
            hand: challengerHand,
            agentSide,
            engineSide,
            gameDifficulty: "hard",
            playerSide: 0
          },
          configOptionOverrides: configOverrides,
          skillIds: ["game-arena"]
        });

        useBrowserStore.getState().navigate(conv.id, bundledGameEntry(gamePath));
        useDetailLayoutStore.getState().setActiveTab("preview");
        useDetailLayoutStore.getState().setDetailCollapsed(false);

        if (challengerHand === "agent_first") {
          const startPrompt = selectedGame === "chinese_chess"
            ? t("game.promptXiangqiAvEStartAgentFirst")
            : t("game.promptGomokuAvEStartAgentFirst");
          void convStore.sendMessage({
            conversationId: conv.id,
            prompt: startPrompt,
            memberOverride: selectedMember,
            configOptionOverrides: configOverrides
          });
        }
      }

      onClose();
    } catch (err) {
      console.error("[FreeBuddy] Failed to launch game match:", err);
    } finally {
      setIsLaunching(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="modal game-setup-dialog"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="game-setup-dialog-header">
          <div>
            <h3 id={titleId}>{t("game.gameLobbyTitle")}</h3>
            <p id={descriptionId} className="game-setup-dialog-desc">
              {t("game.gameLobbyDesc")}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="game-setup-dialog-form">
          {/* Battle Mode Selection */}
          <div className="game-setup-field">
            <span className="game-setup-field-label">{t("game.battleMode")}</span>
            <div className="game-setup-choice-group three-cols">
              {AVAILABLE_MODES.map((mode) => {
                const IconComponent = mode.icon;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={selectedMode === mode.id ? "active" : ""}
                    onClick={() => setSelectedMode(mode.id)}
                  >
                    <IconComponent size={14} style={{ marginRight: 6, verticalAlign: "middle" }} />
                    {t(mode.titleKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Game Project Selection */}
          <div className="game-setup-field">
            <span className="game-setup-field-label">{t("game.gameProject")}</span>
            <div className="game-setup-choice-group">
              {AVAILABLE_GAMES.map((game) => (
                <button
                  key={game.id}
                  type="button"
                  className={selectedGame === game.id ? "active" : ""}
                  disabled={!game.ready}
                  onClick={() => game.ready && setSelectedGame(game.id)}
                >
                  {t(game.titleKey)}
                  {game.tagKey ? ` (${t(game.tagKey)})` : ""}
                </button>
              ))}
            </div>
          </div>

          {/* Dynamic Configuration per Battle Mode */}
          {selectedMode === "player_vs_agent" && (
            <>
              {/* AI Agent Selection */}
              <div className="game-setup-field">
                <span className="game-setup-field-label">{t("game.aiOpponent")}</span>
                <div className="custom-select-wrapper">
                  <select
                    value={selectedAgentId}
                    onChange={(e) => {
                      setSelectedAgentId(e.target.value);
                      setSelectedModel("");
                    }}
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.cli.adapter})
                      </option>
                    ))}
                  </select>
                  <span className="custom-select-arrow">
                    <ChevronDown size={14} />
                  </span>
                </div>
              </div>

              {/* Model & Hand in 2 Columns */}
              <div className="game-setup-grid-row">
                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.gameModel")}</span>
                  <div className="custom-select-wrapper">
                    <select
                      value={selectedModel}
                      onFocus={() => selectedAgentId && void refreshAgentModels(selectedAgentId)}
                      onChange={(e) => setSelectedModel(e.target.value)}
                    >
                      <option value="">{t("game.defaultModel")}</option>
                      {modelLoadingByAgent[selectedAgentId] && getAvailableModelsForAgent(selectedAgentId).length === 0 ? (
                        <option disabled>{t("game.loadingModels")}</option>
                      ) : null}
                      {getAvailableModelsForAgent(selectedAgentId).map((val) => (
                        <option key={val.id} value={val.id}>
                          {val.name || val.id}
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>

                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.turnOrder")}</span>
                  <div className="game-setup-choice-group two-cols">
                    <button
                      type="button"
                      className={selectedHand === "player_first" ? "active" : ""}
                      onClick={() => setSelectedHand("player_first")}
                    >
                      {t("game.playerFirst", {
                        piece: selectedGame === "chinese_chess" ? t("game.pieceRed") : t("game.pieceBlack")
                      })}
                    </button>
                    <button
                      type="button"
                      className={selectedHand === "agent_first" ? "active" : ""}
                      onClick={() => setSelectedHand("agent_first")}
                    >
                      {t("game.agentFirst", {
                        piece: selectedGame === "chinese_chess" ? t("game.pieceRed") : t("game.pieceBlack")
                      })}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {selectedMode === "agent_vs_agent" && (
            <>
              {/* Agent 1 (First Move) */}
              <div className="game-setup-grid-row">
                <div className="game-setup-field">
                  <span className="game-setup-field-label">
                    {t("game.agent1", {
                      piece: selectedGame === "chinese_chess" ? t("game.pieceRed") : t("game.pieceBlack")
                    })}
                  </span>
                  <div className="custom-select-wrapper">
                    <select
                      value={agent1Id}
                      onChange={(e) => {
                        setAgent1Id(e.target.value);
                        setAgent1Model("");
                      }}
                    >
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.cli.adapter})
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>

                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.gameModel")} (1)</span>
                  <div className="custom-select-wrapper">
                    <select
                      value={agent1Model}
                      onFocus={() => agent1Id && void refreshAgentModels(agent1Id)}
                      onChange={(e) => setAgent1Model(e.target.value)}
                    >
                      <option value="">{t("game.defaultModel")}</option>
                      {getAvailableModelsForAgent(agent1Id).map((val) => (
                        <option key={val.id} value={val.id}>
                          {val.name || val.id}
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>
              </div>

              {/* Agent 2 (Second Move) */}
              <div className="game-setup-grid-row">
                <div className="game-setup-field">
                  <span className="game-setup-field-label">
                    {t("game.agent2", {
                      piece: selectedGame === "chinese_chess" ? t("game.pieceBlack") : t("game.pieceRed")
                    })}
                  </span>
                  <div className="custom-select-wrapper">
                    <select
                      value={agent2Id}
                      onChange={(e) => {
                        setAgent2Id(e.target.value);
                        setAgent2Model("");
                      }}
                    >
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({m.cli.adapter})
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>

                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.gameModel")} (2)</span>
                  <div className="custom-select-wrapper">
                    <select
                      value={agent2Model}
                      onFocus={() => agent2Id && void refreshAgentModels(agent2Id)}
                      onChange={(e) => setAgent2Model(e.target.value)}
                    >
                      <option value="">{t("game.defaultModel")}</option>
                      {getAvailableModelsForAgent(agent2Id).map((val) => (
                        <option key={val.id} value={val.id}>
                          {val.name || val.id}
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {selectedMode === "agent_vs_engine" && (
            <>
              {/* Challenger Agent Selection */}
              <div className="game-setup-field">
                <span className="game-setup-field-label">{t("game.challengerAgent")}</span>
                <div className="custom-select-wrapper">
                  <select
                    value={selectedAgentId}
                    onChange={(e) => {
                      setSelectedAgentId(e.target.value);
                      setSelectedModel("");
                    }}
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.cli.adapter})
                      </option>
                    ))}
                  </select>
                  <span className="custom-select-arrow">
                    <ChevronDown size={14} />
                  </span>
                </div>
              </div>

              {/* Model & Hand */}
              <div className="game-setup-grid-row">
                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.gameModel")}</span>
                  <div className="custom-select-wrapper">
                    <select
                      value={selectedModel}
                      onFocus={() => selectedAgentId && void refreshAgentModels(selectedAgentId)}
                      onChange={(e) => setSelectedModel(e.target.value)}
                    >
                      <option value="">{t("game.defaultModel")}</option>
                      {getAvailableModelsForAgent(selectedAgentId).map((val) => (
                        <option key={val.id} value={val.id}>
                          {val.name || val.id}
                        </option>
                      ))}
                    </select>
                    <span className="custom-select-arrow">
                      <ChevronDown size={14} />
                    </span>
                  </div>
                </div>

                <div className="game-setup-field">
                  <span className="game-setup-field-label">{t("game.turnOrder")}</span>
                  <div className="game-setup-choice-group two-cols">
                    <button
                      type="button"
                      className={challengerHand === "agent_first" ? "active" : ""}
                      onClick={() => setChallengerHand("agent_first")}
                    >
                      {t("game.agentFirst", {
                        piece: selectedGame === "chinese_chess" ? t("game.pieceRed") : t("game.pieceBlack")
                      })}
                    </button>
                    <button
                      type="button"
                      className={challengerHand === "engine_first" ? "active" : ""}
                      onClick={() => setChallengerHand("engine_first")}
                    >
                      {t("game.engineFirst", {
                        piece: selectedGame === "chinese_chess" ? t("game.pieceRed") : t("game.pieceBlack")
                      })}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Difficulty (Only for Player vs Agent) */}
          {selectedMode === "player_vs_agent" && (
            <div className="game-setup-field">
              <span className="game-setup-field-label">{t("game.difficulty")}</span>
              <div className="game-setup-choice-group two-cols">
                <button
                  type="button"
                  className={selectedDifficulty === "easy" ? "active" : ""}
                  onClick={() => setSelectedDifficulty("easy")}
                >
                  {t("game.difficultyEasy")}
                </button>
                <button
                  type="button"
                  className={selectedDifficulty === "hard" ? "active" : ""}
                  onClick={() => setSelectedDifficulty("hard")}
                >
                  {t("game.difficultyHard")}
                </button>
              </div>
              {selectedDifficulty === "hard" ? (
                <p className="game-setup-dialog-desc">{t("game.difficultyHardHint")}</p>
              ) : null}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={isLaunching}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              (selectedMode === "player_vs_agent" && !selectedMember) ||
              (selectedMode === "agent_vs_agent" && (!agent1Member || !agent2Member)) ||
              (selectedMode === "agent_vs_engine" && !selectedMember) ||
              isLaunching
            }
            onClick={() => void handleLaunchMatch()}
          >
            {isLaunching ? t("game.launching") : t("game.startMatch")}
          </button>
        </div>
      </div>
    </div>
  );
}
