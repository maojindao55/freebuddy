import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import {
  ChevronLeft,
  Copy,
  Info,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2
} from "lucide-react";

import { useCliExecutorStore, type ResolvedExecutor } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import type {
  CliAuthProbeResult,
  CLIByokModel,
  CLIExecutorOverride,
  CliRuntime
} from "@/services/cli/types";
import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { AvatarPicker } from "./AvatarPicker";
import { useCliInstallStore } from "@/store/cliInstallStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { useGuideInstallStore } from "@/store/guideInstallStore";
import { getAgentIconId } from "@/config/agentIcon";
import { SkillPicker } from "@/components/CLI/SkillPicker";
import { useSkillStore } from "@/store/skillStore";
import { useOnboardingStore } from "@/store/onboardingStore";
import { useProviderStore } from "@/store/providerStore";
import { ProviderSelect } from "./ProviderSelect";
import { cliAdapterDefinitions, type CLIAdapterDefinition } from "@/config/cliAdapters";

const CODEX_ACP_UPGRADE_REQUIRED = "codex-acp requires @agentclientprotocol/codex-acp";
const BYOK_CONTEXT_WINDOW_MIN = 100000;
const BYOK_CONTEXT_WINDOW_MAX = 1000000;

type AdapterStatusKind =
  | "disabled"
  | "checking"
  | "available"
  | "unavailable"
  | "unchecked";

const ADAPTER_STATUS_LABEL_KEY: Record<AdapterStatusKind, string> = {
  disabled: "settings.cli.disabled",
  checking: "settings.cli.checking",
  available: "settings.cli.installed",
  unavailable: "settings.cli.notInstalled",
  unchecked: "settings.cli.notChecked"
};

function adapterStatusKind(
  ex: ResolvedExecutor,
  checking: boolean
): AdapterStatusKind {
  if (!ex.enabled) return "disabled";
  if (checking) return "checking";
  if (ex.runtime?.installed) return "available";
  return ex.runtime ? "unavailable" : "unchecked";
}

interface ByokModelDraft {
  id: string;
  name?: string;
  contextWindow?: number | string;
  supportsVision?: boolean;
}

function parseByokContextWindow(
  value: string | number | undefined
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return Number.isInteger(value) &&
      value >= BYOK_CONTEXT_WINDOW_MIN &&
      value <= BYOK_CONTEXT_WINDOW_MAX
      ? value
      : undefined;
  }
  const clean = value.replace(/[,_\s]/g, "").trim();
  if (!clean) return undefined;
  const parsed = Number(clean);
  return Number.isInteger(parsed) &&
    parsed >= BYOK_CONTEXT_WINDOW_MIN &&
    parsed <= BYOK_CONTEXT_WINDOW_MAX
    ? parsed
    : undefined;
}

function extractModelArg(args: string[]): { model: string; args: string[] } {
  const rest: string[] = [];
  let model = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      if (!model && args[i + 1]) model = args[i + 1];
      i += args[i + 1] ? 1 : 0;
      continue;
    }
    if (arg.startsWith("--model=")) {
      if (!model) model = arg.slice("--model=".length);
      continue;
    }
    rest.push(arg);
  }
  return { model, args: rest };
}

function withModelArg(args: string[], model: string): string[] {
  const cleaned = extractModelArg(args).args;
  const trimmed = model.trim();
  return trimmed ? [`--model=${trimmed}`, ...cleaned] : cleaned;
}

function adapterSortKey(ex: ResolvedExecutor): number {
  const rt = ex.runtime;
  if (!rt) return 3;
  if (rt.installed) return 0;
  if (rt.lastError) return 1;
  return 2;
}

function sortAdapters(list: ResolvedExecutor[]): ResolvedExecutor[] {
  return [...list].sort((a, b) => {
    const diff = adapterSortKey(a) - adapterSortKey(b);
    return diff !== 0
      ? diff
      : String(a.label ?? "").localeCompare(String(b.label ?? ""));
  });
}

type AgentCategory = "builtin" | "custom" | "official";

function categoryOf(ex: ResolvedExecutor): AgentCategory {
  return ex.isClone ? "custom" : "builtin";
}

function matchesQuery(ex: ResolvedExecutor, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    String(ex.label ?? "").toLowerCase().includes(q) ||
    String(ex.id).toLowerCase().includes(q)
  );
}

function cliRuntimeErrorKey(lastError: string | undefined): string {
  if (lastError === "binary not found") return "settings.cli.commandNotFound";
  if (lastError === "codex cli found; acp adapter missing") {
    return "settings.cli.codexCliFoundAcpMissing";
  }
  if (lastError === "claude cli found; acp adapter missing") {
    return "settings.cli.claudeCliFoundAcpMissing";
  }
  if (lastError === "DeepSeek ACP plugin tree missing") {
    return "settings.cli.dshAcpPluginTreeMissing";
  }
  if (lastError === "claude runtime architecture mismatch") {
    return "settings.cli.claudeArchitectureMismatch";
  }
  if (lastError === "claude native binary not found") {
    return "settings.cli.claudeNativeMissing";
  }
  if (lastError === "version probe timed out") {
    return "settings.cli.checkTimedOut";
  }
  if (lastError === CODEX_ACP_UPGRADE_REQUIRED) {
    return "settings.cli.codexAcpUpgradeRequired";
  }
  return "settings.cli.checkProbeFailed";
}

function needsForcedInstall(ex: ResolvedExecutor): boolean {
  return (
    ex.id === "codex-acp" &&
    ex.runtime?.installed === false &&
    ex.runtime.lastError === CODEX_ACP_UPGRADE_REQUIRED &&
    Boolean(ex.installHint)
  );
}

function nextCloneLabel(source: ResolvedExecutor, list: ResolvedExecutor[]): string {
  const base = `${source.label} Copy`;
  const existing = new Set(list.map((item) => item.label));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base} ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${nanoid(4)}`;
}

const NARROW_LAYOUT_QUERY = "(max-width: 920px)";

function useNarrowLayout(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_LAYOUT_QUERY).matches
  );
  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

export function CLIAdaptersTab() {
  const { t } = useTranslation();
  const loaded = useCliExecutorStore((s) => s.loaded);
  const load = useCliExecutorStore((s) => s.load);
  const adapters = useCliExecutorStore((s) => s.adapters);
  const overrides = useCliExecutorStore((s) => s.overrides);
  const runtimes = useCliExecutorStore((s) => s.runtimes);
  const listResolved = useCliExecutorStore((s) => s.listResolved);
  const upsertOverride = useCliExecutorStore((s) => s.upsertOverride);
  const check = useCliExecutorStore((s) => s.check);
  const checkAll = useCliExecutorStore((s) => s.checkAll);
  const refreshMembers = useConversationStore((s) => s.refreshMembers);
  const startInstall = useCliInstallStore((s) => s.startJob);
  const installJobs = useCliInstallStore((s) => s.jobs);
  const notify = useAgentBridgeStore((s) => s.notify);
  const installingIdSet = useMemo(
    () => new Set(installJobs.filter((j) => !j.done).map((j) => j.adapterId)),
    [installJobs]
  );

  const list = useMemo<ResolvedExecutor[]>(
    () =>
      sortAdapters(
        listResolved().filter((executor) => executor.protocol === "acp")
      ),
    [adapters, overrides, runtimes, listResolved]
  );

  const members = useConversationStore((s) => s.members);
  const setMemberRuntimeOverride = useConversationStore(
    (s) => s.setMemberRuntimeOverride
  );
  // Official built-in members carry a profile ("butler" | "guide").
  const officialMembers = useMemo(
    () => members.filter((member) => member.profile),
    [members]
  );
  const runtimeOptions = useMemo(
    () =>
      cliAdapterDefinitions.filter(
        (definition) => definition.protocol === "acp"
      ),
    []
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [authProbes, setAuthProbes] = useState<
    Record<string, CliAuthProbeResult>
  >({});
  const [authBusyIds, setAuthBusyIds] = useState<Set<string>>(
    () => new Set()
  );
  const [authMessages, setAuthMessages] = useState<Record<string, string>>({});
  const autoCheckedRef = useRef(false);
  const autoInstallAttemptedRef = useRef<Set<string>>(new Set());
  const selectedExecutor = useMemo(
    () => list.find((ex) => ex.id === editingId),
    [editingId, list]
  );
  const selectedOfficialMember = useMemo(
    () => officialMembers.find((member) => member.id === editingId),
    [editingId, officialMembers]
  );

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AgentCategory>("builtin");

  const categoryCounts = useMemo(() => {
    let builtin = 0;
    let custom = 0;
    for (const ex of list) {
      if (ex.isClone) custom += 1;
      else builtin += 1;
    }
    return { builtin, custom, official: officialMembers.length };
  }, [list, officialMembers]);

  const filteredList = useMemo(
    () =>
      list.filter(
        (ex) =>
          categoryOf(ex) === category && matchesQuery(ex, query)
      ),
    [list, category, query]
  );

  const filteredOfficialMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return officialMembers.filter(
      (member) =>
        !q ||
        member.name.toLowerCase().includes(q) ||
        member.id.toLowerCase().includes(q)
    );
  }, [officialMembers, query]);

  // Built-in agents that are not installed yet — candidates to hand to
  // GuideBuddy for assisted installation (Pi is bundled and excluded).
  const missingBuiltinAgents = useMemo(
    () =>
      list.filter(
        (ex) =>
          !ex.isClone &&
          ex.id !== "pi-acp" &&
          !ex.runtime?.installed &&
          ex.installHint
      ),
    [list]
  );

  const [guideSelectedIds, setGuideSelectedIds] = useState<string[]>([]);
  const [guideSelectionActive, setGuideSelectionActive] = useState(false);
  const missingAgentIds = useMemo(
    () => missingBuiltinAgents.map((ex) => ex.id),
    [missingBuiltinAgents]
  );
  useEffect(() => {
    setGuideSelectedIds((prev) => {
      const next = prev.filter((id) => missingAgentIds.includes(id));
      return next.length === prev.length && next.every((id, index) => id === prev[index])
        ? prev
        : next;
    });
  }, [missingAgentIds]);
  const selectedGuideAgents = useMemo(
    () => missingBuiltinAgents.filter((ex) => guideSelectedIds.includes(ex.id)),
    [missingBuiltinAgents, guideSelectedIds]
  );
  const allGuideSelected =
    missingAgentIds.length > 0 &&
    selectedGuideAgents.length === missingAgentIds.length;
  const toggleGuideAgent = useCallback((id: string, checked: boolean) => {
    setGuideSelectedIds((prev) =>
      checked
        ? prev.includes(id) ? prev : [...prev, id]
        : prev.filter((existing) => existing !== id)
    );
  }, []);

  const handleCheck = useCallback(
    async (id: string) => {
      setCheckingIds((prev) => new Set(prev).add(id));
      try {
        await check(id);
        const checked = useCliExecutorStore.getState().resolve(id);
        const runtime = checked?.runtime;
        if (runtime?.installed) {
          notify(t("settings.cli.checkInstalled", {
            label: checked?.label ?? id,
            version: runtime.version ? ` (${runtime.version})` : ""
          }));
        } else {
          notify(t("settings.cli.checkUnavailable", {
            label: checked?.label ?? id,
            reason: runtime?.lastError
              ? t(cliRuntimeErrorKey(runtime.lastError))
              : t("settings.cli.notInstalled")
          }));
        }
      } catch (error) {
        const checked = useCliExecutorStore.getState().resolve(id);
        notify(t("settings.cli.checkFailed", {
          label: checked?.label ?? id,
          error: (error as Error)?.message || String(error)
        }));
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [check, notify, t]
  );

  const handleCheckAll = useCallback(async () => {
    setCheckingAll(true);
    setCheckingIds((prev) => {
      const next = new Set(prev);
      for (const ex of list) next.add(ex.id);
      return next;
    });
    try {
      await checkAll();
    } finally {
      setCheckingAll(false);
      setCheckingIds(() => new Set());
    }
  }, [checkAll, list]);

  const handleClone = useCallback(
    async (source: ResolvedExecutor) => {
      const baseAdapter = source.baseAdapter ?? source.id;
      const id = `${baseAdapter}-clone-${nanoid(8)}`;
      const override: CLIExecutorOverride = {
        id,
        baseAdapter,
        label: nextCloneLabel(source, list),
        binary:
          source.binary && source.binary !== source.defaultBinary
            ? source.binary
            : undefined,
        extraArgs: source.extraArgs,
        env: source.env,
        icon: source.icon ?? getAgentIconId(baseAdapter) ?? undefined,
        enabled: true
      };
      await upsertOverride(override);
      refreshMembers();
      setEditingId(id);
    },
    [list, refreshMembers, upsertOverride]
  );

  const handleToggleEnabled = useCallback(
    async (ex: ResolvedExecutor, enabled: boolean) => {
      try {
        await upsertOverride({
          ...(ex.override ?? {}),
          id: ex.id,
          baseAdapter: ex.baseAdapter,
          enabled
        });
        refreshMembers();
      } catch (error) {
        notify(
          t("settings.cli.toggleFailed", {
            label: ex.label,
            error: (error as Error)?.message || String(error)
          })
        );
      }
    },
    [notify, refreshMembers, t, upsertOverride]
  );

  const availabilitySummary = useMemo(() => {
    if (!loaded || category === "official") return null;
    const scoped = list.filter((ex) => categoryOf(ex) === category);
    if (!scoped.length) return null;
    let installed = 0;
    for (const ex of scoped) {
      if (ex.runtime?.installed) installed += 1;
    }
    if (installed === scoped.length) return null;
    return { installed, total: scoped.length };
  }, [list, loaded, category]);

  const authControlArgs = useCallback((ex: ResolvedExecutor) => ({
    agentId: `cli-${ex.id}`,
    adapter: ex.baseAdapter ?? ex.id,
    binary: ex.binary,
    extraArgs: ex.extraArgs,
    env: ex.env
  }), []);

  const handleAuthProbe = useCallback(async (ex: ResolvedExecutor) => {
    setAuthBusyIds((current) => new Set(current).add(ex.id));
    setAuthMessages((current) => ({ ...current, [ex.id]: "" }));
    try {
      const result = await cliClient.probeAuthentication(authControlArgs(ex));
      setAuthProbes((current) => ({ ...current, [ex.id]: result }));
      setAuthMessages((current) => ({
        ...current,
        [ex.id]: t("settings.cli.authMethodsFound", {
          count: result.authMethods.length
        })
      }));
    } catch (error) {
      setAuthMessages((current) => ({
        ...current,
        [ex.id]: t("settings.cli.authProbeFailed", {
          error: (error as Error)?.message || String(error)
        })
      }));
    } finally {
      setAuthBusyIds((current) => {
        const next = new Set(current);
        next.delete(ex.id);
        return next;
      });
    }
  }, [authControlArgs, t]);

  const handleLogout = useCallback(async (ex: ResolvedExecutor) => {
    setAuthBusyIds((current) => new Set(current).add(ex.id));
    setAuthMessages((current) => ({ ...current, [ex.id]: "" }));
    try {
      await cliClient.logout(authControlArgs(ex));
      setAuthMessages((current) => ({
        ...current,
        [ex.id]: t("settings.cli.logoutSuccess")
      }));
    } catch (error) {
      setAuthMessages((current) => ({
        ...current,
        [ex.id]: t("settings.cli.logoutFailed", {
          error: (error as Error)?.message || String(error)
        })
      }));
    } finally {
      setAuthBusyIds((current) => {
        const next = new Set(current);
        next.delete(ex.id);
        return next;
      });
    }
  }, [authControlArgs, t]);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!loaded || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void checkAll();
  }, [loaded, checkAll]);

  // A GuideBuddy hand-off may have finished installing while the user was
  // away from the chat view; re-probe its requested agents when the list
  // opens so rows never show stale "not installed".
  useEffect(() => {
    void useGuideInstallStore.getState().settleGuideTurn();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (
      editingId &&
      !list.some((ex) => ex.id === editingId) &&
      !officialMembers.some((member) => member.id === editingId)
    ) {
      setEditingId(null);
      return;
    }
  }, [editingId, list, loaded, officialMembers]);

  useEffect(() => {
    if (!loaded) return;
    for (const ex of list) {
      if (!needsForcedInstall(ex)) continue;
      if (installingIdSet.has(ex.id)) continue;
      if (autoInstallAttemptedRef.current.has(ex.id)) continue;
      autoInstallAttemptedRef.current.add(ex.id);
      startInstall({
        adapterId: ex.id,
        label: ex.label,
        command: ex.installHint!
      });
    }
  }, [installingIdSet, list, loaded, startInstall]);

  const isNarrow = useNarrowLayout();
  const editorDirtyRef = useRef(false);
  const [editorNonce, setEditorNonce] = useState(0);
  const selectAgent = (id: string | null) => {
    if (id === editingId) return;
    if (editorDirtyRef.current && !window.confirm(t("settings.cli.unsavedConfirm"))) {
      return;
    }
    editorDirtyRef.current = false;
    setEditingId(id);
  };

  // Wide layouts always show a detail pane, so fall back to the first visible
  // agent. Narrow layouts keep "nothing selected" to show the list alone.
  const defaultAgentId =
    category === "official" ? filteredOfficialMembers[0]?.id : filteredList[0]?.id;
  useEffect(() => {
    if (isNarrow || editingId || !defaultAgentId) return;
    setEditingId(defaultAgentId);
  }, [defaultAgentId, editingId, isNarrow]);

  const categoryTabs = (
    <div className="adapter-filter-tabs" role="tablist">
      {(["builtin", "custom", "official"] as AgentCategory[]).map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={category === c}
          className={category === c ? "active" : undefined}
          onClick={() => setCategory(c)}
          disabled={c !== "official" && !loaded}
        >
          {t(`settings.cli.category.${c}`)}{" "}
          <span>{categoryCounts[c]}</span>
        </button>
      ))}
    </div>
  );

  const searchInput = (
    <input
      type="search"
      className="adapter-search"
      placeholder={t("settings.cli.searchAgents")}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  );

  if (!cliClient.isAvailable()) {
    return (
      <div className="settings-tab">
        <div className="settings-section-heading">
          <h3 className="settings-section-title">{t("settings.cli.title")}</h3>
          <span className="settings-section-desc">
            {t("settings.cli.unavailable")}
          </span>
        </div>
      </div>
    );
  }

  const selectedGuideLabels = selectedGuideAgents.map((ex) => ex.label).join(", ");
  const guideBanner =
    category === "builtin" && loaded && missingBuiltinAgents.length > 0 ? (
      <div className="adapter-guide-install-banner">
        <div className="adapter-guide-install-banner-head">
          <Sparkles
            size={14}
            className="adapter-guide-install-banner-icon"
            aria-hidden="true"
          />
          <span
            id="guide-install-selection-hint"
            className="adapter-guide-install-banner-text"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            title={selectedGuideLabels}
          >
            {!guideSelectionActive
              ? t("settings.cli.guideInstall.bannerHint", { count: missingBuiltinAgents.length })
              : selectedGuideAgents.length
              ? t("settings.cli.guideInstall.selectionHint", {
                  count: selectedGuideAgents.length,
                  total: missingBuiltinAgents.length
                })
              : t("settings.cli.guideInstall.pickHint")}
            {guideSelectionActive && query.trim() && ` ${t("settings.cli.guideInstall.selectAllScope")}`}
          </span>
        </div>
        <div className="adapter-guide-install-banner-actions">
          {guideSelectionActive && <label
            className="adapter-guide-install-select-all"
            title={t("settings.cli.guideInstall.selectAllScope")}
          >
            <input
              type="checkbox"
              className="guide-install-checkbox"
              checked={allGuideSelected}
              aria-describedby="guide-install-selection-hint"
              ref={(input) => {
                if (input) input.indeterminate = selectedGuideAgents.length > 0 && !allGuideSelected;
              }}
              onChange={() =>
                setGuideSelectedIds(allGuideSelected ? [] : missingAgentIds)
              }
            />
            {t("settings.cli.guideInstall.selectAll")}
          </label>}
          {guideSelectionActive && (
            <button
              type="button"
              className="step-btn"
              onClick={() => {
                setGuideSelectionActive(false);
                setGuideSelectedIds([]);
              }}
            >
              {t("common.cancel")}
            </button>
          )}
          <button
            type="button"
            className="step-btn step-btn--guide-auto"
            disabled={guideSelectionActive && !selectedGuideAgents.length}
            onClick={() => {
              if (!guideSelectionActive) {
                setGuideSelectedIds([]);
                setGuideSelectionActive(true);
                return;
              }
              useGuideInstallStore
                .getState()
                .requestGuideInstall(selectedGuideAgents.map((ex) => ex.id));
              setGuideSelectionActive(false);
              setGuideSelectedIds([]);
            }}
          >
            <Sparkles size={13} aria-hidden="true" />
            {guideSelectionActive
              ? t("settings.cli.guideInstall.bannerActionCount", {
                  count: selectedGuideAgents.length
                })
              : t("settings.cli.guideInstall.bannerAction")}
          </button>
        </div>
      </div>
    ) : null;

  const masterEmpty =
    category === "official"
      ? filteredOfficialMembers.length === 0
      : !loaded || filteredList.length === 0;

  const detailPanel =
    editingId && selectedOfficialMember ? (
      <OfficialPersonaPanel
        key={selectedOfficialMember.id}
        memberId={selectedOfficialMember.id}
        runtimeOptions={runtimeOptions}
        onChangeRuntime={(runtimeKey) =>
          void setMemberRuntimeOverride(selectedOfficialMember.id, runtimeKey)
        }
        onBackToList={() => selectAgent(null)}
      />
    ) : editingId && selectedExecutor ? (
      <EditOverridePanel
        key={`${selectedExecutor.id}:${editorNonce}`}
        executorId={selectedExecutor.id}
        dirtyRef={editorDirtyRef}
        headerMeta={
          <AdapterHeaderMeta
            ex={selectedExecutor}
            checking={checkingIds.has(selectedExecutor.id)}
            authMessage={authMessages[selectedExecutor.id]}
          />
        }
        headerActions={
          <AdapterHeaderActions
            ex={selectedExecutor}
            checking={checkingIds.has(selectedExecutor.id)}
            installing={installingIdSet.has(selectedExecutor.id)}
            authProbe={authProbes[selectedExecutor.id]}
            authBusy={authBusyIds.has(selectedExecutor.id)}
            onCheck={() => void handleCheck(selectedExecutor.id)}
            onClone={() => {
              if (editorDirtyRef.current && !window.confirm(t("settings.cli.unsavedConfirm"))) {
                return;
              }
              editorDirtyRef.current = false;
              void handleClone(selectedExecutor);
            }}
            onToggleEnabled={(enabled) =>
              void handleToggleEnabled(selectedExecutor, enabled)
            }
            onAuthProbe={() => void handleAuthProbe(selectedExecutor)}
            onLogout={() => void handleLogout(selectedExecutor)}
            onInstall={() => {
              if (!selectedExecutor.installHint) return;
              startInstall({
                adapterId: selectedExecutor.id,
                label: selectedExecutor.label,
                command: selectedExecutor.installHint
              });
            }}
            onAskGuideInstall={
              selectedExecutor.id !== "pi-acp" &&
              selectedExecutor.installHint &&
              !selectedExecutor.runtime?.installed
                ? () =>
                    useGuideInstallStore
                      .getState()
                      .requestGuideInstall([selectedExecutor.id])
                : undefined
            }
          />
        }
        onBackToList={() => selectAgent(null)}
        onResetSelection={() => {
          editorDirtyRef.current = false;
          setEditorNonce((nonce) => nonce + 1);
        }}
      />
    ) : null;

  return (
    <div className="settings-tab">
      <div
        className={`adapter-master-detail${
          detailPanel ? " adapter-master-detail--selected" : ""
        }`}
      >
        <aside
          className="adapter-master-list"
          aria-label={t("settings.cli.title")}
        >
          {categoryTabs}
          {searchInput}
          {availabilitySummary ? (
            <span className="adapter-availability-summary muted">
              {t("settings.cli.summary", availabilitySummary)}
            </span>
          ) : null}
          {guideBanner}
          <div className="adapter-master-items">
            {masterEmpty ? (
              <p className="muted adapter-empty">
                {category === "official" || loaded
                  ? t("settings.cli.noResults")
                  : t("settings.cli.loading")}
              </p>
            ) : category === "official" ? (
              filteredOfficialMembers.map((member) => (
                <AdapterListItem
                  key={member.id}
                  adapter={member.cli.adapter}
                  agentId={member.id}
                  label={member.name}
                  statusKind="available"
                  statusLabel={t("settings.cli.category.official")}
                  selected={member.id === editingId}
                  onSelect={() => selectAgent(member.id)}
                />
              ))
            ) : (
              filteredList.map((ex) => {
                const kind = adapterStatusKind(ex, checkingIds.has(ex.id));
                return (
                  <AdapterListItem
                    key={ex.id}
                    adapter={ex.baseAdapter ?? ex.id}
                    agentId={`cli-${ex.id}`}
                    label={ex.label}
                    statusKind={kind}
                    statusLabel={t(ADAPTER_STATUS_LABEL_KEY[kind])}
                    selected={ex.id === editingId}
                    onSelect={() => selectAgent(ex.id)}
                    guideSelectable={guideSelectionActive && missingAgentIds.includes(ex.id)}
                    guideSelected={guideSelectionActive && guideSelectedIds.includes(ex.id)}
                    onGuideSelectChange={(checked) => toggleGuideAgent(ex.id, checked)}
                  />
                );
              })
            )}
          </div>
        </aside>
        <div className="adapter-edit-workspace">
          {detailPanel ?? (
            <p className="muted adapter-empty adapter-detail-empty">
              {loaded ? t("settings.cli.noResults") : t("settings.cli.loading")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function AdapterListItem({
  adapter,
  agentId,
  label,
  statusKind,
  statusLabel,
  selected,
  onSelect,
  guideSelectable,
  guideSelected,
  onGuideSelectChange
}: {
  adapter: string;
  agentId: string;
  label: string;
  statusKind: AdapterStatusKind;
  statusLabel: string;
  selected: boolean;
  onSelect: () => void;
  guideSelectable?: boolean;
  guideSelected?: boolean;
  onGuideSelectChange?: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const body = (
    <>
      <AgentAvatar
        adapter={adapter}
        agentId={agentId}
        className="adapter-master-avatar"
        fallback={<span>{label.slice(0, 2).toUpperCase()}</span>}
      />
      <span className="adapter-master-item-label">{label}</span>
      <span
        className={`adapter-master-dot ${statusKind}`}
        role="img"
        aria-label={statusLabel}
      />
    </>
  );
  const className = `adapter-master-item${selected ? " selected" : ""}${
    statusKind === "disabled" ? " disabled" : ""
  }`;
  // During GuideBuddy batch selection, candidate rows become checkbox labels
  // so the whole row toggles the pick instead of opening the editor.
  if (guideSelectable) {
    return (
      <label
        className={`${className} adapter-master-item--guide-choice${
          guideSelected ? " adapter-master-item--guide-selected" : ""
        }`}
      >
        <input
          type="checkbox"
          className="guide-install-checkbox"
          aria-label={t("settings.cli.guideInstall.selectAgent", { name: label })}
          checked={Boolean(guideSelected)}
          onChange={(event) => onGuideSelectChange?.(event.target.checked)}
        />
        {body}
      </label>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-current={selected ? "true" : undefined}
      title={`${label} · ${statusLabel}`}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}

function OfficialPersonaPanel({
  memberId,
  runtimeOptions,
  onChangeRuntime,
  onBackToList
}: {
  memberId: string;
  runtimeOptions: CLIAdapterDefinition[];
  onChangeRuntime: (runtimeKey: string) => void;
  onBackToList: () => void;
}) {
  const { t } = useTranslation();
  const member = useConversationStore((s) =>
    s.members.find((m) => m.id === memberId)
  );
  const skills = useSkillStore((s) => s.skills);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const loadSkills = useSkillStore((s) => s.load);

  useEffect(() => {
    if (!skillsLoaded) void loadSkills();
  }, [loadSkills, skillsLoaded]);

  if (!member) return null;
  const currentRuntime = member.runtimeKey ?? member.cli.adapter;
  const requiredSkills = (member.requiredSkillIds ?? []).map((id) => ({
    id,
    name: skills.find((skill) => skill.id === id)?.name ?? id
  }));
  return (
    <section className="adapter-editor-form">
      <header className="adapter-editor-header">
        <div className="adapter-editor-titlebar">
          <button
            type="button"
            className="adapter-editor-back"
            onClick={onBackToList}
          >
            <ChevronLeft
              size={15}
              className="adapter-editor-back-chevron"
              aria-hidden="true"
            />
            {t("settings.cli.backToList")}
          </button>
          <div className="adapter-editor-heading">
            <AgentAvatar
              adapter={member.cli.adapter}
              agentId={member.id}
              className="adapter-editor-avatar"
              fallback={<span>{member.name.slice(0, 2).toUpperCase()}</span>}
            />
            <div className="adapter-editor-heading-text">
              <h3>{member.name}</h3>
              {member.description && (
                <p className="muted">{member.description}</p>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="adapter-editor-scroll">
        <div className="adapter-editor-section">
          <label className="adapter-editor-field">
            <span className="adapter-editor-field-label">
              {t("settings.cli.official.runtime")}
            </span>
            <select
              value={currentRuntime}
              onChange={(event) => onChangeRuntime(event.target.value)}
            >
              {runtimeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="settings-field-hint">
              {t("settings.cli.official.runtimeHint")}
            </span>
          </label>
        </div>

        <div className="adapter-editor-section">
          <div className="adapter-editor-field">
            <span className="adapter-editor-field-label">
              {t("settings.cli.official.requiredSkills")}
            </span>
            {requiredSkills.length === 0 ? (
              <p className="muted">{t("settings.cli.official.noRequiredSkills")}</p>
            ) : (
              <ul className="adapter-editor-readonly-list">
                {requiredSkills.map((skill) => (
                  <li key={skill.id}>
                    <strong>{skill.name}</strong>
                  </li>
                ))}
              </ul>
            )}
            <span className="settings-field-hint">
              {t("settings.cli.official.requiredSkillsHint")}
            </span>
          </div>
        </div>

        {member.profile === "guide" ? (
          <div className="adapter-editor-section">
            <div className="adapter-editor-field">
              <span className="adapter-editor-field-label">
                {t("settings.cli.official.onboarding")}
              </span>
              <button
                type="button"
                className="adapter-editor-upgrade"
                onClick={() => useOnboardingStore.getState().restart()}
              >
                {t("settings.cli.official.restartOnboarding")}
              </button>
              <span className="settings-field-hint">
                {t("settings.cli.official.onboardingHint")}
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AdapterHeaderActions({
  ex,
  checking,
  installing,
  authProbe,
  authBusy,
  onCheck,
  onClone,
  onInstall,
  onToggleEnabled,
  onAuthProbe,
  onLogout,
  onAskGuideInstall
}: {
  ex: ResolvedExecutor;
  checking: boolean;
  installing: boolean;
  authProbe?: CliAuthProbeResult;
  authBusy: boolean;
  onCheck: () => void;
  onClone: () => void;
  onInstall: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onAuthProbe: () => void;
  onLogout: () => void;
  onAskGuideInstall?: () => void;
}) {
  const { t } = useTranslation();
  const rt = ex.runtime;
  const menuItems: AdapterRowMenuItem[] = [
    {
      key: "check",
      label: checking ? t("settings.cli.checking") : t("common.check"),
      icon: <RefreshCw size={14} aria-hidden="true" />,
      disabled: checking || installing,
      onSelect: onCheck
    },
    ...(rt?.installed && !authProbe
      ? [
          {
            key: "auth",
            label: authBusy
              ? t("settings.cli.authChecking")
              : t("settings.cli.checkAuthentication"),
            icon: <KeyRound size={14} aria-hidden="true" />,
            disabled: authBusy,
            onSelect: onAuthProbe
          }
        ]
      : []),
    ...(rt?.installed && authProbe?.logoutSupported
      ? [
          {
            key: "logout",
            label: authBusy
              ? t("settings.cli.loggingOut")
              : t("settings.cli.logout"),
            icon: <LogOut size={14} aria-hidden="true" />,
            danger: true,
            disabled: authBusy,
            onSelect: onLogout
          }
        ]
      : []),
    {
      key: "clone",
      label: t("common.clone"),
      icon: <Copy size={14} aria-hidden="true" />,
      disabled: checking || installing,
      onSelect: onClone
    },
    ...(onAskGuideInstall
      ? [
          {
            key: "guide-install",
            label: t("settings.cli.guideInstall.bannerAction"),
            icon: <Sparkles size={14} aria-hidden="true" />,
            disabled: installing || checking,
            onSelect: onAskGuideInstall
          }
        ]
      : [])
  ];
  return (
    <>
      {!rt?.installed && ex.installHint && (
        <button
          type="button"
          className="adapter-editor-install"
          onClick={onInstall}
          disabled={installing || checking}
        >
          {installing ? t("common.installing") : t("common.install")}
        </button>
      )}
      <label
        className="adapter-switch"
        title={ex.enabled ? t("settings.cli.enabled") : t("settings.cli.disabled")}
      >
        <input
          type="checkbox"
          checked={ex.enabled}
          disabled={checking || installing}
          aria-label={t("settings.cli.toggleAria", { name: ex.label })}
          onChange={(event) => onToggleEnabled(event.currentTarget.checked)}
        />
        <span aria-hidden="true" />
      </label>
      <AdapterRowMenu label={t("settings.cli.moreActions")} items={menuItems} />
    </>
  );
}

function AdapterHeaderMeta({
  ex,
  checking,
  authMessage
}: {
  ex: ResolvedExecutor;
  checking: boolean;
  authMessage?: string;
}) {
  const { t } = useTranslation();
  const rt = ex.runtime;
  const codexCliRuntime = useCliExecutorStore((state) => state.runtimes.codex);
  const codexUpdateStatus = ex.id === "codex-acp" ? rt?.updateStatus : undefined;
  return (
    <>
      {!checking && rt?.installed && rt.version && (
        <span>
          {t("settings.cli.versionLabel")} <code>{rt.version}</code>
        </span>
      )}
      {!checking && rt?.lastError && !rt.installed && (
        <span className="adapter-status error" title={rt.lastError}>
          {t(cliRuntimeErrorKey(rt.lastError))}
        </span>
      )}
      {ex.id === "codex-acp" && codexCliRuntime?.installed && (
        <span>
          Codex CLI: <code>{codexCliRuntime.version}</code>
        </span>
      )}
      <RuntimeAutoUpdateStatus
        runtime={codexUpdateStatus ? rt : undefined}
        label="Codex ACP"
      />
      {ex.id === "codex-acp" && (
        <RuntimeAutoUpdateStatus runtime={codexCliRuntime} label="Codex CLI" />
      )}
      {authMessage && <span title={authMessage}>{authMessage}</span>}
    </>
  );
}

interface AdapterRowMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function AdapterRowMenu({
  label,
  items
}: {
  label: string;
  items: AdapterRowMenuItem[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!items.length) return null;
  return (
    <div className="adapter-row-menu" ref={rootRef}>
      <button
        type="button"
        className="icon-btn adapter-row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="adapter-row-menu-popover" role="menu">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RuntimeAutoUpdateStatus({
  runtime,
  label
}: {
  runtime?: CliRuntime;
  label: string;
}) {
  const { t } = useTranslation();
  switch (runtime?.updateStatus) {
    case "checking":
      return (
        <span className="adapter-status muted">
          {t("settings.cli.autoUpdateChecking", { target: label })}
        </span>
      );
    case "updating":
      return (
        <span className="adapter-status muted">
          {t("settings.cli.autoUpdating", {
            target: label,
            version: runtime.latestVersion ?? ""
          })}
        </span>
      );
    case "updated":
      return (
        <span className="adapter-status ok">
          {t("settings.cli.autoUpdated", {
            target: label,
            version: runtime.latestVersion ?? ""
          })}
        </span>
      );
    case "error":
      return (
        <span className="adapter-status error" title={runtime.lastUpdateError}>
          {t("settings.cli.autoUpdateFailed", { target: label })}
        </span>
      );
    default:
      return null;
  }
}

function EditOverridePanel({
  executorId,
  dirtyRef,
  headerMeta,
  headerActions,
  onBackToList,
  onResetSelection
}: {
  executorId: string;
  dirtyRef?: { current: boolean };
  headerMeta?: ReactNode;
  headerActions?: ReactNode;
  onBackToList: () => void;
  onResetSelection: () => void;
}) {
  const { t } = useTranslation();
  const resolve = useCliExecutorStore((s) => s.resolve);
  const override = useCliExecutorStore((s) => s.overrides[executorId]);
  const ex = resolve(executorId);
  const upsert = useCliExecutorStore((s) => s.upsertOverride);
  const reset = useCliExecutorStore((s) => s.resetOverride);
  const refreshMembers = useConversationStore((s) => s.refreshMembers);
  const skills = useSkillStore((s) => s.skills);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const loadSkills = useSkillStore((s) => s.load);
  const startInstall = useCliInstallStore((s) => s.startJob);
  const installing = useCliInstallStore((s) =>
    s.jobs.some((j) => j.adapterId === executorId && !j.done)
  );
  const providers = useProviderStore((s) => s.providers);
  const providersLoaded = useProviderStore((s) => s.loaded);
  const loadProviders = useProviderStore((s) => s.load);

  const [label, setLabel] = useState(ex?.label ?? "");
  const [binary, setBinary] = useState(
    ex?.override?.binary && ex.override.binary !== ex.defaultBinary
      ? ex.override.binary
      : ""
  );
  const parsedExtraArgs = extractModelArg(ex?.override?.extraArgs ?? []);
  const [model, setModel] = useState(parsedExtraArgs.model);
  const [extraArgs, setExtraArgs] = useState(
    parsedExtraArgs.args.join("\n")
  );
  const [envText, setEnvText] = useState(
    Object.entries(ex?.override?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  );
  const [icon, setIcon] = useState(ex?.override?.icon ?? "");
  const [skillIds, setSkillIds] = useState<string[]>(ex?.override?.skillIds ?? []);
  const adapterForConfig = ex?.baseAdapter ?? ex?.id;
  const isCodex = adapterForConfig === "codex-acp";
  const isClaude =
    adapterForConfig === "claude-agent-acp" || adapterForConfig === "claude";
  const isDeepSeek = adapterForConfig === "dsh-acp";
  const isPi = adapterForConfig === "pi-acp";
  const savedCodexByok = ex?.override?.codexByok;
  const savedClaudeByok = ex?.override?.claudeByok;
  const savedDeepSeekByok = ex?.override?.deepseekByok;
  const savedPiByok = ex?.override?.piByok;
  const savedByok = isCodex
    ? savedCodexByok
    : isClaude
      ? savedClaudeByok
      : isDeepSeek
        ? savedDeepSeekByok
        : isPi
          ? savedPiByok
          : undefined;
  const [codexByokEnabled, setCodexByokEnabled] = useState(
    savedByok?.enabled === true
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(() => {
    const byok = savedByok as { providerId?: string } | undefined;
    const pid = byok?.providerId;
    return pid && pid !== "proxy" && pid !== "custom" ? pid : undefined;
  });
  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const [codexProviderId, setCodexProviderId] = useState(
    savedCodexByok?.providerId ?? "proxy"
  );
  const [codexProviderName, setCodexProviderName] = useState(
    savedCodexByok?.providerName ?? "BYOK provider"
  );
  const [codexBaseUrl, setCodexBaseUrl] = useState(savedByok?.baseUrl ?? "");
  const [codexEnvKey, setCodexEnvKey] = useState(
    savedByok?.envKey ??
      (isClaude
        ? "ANTHROPIC_API_KEY"
        : isDeepSeek
          ? "DEEPSEEK_API_KEY"
          : "OPENAI_API_KEY")
  );
  const [codexWireApi, setCodexWireApi] = useState<
    NonNullable<NonNullable<CLIExecutorOverride["codexByok"]>["wireApi"]>
  >(
    // "chat" is served through the local Responses↔chat bridge (see
    // responsesBridge.ts) because codex >= 0.146 dropped the chat wire API.
    savedCodexByok?.wireApi ?? "responses"
  );
  const [deepseekWireApi, setDeepseekWireApi] = useState<"chat" | "responses">(
    savedDeepSeekByok?.wireApi ?? "chat"
  );
  const [deepseekOfficialApiKey, setDeepseekOfficialApiKey] = useState("");
  const [codexApiKey, setCodexApiKey] = useState("");
  const [byokModels, setByokModels] = useState<ByokModelDraft[]>(() => {
    if (selectedProvider?.models?.length) {
      const active = selectedProvider.models.filter((m) => m.enabled !== false);
      return active.map((m) => ({
        id: m.id,
        name: m.name ?? "",
        contextWindow: m.contextWindow,
        supportsVision: m.supportsVision
      }));
    }
    if (savedByok?.models?.length) return savedByok.models;
    return parsedExtraArgs.model
      ? [{ id: parsedExtraArgs.model, name: "", supportsVision: isCodex }]
      : [];
  });
  const [byokContextWindow, setByokContextWindow] = useState(
    savedClaudeByok?.contextWindow?.toString() ??
      savedClaudeByok?.compaction?.window?.toString() ??
      ""
  );
  const [claudeCompactionEnabled, setClaudeCompactionEnabled] = useState(
    savedClaudeByok?.compaction?.enabled !== false
  );
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");
  const baselineRef = useRef<string | null>(null);
  const latestDirtyRef = useRef(false);

  useEffect(() => {
    setSaveStatus("idle");
    setSaveError("");
    setSkillIds(ex?.override?.skillIds ?? []);
  }, [executorId]);

  useEffect(() => {
    if (!skillsLoaded) void loadSkills();
  }, [loadSkills, skillsLoaded]);

  useEffect(() => {
    if (!providersLoaded) void loadProviders();
  }, [loadProviders, providersLoaded]);

  useEffect(() => {
    if (selectedProvider) {
      if (selectedProvider.baseUrl && !codexBaseUrl) {
        setCodexBaseUrl(selectedProvider.baseUrl);
      }
      if (selectedProvider.envKey && !codexEnvKey) {
        setCodexEnvKey(selectedProvider.envKey);
      }
    }
  }, [selectedProvider, codexBaseUrl, codexEnvKey]);

  useEffect(() => {
    if (selectedProvider) {
      const active = selectedProvider.models.filter((m) => m.enabled !== false);
      setByokModels(
        active.map((m) => ({
          id: m.id,
          name: m.name ?? "",
          contextWindow: m.contextWindow,
          supportsVision: m.supportsVision
        }))
      );
      if (!model.trim() && active[0]?.id) {
        setModel(active[0].id);
      }
      // Provider-driven normalization rewrites draft fields without user
      // edits; re-baseline so the unsaved indicator doesn't self-trigger.
      if (!latestDirtyRef.current) baselineRef.current = null;
    }
  }, [selectedProvider]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timer = window.setTimeout(() => setSaveStatus("idle"), 2200);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  if (!ex) return null;

  const isClone = Boolean(ex.isClone);
  const supportsByok = isCodex || isClaude || isDeepSeek || isPi;
  const byokContextWindowInvalid =
    byokContextWindow.trim() !== "" &&
    parseByokContextWindow(byokContextWindow) === undefined;
  const byokBaseUrlPlaceholder = isClaude
    ? "https://api.anthropic.com"
    : isDeepSeek
      ? "https://api.deepseek.com"
      : "https://api.openai.com/v1";

  const buildOverride = (): CLIExecutorOverride => {
    const cleanedExtraArgs = extraArgs
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // Keep accepting --model in Advanced arguments, but normalize it into the
    // first-class Model field. Previously the parser silently removed it when
    // the dedicated field was blank, so the saved override lost the model.
    const modelFromExtraArgs = extractModelArg(cleanedExtraArgs).model.trim();
    const effectiveModel = model.trim() || modelFromExtraArgs;
    const env: Record<string, string> = {};
    envText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      });

    const normalizedByokModels: CLIByokModel[] = byokModels
      .map((entry) => {
        const id = entry.id.trim();
        const name = entry.name?.trim();
        const contextWindow =
          entry.contextWindow !== undefined &&
          String(entry.contextWindow).trim() !== ""
            ? parseByokContextWindow(entry.contextWindow)
            : undefined;
        const model: CLIByokModel = {
          id,
          ...(name ? { name } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(isCodex
            ? { supportsVision: entry.supportsVision !== false }
            : isDeepSeek ? { supportsVision: entry.supportsVision === true } : {})
        };
        return model;
      })
      .filter((entry) => entry.id.length > 0);

    const effectiveByokModels: CLIByokModel[] = selectedProvider
      ? selectedProvider.models
          .filter((m) => m.enabled !== false)
          .map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
            ...(isCodex ? { supportsVision: m.supportsVision !== false } : isDeepSeek ? { supportsVision: m.supportsVision === true } : {})
          }))
      : normalizedByokModels;

    const codexByokConfig =
      isCodex && codexByokEnabled
        ? selectedProviderId
          ? {
              // Provider-reference mode: store providerId with current models snapshot
              enabled: true,
              providerId: selectedProviderId,
              providerName: selectedProvider?.name || codexProviderName.trim() || "BYOK provider",
              envKey: selectedProvider?.envKey || codexEnvKey.trim() || "OPENAI_API_KEY",
              wireApi: selectedProvider?.protocol === "openai-responses" ? ("responses" as const) : ("chat" as const),
              models: effectiveByokModels
            }
          : {
              enabled: true,
              providerId: codexProviderId.trim() || "proxy",
              providerName: codexProviderName.trim() || "BYOK provider",
              baseUrl: codexBaseUrl.trim(),
              envKey: codexEnvKey.trim() || "OPENAI_API_KEY",
              wireApi: codexWireApi,
              apiKey: codexApiKey.trim() || undefined,
              models: normalizedByokModels,
              apiKeyPreview: savedByok?.apiKeyPreview
            }
        : undefined;
    const claudeByokConfig =
      isClaude && codexByokEnabled
        ? selectedProviderId
          ? {
              enabled: true,
              providerId: selectedProviderId,
              envKey: selectedProvider?.envKey || codexEnvKey.trim() || "ANTHROPIC_API_KEY",
              models: effectiveByokModels,
              compaction: { enabled: claudeCompactionEnabled }
            }
          : {
              enabled: true,
              baseUrl: codexBaseUrl.trim(),
              envKey: codexEnvKey.trim() || "ANTHROPIC_API_KEY",
              apiKey: codexApiKey.trim() || undefined,
              models: normalizedByokModels,
              contextWindow: parseByokContextWindow(byokContextWindow),
              compaction: {
                enabled: claudeCompactionEnabled
              },
              apiKeyPreview: savedClaudeByok?.apiKeyPreview
            }
        : undefined;
    const deepseekByokConfig = isDeepSeek
      ? selectedProviderId
        ? {
            enabled: true,
            providerId: selectedProviderId,
            envKey: selectedProvider?.envKey || codexEnvKey.trim() || "DEEPSEEK_API_KEY",
            wireApi: "chat" as const,
            models: effectiveByokModels
          }
        : {
            enabled: codexByokEnabled,
            baseUrl: codexByokEnabled ? codexBaseUrl.trim() || undefined : undefined,
            envKey: codexByokEnabled ? codexEnvKey.trim() || undefined : undefined,
            wireApi: "chat" as const,
            officialApiKey: deepseekOfficialApiKey.trim() || undefined,
            officialApiKeyPreview: savedDeepSeekByok?.officialApiKeyPreview,
            apiKey: codexApiKey.trim() || undefined,
            apiKeyPreview: savedDeepSeekByok?.apiKeyPreview,
            models: codexByokEnabled ? normalizedByokModels : [],
            contextWindow: codexByokEnabled
              ? parseByokContextWindow(byokContextWindow)
              : undefined
          }
      : undefined;

    const piByokConfig =
      isPi && codexByokEnabled
        ? selectedProviderId
          ? {
              // Provider-reference mode: store providerId with current models snapshot
              enabled: true,
              providerId: selectedProviderId,
              envKey: selectedProvider?.envKey || codexEnvKey.trim() || "OPENAI_API_KEY",
              models: effectiveByokModels
            }
          : {
              enabled: true,
              providerId: "custom",
              baseUrl: codexBaseUrl.trim() || undefined,
              envKey: codexEnvKey.trim() || "OPENAI_API_KEY",
              apiKey: codexApiKey.trim() || undefined,
              apiKeyPreview: savedPiByok?.apiKeyPreview,
              models: normalizedByokModels,
              contextWindow: parseByokContextWindow(byokContextWindow)
            }
        : undefined;

    return {
      id: ex.id,
      baseAdapter: ex.baseAdapter,
      label: isClone ? label.trim() || ex.label : undefined,
      binary:
        binary.trim() && binary.trim() !== ex.defaultBinary
          ? binary.trim()
          : undefined,
      extraArgs: withModelArg(cleanedExtraArgs, effectiveModel),
      env: Object.keys(env).length ? env : undefined,
      icon: icon || undefined,
      codexByok: codexByokConfig,
      claudeByok: claudeByokConfig,
      deepseekByok: deepseekByokConfig,
      piByok: piByokConfig,
      skillIds,
      enabled: ex.enabled
    };
  };

  if (baselineRef.current === null) {
    baselineRef.current = JSON.stringify(buildOverride());
  }
  const dirty = JSON.stringify(buildOverride()) !== baselineRef.current;
  latestDirtyRef.current = dirty;
  if (dirtyRef) dirtyRef.current = dirty;

  const onSave = async () => {
    if (saveStatus === "saving" || !dirty) return;
    setSaveStatus("saving");
    setSaveError("");
    const override = buildOverride();
    try {
      await upsert(override);
      refreshMembers();
      setModel(extractModelArg(override.extraArgs ?? []).model);
      setExtraArgs(extractModelArg(override.extraArgs ?? []).args.join("\n"));
      setCodexApiKey("");
      setDeepseekOfficialApiKey("");
      baselineRef.current = JSON.stringify(override);
      setSaveStatus("saved");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    }
  };

  const onResetOrDelete = async () => {
    if (saveStatus === "saving") return;
    setSaveStatus("idle");
    setSaveError("");
    if (
      isClone
        ? !window.confirm(t("settings.cli.deleteAgentConfirm", { label: ex.label }))
        : dirty && !window.confirm(t("settings.cli.unsavedConfirm"))
    ) {
      return;
    }
    try {
      await reset(ex.id);
      refreshMembers();
      onResetSelection();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    }
  };

  return (
    <section className="adapter-editor-form">
      <header className="adapter-editor-header">
        <div className="adapter-editor-titlebar">
          <button
            type="button"
            className="adapter-editor-back"
            onClick={onBackToList}
          >
            <ChevronLeft
              size={15}
              className="adapter-editor-back-chevron"
              aria-hidden="true"
            />
            {t("settings.cli.backToList")}
          </button>
          <div className="adapter-editor-heading">
            <AgentAvatar
              adapter={ex.baseAdapter ?? ex.id}
              agentId={`cli-${ex.id}`}
              className="adapter-editor-avatar"
              fallback={<span>{ex.label.slice(0, 2).toUpperCase()}</span>}
            />
            <div className="adapter-editor-heading-text">
              <h3>{ex.label}</h3>
              <div className="adapter-editor-meta">
                {headerMeta}
                {ex.docsUrl && (
                  <a className="adapter-editor-docs-link" href={ex.docsUrl} target="_blank" rel="noreferrer">
                    {t("settings.cli.setupGuide")} ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="adapter-editor-status-group">
          {ex.runtime?.installed ? (
            <span className="adapter-status adapter-editor-status ok">
              {t("settings.cli.installed")}
            </span>
          ) : ex.runtime ? (
            <span
              className="adapter-status adapter-editor-status warn"
              title={ex.runtime.lastError}
            >
              {t("settings.cli.notInstalled")}
            </span>
          ) : (
            <span className="adapter-status adapter-editor-status muted">
              {t("settings.cli.notChecked")}
            </span>
          )}
          {ex.runtime?.installed && ex.installHint && (
            <button
              type="button"
              className="adapter-editor-upgrade"
              disabled={installing}
              title={t("settings.cli.upgradeHint")}
              onClick={() =>
                startInstall({
                  adapterId: ex.id,
                  label: ex.label,
                  command: ex.installHint!
                })
              }
            >
              {installing ? t("common.upgrading") : t("common.upgrade")}
            </button>
          )}
          {headerActions}
        </div>
      </header>

      <div className="adapter-editor-scroll">
        {/* ── Identity section ── */}
        <div className="adapter-editor-section">
          <h4 className="adapter-editor-section-title">
            {t("settings.cli.section.identity")}
          </h4>
          <div className="icon-picker-field">
            <span className="icon-picker-label">{t("settings.cli.avatar")}</span>
            <AvatarPicker
              value={icon}
              onChange={setIcon}
              defaultAdapter={ex.baseAdapter ?? ex.id}
              defaultLabel={ex.label}
            />
          </div>

          {isClone && (
            <label className="adapter-editor-field">
              <span className="adapter-editor-field-label">{t("settings.cli.name")}</span>
              <input
                value={label}
                placeholder={ex.label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
          )}
        </div>

        {/* ── Command Configuration section ── */}
        <div className="adapter-editor-section">
          <h4 className="adapter-editor-section-title">
            {t("settings.cli.section.command")}
          </h4>
          <label className="adapter-editor-field">
            <span className="adapter-editor-field-label">{t("settings.cli.commandOverride")}</span>
            <input
              value={binary}
              placeholder={t("settings.cli.useDefault")}
              onChange={(e) => setBinary(e.target.value)}
            />
          </label>

          <label className="adapter-editor-field">
            <span className="adapter-editor-field-label">{t("settings.cli.model")}</span>
            <input
              value={model}
              placeholder={t("settings.cli.useAgentDefault")}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <div className="adapter-editor-field">
            <span className="adapter-editor-field-label">{t("skills.agentDefaults")}</span>
            <SkillPicker skills={skills} selectedIds={skillIds} onChange={setSkillIds} />
            <span className="settings-field-hint">{t("skills.agentDefaultsHint")}</span>
          </div>
        </div>

        {/* ── API Key (BYOK) section ── */}
        {supportsByok && (
          <fieldset className="settings-fieldset">
            <legend>{t("settings.cli.byok.title")}</legend>
            <p className="settings-fieldset-desc">
              {t("settings.cli.byok.description")}
            </p>

            <div className="settings-choice-group" role="group">
              <button
                type="button"
                className={!codexByokEnabled ? "active" : undefined}
                onClick={() => setCodexByokEnabled(false)}
              >
                {t(
                  isDeepSeek
                    ? "settings.cli.byok.modeDefaultDeepSeek"
                    : "settings.cli.byok.modeDefault"
                )}
              </button>
              <button
                type="button"
                className={codexByokEnabled ? "active" : undefined}
                onClick={() => setCodexByokEnabled(true)}
              >
                {t(
                  isDeepSeek
                    ? "settings.cli.byok.modeCustomDeepSeek"
                    : "settings.cli.byok.modeCustom"
                )}
              </button>
            </div>

            {!codexByokEnabled && isDeepSeek && (
              <>
                <p
                  className="settings-field-hint"
                  style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}
                >
                  {t("settings.cli.byok.modeDefaultHintDeepSeek")}
                </p>
                <label className="adapter-editor-field">
                  <span className="adapter-editor-field-label">
                    {t("settings.cli.byok.apiKey")}
                  </span>
                  <input
                    type="password"
                    value={deepseekOfficialApiKey}
                    placeholder={
                      savedDeepSeekByok?.officialApiKeyPreview ||
                      t("settings.cli.byok.apiKeyPlaceholder")
                    }
                    onChange={(e) => setDeepseekOfficialApiKey(e.target.value)}
                  />
                  <span className="settings-field-hint">
                    {savedDeepSeekByok?.officialApiKeyPreview
                      ? t("settings.cli.byok.savedKeyHint", {
                          preview: savedDeepSeekByok.officialApiKeyPreview
                        })
                      : t("settings.cli.byok.newKeyHint")}
                  </span>
                </label>
                <p className="settings-secure-note">
                  {t("settings.cli.byok.hint")}
                </p>
              </>
            )}

            {codexByokEnabled && (
              <>
                <div className="adapter-editor-field">
                  <ProviderSelect
                    adapter={ex.baseAdapter ?? ex.id}
                    value={selectedProviderId}
                    onChange={(pid) => {
                      setSelectedProviderId(pid);
                      if (pid) {
                        const p = providers.find((x) => x.id === pid);
                        if (p) {
                          if (isCodex) {
                            setCodexProviderId(p.presetId ?? p.id);
                            setCodexProviderName(p.name);
                          }
                          setCodexBaseUrl(p.baseUrl);
                          setCodexEnvKey(p.envKey);
                          const active = p.models.filter((m) => m.enabled !== false);
                          setByokModels(
                            active.map((m) => ({
                              id: m.id,
                              name: m.name ?? "",
                              contextWindow: m.contextWindow,
                              supportsVision: m.supportsVision
                            }))
                          );
                          if (!model.trim() && active[0]?.id) {
                            setModel(active[0].id);
                          }
                        }
                      }
                    }}
                  />
                </div>
                {selectedProvider ? (
                  <p className="settings-field-hint">
                    {t("providers.managedHint")}：{selectedProvider.name} · {selectedProvider.baseUrl}
                    {selectedProvider.apiKeyPreview ? ` · ${selectedProvider.apiKeyPreview}` : ""}
                  </p>
                ) : null}
                <label className="adapter-editor-field">
                  <span className="adapter-editor-field-label">{t("settings.cli.byok.baseUrl")}</span>
                  <input
                    type="url"
                    value={selectedProvider ? selectedProvider.baseUrl : codexBaseUrl}
                    placeholder={byokBaseUrlPlaceholder}
                    disabled={Boolean(selectedProvider)}
                    onChange={(e) => setCodexBaseUrl(e.target.value)}
                  />
                  <span className="settings-field-hint">
                    {t(
                      isClaude
                        ? "settings.cli.byok.baseUrlHintClaude"
                        : isDeepSeek
                          ? "settings.cli.byok.baseUrlHintDeepSeek"
                          : isPi
                            ? "settings.cli.byok.baseUrlHintPi"
                            : "settings.cli.byok.baseUrlHintCodex"
                    )}
                  </span>
                </label>
                <label className="adapter-editor-field">
                  <span className="adapter-editor-field-label">{t("settings.cli.byok.apiKey")}</span>
                  <input
                    type="password"
                    value={codexApiKey}
                    placeholder={
                      selectedProvider?.apiKeyPreview ||
                      savedByok?.apiKeyPreview ||
                      t("settings.cli.byok.apiKeyPlaceholder")
                    }
                    disabled={Boolean(selectedProvider)}
                    onChange={(e) => setCodexApiKey(e.target.value)}
                  />
                  <span className="settings-field-hint">
                    {selectedProvider
                      ? selectedProvider.apiKeyPreview
                        ? t("settings.cli.byok.providerKeyHint", {
                            name: selectedProvider.name,
                            preview: selectedProvider.apiKeyPreview
                          })
                        : t("providers.managedHint")
                      : savedByok?.apiKeyPreview
                        ? t("settings.cli.byok.savedKeyHint", {
                            preview: savedByok.apiKeyPreview
                          })
                        : t("settings.cli.byok.newKeyHint")}
                  </span>
                </label>

                <div className="adapter-editor-field">
                  <span className="adapter-editor-field-label">
                    {t("settings.cli.byok.models")}
                  </span>
                  <div className="byok-model-list">
                    <div
                      className={`byok-model-header${
                        isCodex ? " byok-model-header--with-context" : ""
                      }`}
                      aria-hidden="true"
                    >
                      <span>{t("settings.cli.byok.modelIdPlaceholder")}</span>
                      <span>{t("settings.cli.byok.modelNamePlaceholder")}</span>
                      {isCodex && (
                        <span>
                          {t("settings.cli.byok.modelContextWindowHeader")}
                        </span>
                      )}
                      {isCodex && (
                        <span>{t("settings.cli.byok.modelVisionHeader")}</span>
                      )}
                    </div>
                    {byokModels.map((byokModel, index) => (
                      <div
                        className={`byok-model-row${
                          isCodex ? " byok-model-row--with-context" : ""
                        }`}
                        key={index}
                      >
                        <input
                          value={byokModel.id}
                          placeholder={t(
                            "settings.cli.byok.modelIdPlaceholder"
                          )}
                          aria-label={t("settings.cli.byok.modelIdPlaceholder")}
                          disabled={Boolean(selectedProvider)}
                          onChange={(event) =>
                            setByokModels((models) =>
                              models.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? { ...entry, id: event.target.value }
                                  : entry
                              )
                            )
                          }
                        />
                        <input
                          value={byokModel.name ?? ""}
                          placeholder={t(
                            "settings.cli.byok.modelNamePlaceholder"
                          )}
                          aria-label={t("settings.cli.byok.modelNamePlaceholder")}
                          disabled={Boolean(selectedProvider)}
                          onChange={(event) =>
                            setByokModels((models) =>
                              models.map((entry, entryIndex) =>
                                entryIndex === index
                                  ? { ...entry, name: event.target.value }
                                  : entry
                              )
                            )
                          }
                        />
                        {isCodex && (
                          <input
                            type="number"
                            min={BYOK_CONTEXT_WINDOW_MIN}
                            max={BYOK_CONTEXT_WINDOW_MAX}
                            step={1000}
                            value={byokModel.contextWindow ?? ""}
                            placeholder={t(
                              "settings.cli.byok.modelContextWindowPlaceholder"
                            )}
                            aria-label={t(
                              "settings.cli.byok.modelContextWindowPlaceholder"
                            )}
                            aria-invalid={
                              String(byokModel.contextWindow ?? "").trim() !==
                                "" &&
                              parseByokContextWindow(
                                byokModel.contextWindow
                              ) === undefined
                                ? true
                                : undefined
                            }
                            disabled={Boolean(selectedProvider)}
                            onChange={(event) =>
                              setByokModels((models) =>
                                models.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? {
                                        ...entry,
                                        contextWindow: event.target.value
                                      }
                                    : entry
                                )
                              )
                            }
                          />
                        )}
                        {(isCodex || isDeepSeek) && (
                          <label
                            className="byok-model-vision"
                            title={t("settings.cli.byok.modelVisionHint")}
                          >
                            <input
                              type="checkbox"
                              checked={isCodex ? byokModel.supportsVision !== false : byokModel.supportsVision === true}
                              aria-label={t(
                                "settings.cli.byok.modelVisionEnabled"
                              )}
                              disabled={Boolean(selectedProvider)}
                              onChange={(event) =>
                                setByokModels((models) =>
                                  models.map((entry, entryIndex) =>
                                    entryIndex === index
                                      ? {
                                          ...entry,
                                          supportsVision: event.target.checked
                                        }
                                      : entry
                                  )
                                )
                              }
                            />
                            <span>
                              {t("settings.cli.byok.modelVisionEnabled")}
                            </span>
                          </label>
                        )}
                        {selectedProvider ? (
                          <span aria-hidden="true" />
                        ) : (
                          <button
                            type="button"
                            className="byok-model-remove"
                            aria-label={t("settings.cli.byok.removeModel")}
                            title={t("settings.cli.byok.removeModel")}
                            onClick={() =>
                              setByokModels((models) =>
                                models.filter(
                                  (_, entryIndex) => entryIndex !== index
                                )
                              )
                            }
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ))}
                    {!selectedProvider && (
                      <button
                        type="button"
                        className="byok-model-add"
                        onClick={() =>
                          setByokModels((models) => [
                            ...models,
                            { id: "", name: "", supportsVision: isCodex }
                          ])
                        }
                      >
                        <Plus size={15} aria-hidden="true" />
                        {t("settings.cli.byok.addModel")}
                      </button>
                    )}
                  </div>
                  <span className="settings-field-hint">
                    {selectedProvider
                      ? selectedProvider.models.filter((m) => m.enabled !== false).length === 0
                        ? t("settings.cli.byok.providerNoActiveModels")
                        : t("settings.cli.byok.providerModelsHint", {
                            name: selectedProvider.name
                          })
                      : t(
                          isCodex
                            ? "settings.cli.byok.modelsHintCodex"
                            : "settings.cli.byok.modelsHint"
                        )}
                  </span>
                </div>

                {isClaude && (
                <div className="byok-context-section">
                  <div className="byok-context-section-heading">
                    <span className="byok-context-section-title">
                      {t("settings.cli.byok.contextHandling")}
                    </span>
                    <span className="settings-field-hint">
                      {t(
                        isClaude
                          ? "settings.cli.byok.contextHandlingHintClaude"
                          : "settings.cli.byok.contextHandlingHintCodex"
                      )}
                    </span>
                  </div>

                  <label className="adapter-editor-field">
                    <span className="adapter-editor-field-label">
                      {t(
                        isClaude
                          ? "settings.cli.byok.compactionWindow"
                          : "settings.cli.byok.contextWindow"
                      )}
                    </span>
                    <span className="byok-context-input">
                      <input
                        type="number"
                        min={BYOK_CONTEXT_WINDOW_MIN}
                        max={BYOK_CONTEXT_WINDOW_MAX}
                        step={1000}
                        value={byokContextWindow}
                        placeholder={t(
                          isClaude
                            ? "settings.cli.byok.contextWindowPlaceholderClaude"
                            : "settings.cli.byok.contextWindowPlaceholderCodex"
                        )}
                        aria-describedby="byok-context-window-hint"
                        aria-invalid={byokContextWindowInvalid || undefined}
                        onChange={(e) => setByokContextWindow(e.target.value)}
                      />
                      <span className="byok-context-input-unit">
                        {t("settings.cli.byok.tokensUnit")}
                      </span>
                    </span>
                    <span
                      id="byok-context-window-hint"
                      className={`settings-field-hint${
                        byokContextWindowInvalid ? " error" : ""
                      }`}
                    >
                      {byokContextWindowInvalid
                        ? t("settings.cli.byok.contextWindowInvalid", {
                            min: BYOK_CONTEXT_WINDOW_MIN.toLocaleString(),
                            max: BYOK_CONTEXT_WINDOW_MAX.toLocaleString()
                          })
                        : t(
                            isClaude
                              ? "settings.cli.byok.contextWindowHintClaude"
                              : "settings.cli.byok.contextWindowHintCodex"
                          )}
                    </span>
                  </label>

                  {isClaude && (
                    <label className="byok-checkbox-field">
                      <span className="byok-checkbox-row">
                        <input
                          type="checkbox"
                          checked={claudeCompactionEnabled}
                          aria-describedby="byok-compaction-hint"
                          onChange={(e) =>
                            setClaudeCompactionEnabled(e.target.checked)
                          }
                        />
                        <span className="adapter-editor-field-label">
                          {t("settings.cli.byok.compactionEnabled")}
                        </span>
                      </span>
                      <span
                        id="byok-compaction-hint"
                        className="settings-field-hint"
                      >
                        {t("settings.cli.byok.compactionEnabledHint")}
                      </span>
                    </label>
                  )}

                  <div className="byok-context-note" role="note">
                    <Info size={15} aria-hidden="true" />
                    <span>
                      <strong>
                        {t("settings.cli.byok.contextNoteTitle")}
                      </strong>{" "}
                      {t(
                        isClaude
                          ? "settings.cli.byok.contextNoteClaude"
                          : "settings.cli.byok.contextNoteCodex"
                      )}
                    </span>
                  </div>
                </div>
                )}

                <details className="settings-advanced-panel">
                  <summary>{t("settings.cli.byok.advanced")}</summary>
                  {isCodex && (
                    <>
                      <label className="adapter-editor-field">
                        <span className="adapter-editor-field-label">{t("settings.cli.byok.providerId")}</span>
                        <input
                          value={codexProviderId}
                          placeholder="proxy"
                          onChange={(e) => setCodexProviderId(e.target.value)}
                        />
                      </label>
                      <label className="adapter-editor-field">
                        <span className="adapter-editor-field-label">{t("settings.cli.byok.providerName")}</span>
                        <input
                          value={codexProviderName}
                          placeholder="OpenAI proxy"
                          onChange={(e) => setCodexProviderName(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <label className="adapter-editor-field">
                    <span className="adapter-editor-field-label">{t("settings.cli.byok.envKey")}</span>
                    <input
                      value={codexEnvKey}
                      placeholder={
                        isClaude
                          ? "ANTHROPIC_API_KEY"
                          : isDeepSeek
                            ? "DEEPSEEK_API_KEY"
                            : "OPENAI_API_KEY"
                      }
                      onChange={(e) => setCodexEnvKey(e.target.value)}
                    />
                  </label>
                  {isCodex && (
                    <label className="adapter-editor-field">
                      <span className="adapter-editor-field-label">{t("settings.cli.byok.wireApi")}</span>
                      <select
                        value={codexWireApi}
                        onChange={(e) =>
                          setCodexWireApi(e.target.value as typeof codexWireApi)
                        }
                      >
                        <option value="responses">responses (/v1/responses)</option>
                        <option value="chat">chat (/v1/chat/completions · local bridge)</option>
                      </select>
                    </label>
                  )}
                  {isDeepSeek && (
                    <label className="adapter-editor-field">
                      <span className="adapter-editor-field-label">{t("settings.cli.byok.wireApi")}</span>
                      <select value="chat" disabled>
                        <option value="chat">chat (/v1/chat/completions)</option>
                      </select>
                    </label>
                  )}
                </details>

                <p className="settings-secure-note">
                  {t("settings.cli.byok.hint")}
                </p>
              </>
            )}
          </fieldset>
        )}

        {/* ── Advanced section ── */}
        <div className="adapter-editor-section">
          <h4 className="adapter-editor-section-title">
            {t("settings.cli.section.advanced")}
          </h4>
          <label className="adapter-editor-field">
            <span className="adapter-editor-field-label">{t("settings.cli.extraArgs")}</span>
            <textarea
              rows={3}
              value={extraArgs}
              onChange={(e) => setExtraArgs(e.target.value)}
            />
          </label>

          <label className="adapter-editor-field">
            <span className="adapter-editor-field-label">{t("settings.cli.environment")}</span>
            <textarea
              rows={3}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="adapter-editor-actions modal-actions">
        <div className="adapter-save-feedback">
          {saveStatus === "saved" && (
            <span className="adapter-save-message ok" role="status">
              ✓ {t("settings.cli.saveSuccess")}
            </span>
          )}
          {saveStatus === "error" && (
            <span className="adapter-save-message error" role="alert">
              {t("settings.cli.saveFailed", { err: saveError })}
            </span>
          )}
          {dirty && saveStatus === "idle" && (
            <span className="adapter-save-message warn" role="status">
              {t("settings.cli.unsavedChanges")}
            </span>
          )}
        </div>
        <button
          type="button"
          className={`adapter-secondary-action${isClone ? " danger" : ""}`}
          onClick={onResetOrDelete}
          disabled={saveStatus === "saving"}
        >
          {isClone ? t("common.delete") : t("common.reset")}
        </button>
        <button
          type="button"
          className="primary adapter-save-btn"
          onClick={onSave}
          disabled={saveStatus === "saving" || !dirty}
        >
          {saveStatus === "saving"
            ? t("common.saving")
            : saveStatus === "saved"
              ? t("common.saved")
              : t("common.save")}
        </button>
      </div>
    </section>
  );
}
