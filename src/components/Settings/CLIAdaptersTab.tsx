import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";

import { useCliExecutorStore, type ResolvedExecutor } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import type {
  CliAuthProbeResult,
  CLIExecutorOverride,
  CliRuntime
} from "@/services/cli/types";
import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { AvatarPicker } from "./AvatarPicker";
import { useCliInstallStore } from "@/store/cliInstallStore";
import { useAgentBridgeStore } from "@/store/agentBridgeStore";
import { getAgentIconId } from "@/config/agentIcon";

const CODEX_ACP_UPGRADE_REQUIRED = "codex-acp requires @agentclientprotocol/codex-acp";

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

type AgentCategory = "builtin" | "custom";

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

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<AgentCategory>("builtin");

  const categoryCounts = useMemo(() => {
    let builtin = 0;
    let custom = 0;
    for (const ex of list) {
      if (ex.isClone) custom += 1;
      else builtin += 1;
    }
    return { builtin, custom };
  }, [list]);

  const filteredList = useMemo(
    () =>
      list.filter(
        (ex) =>
          categoryOf(ex) === category && matchesQuery(ex, query)
      ),
    [list, category, query]
  );

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

  useEffect(() => {
    if (!loaded) return;
    if (editingId && !list.some((ex) => ex.id === editingId)) {
      setEditingId(null);
      return;
    }
  }, [editingId, list, loaded]);

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

  const renderRow = (ex: ResolvedExecutor) => (
    <AdapterRow
      key={ex.id}
      ex={ex}
      checking={checkingIds.has(ex.id)}
      selected={false}
      onCheck={() => void handleCheck(ex.id)}
      onClone={() => void handleClone(ex)}
      onEdit={() => setEditingId(ex.id)}
      onInstall={() => {
        if (!ex.installHint) return;
        startInstall({
          adapterId: ex.id,
          label: ex.label,
          command: ex.installHint
        });
      }}
      authProbe={authProbes[ex.id]}
      authBusy={authBusyIds.has(ex.id)}
      authMessage={authMessages[ex.id]}
      onAuthProbe={() => void handleAuthProbe(ex)}
      onLogout={() => void handleLogout(ex)}
      installing={installingIdSet.has(ex.id)}
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

  if (editingId && selectedExecutor) {
    return (
      <div className="settings-tab">
        <div className="adapter-edit-workspace">
          <EditOverridePanel
            key={selectedExecutor.id}
            executorId={selectedExecutor.id}
            onBackToList={() => setEditingId(null)}
            onResetSelection={() => setEditingId(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("settings.cli.title")}</h3>
        <span className="settings-section-desc">
          {t("settings.cli.description")}
        </span>
      </div>

      <div className="adapter-list-toolbar">
        <div className="adapter-filter-tabs" role="tablist">
          {(["builtin", "custom"] as AgentCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              className={category === c ? "active" : undefined}
              onClick={() => setCategory(c)}
              disabled={!loaded}
            >
              {t(`settings.cli.category.${c}`)}{" "}
              <span>{categoryCounts[c]}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="adapter-search"
          placeholder={t("settings.cli.searchAgents")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="adapter-settings-workspace">
        <div className="adapter-list-panel">
          <div className="adapter-list">
            {!loaded ? (
              <p className="muted">{t("settings.cli.loading")}</p>
            ) : filteredList.length === 0 ? (
              <p className="muted adapter-empty">{t("settings.cli.noResults")}</p>
            ) : (
              filteredList.map((ex) => renderRow(ex))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdapterRow({
  ex,
  checking,
  selected,
  onCheck,
  onClone,
  onEdit,
  onInstall,
  authProbe,
  authBusy,
  authMessage,
  onAuthProbe,
  onLogout,
  installing
}: {
  ex: ResolvedExecutor;
  checking: boolean;
  selected: boolean;
  onCheck: () => void;
  onClone: () => void;
  onEdit: () => void;
  onInstall: () => void;
  authProbe?: CliAuthProbeResult;
  authBusy: boolean;
  authMessage?: string;
  onAuthProbe: () => void;
  onLogout: () => void;
  installing: boolean;
}) {
  const { t } = useTranslation();
  const rt = ex.runtime;
  const codexCliRuntime = useCliExecutorStore((state) => state.runtimes.codex);
  const parsedExtraArgs = extractModelArg(ex.extraArgs);
  const model = parsedExtraArgs.model;
  const statusKind = checking
    ? "checking"
    : rt?.installed
      ? "available"
      : rt
        ? "unavailable"
        : "unchecked";
  const codexUpdateStatus = ex.id === "codex-acp" ? rt?.updateStatus : undefined;
  return (
    <div className={`adapter-row${selected ? " selected" : ""}`}>
      <AgentAvatar
        adapter={ex.id}
        className="adapter-avatar"
        fallback={<span>{ex.label.slice(0, 2).toUpperCase()}</span>}
      />
      <button type="button" className="adapter-row-main" onClick={onEdit}>
        <div className="adapter-row-title">
          <strong>{ex.label}</strong>
          <span className={`adapter-availability ${statusKind}`}>
            {checking
              ? t("settings.cli.checking")
              : rt?.installed
                ? t("settings.cli.installed")
                : rt
                  ? t("settings.cli.notInstalled")
                  : t("settings.cli.notChecked")}
          </span>
        </div>
        <div className="adapter-row-meta">
          {checking ? (
            <span className="adapter-status muted">{t("settings.cli.checking")}</span>
          ) : rt?.installed ? (
            <span className="adapter-status ok">
              {t("settings.cli.installed")} {rt.version ? `(${rt.version})` : ""}
            </span>
          ) : rt ? (
            <span className="adapter-status warn" title={rt.lastError}>
              {t("settings.cli.notInstalled")}
            </span>
          ) : (
            <span className="adapter-status muted">{t("settings.cli.notChecked")}</span>
          )}
          {!checking && rt?.lastError && !rt.installed && (
            <span className="adapter-status error" title={rt.lastError}>
              {t(cliRuntimeErrorKey(rt.lastError))}
            </span>
          )}
          {ex.id === "codex-acp" && codexCliRuntime?.installed && (
            <span className="muted">
              Codex CLI: <code>{codexCliRuntime.version}</code>
            </span>
          )}
          <RuntimeAutoUpdateStatus
            runtime={codexUpdateStatus ? rt : undefined}
            label="Codex ACP"
          />
          {ex.id === "codex-acp" && (
            <RuntimeAutoUpdateStatus
              runtime={codexCliRuntime}
              label="Codex CLI"
            />
          )}
          {model && (
            <span className="muted">
              {t("settings.cli.modelLabel")}: <code>{model}</code>
            </span>
          )}
          {authMessage && (
            <span className="adapter-status muted" title={authMessage}>
              {authMessage}
            </span>
          )}
        </div>
      </button>
      <div className="adapter-row-actions">
        {!rt?.installed && ex.installHint && (
          <button
            type="button"
            className="primary"
            onClick={onInstall}
            disabled={installing || checking}
          >
            {installing ? t("common.installing") : t("common.install")}
          </button>
        )}
        <button type="button" onClick={onCheck} disabled={checking || installing}>
          {checking ? t("settings.cli.checking") : t("common.check")}
        </button>
        {rt?.installed && !authProbe && (
          <button type="button" onClick={onAuthProbe} disabled={authBusy}>
            {authBusy
              ? t("settings.cli.authChecking")
              : t("settings.cli.checkAuthentication")}
          </button>
        )}
        {rt?.installed && authProbe?.logoutSupported && (
          <button
            type="button"
            className="danger"
            onClick={onLogout}
            disabled={authBusy}
          >
            {authBusy ? t("settings.cli.loggingOut") : t("settings.cli.logout")}
          </button>
        )}
        <button type="button" onClick={onClone} disabled={checking || installing}>
          {t("common.clone")}
        </button>
        <button type="button" className="adapter-row-edit-btn" onClick={onEdit} disabled={checking || selected}>
          ›
        </button>
      </div>
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
  onBackToList,
  onResetSelection
}: {
  executorId: string;
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
  const adapterForConfig = ex?.baseAdapter ?? ex?.id;
  const isCodex = adapterForConfig === "codex-acp";
  const isClaude =
    adapterForConfig === "claude-agent-acp" || adapterForConfig === "claude";
  const savedCodexByok = ex?.override?.codexByok;
  const savedClaudeByok = ex?.override?.claudeByok;
  const savedByok = isCodex
    ? savedCodexByok
    : isClaude
      ? savedClaudeByok
      : undefined;
  const [codexByokEnabled, setCodexByokEnabled] = useState(
    savedByok?.enabled === true
  );
  const [codexProviderId, setCodexProviderId] = useState(
    savedCodexByok?.providerId ?? "proxy"
  );
  const [codexProviderName, setCodexProviderName] = useState(
    savedCodexByok?.providerName ?? "BYOK provider"
  );
  const [codexBaseUrl, setCodexBaseUrl] = useState(savedByok?.baseUrl ?? "");
  const [codexEnvKey, setCodexEnvKey] = useState(
    savedByok?.envKey ?? (isClaude ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY")
  );
  const [codexWireApi, setCodexWireApi] = useState<
    NonNullable<NonNullable<CLIExecutorOverride["codexByok"]>["wireApi"]>
  >(savedCodexByok?.wireApi ?? "responses");
  const [codexApiKey, setCodexApiKey] = useState("");
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    setSaveStatus("idle");
    setSaveError("");
  }, [executorId]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timer = window.setTimeout(() => setSaveStatus("idle"), 2200);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  if (!ex) return null;

  const isClone = Boolean(ex.isClone);
  const supportsByok = isCodex || isClaude;
  const byokBaseUrlPlaceholder = isClaude
    ? "https://api.anthropic.com"
    : "https://api.openai.com/v1";

  const onSave = async () => {
    if (saveStatus === "saving") return;
    setSaveStatus("saving");
    setSaveError("");
    const cleanedExtraArgs = extraArgs
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const env: Record<string, string> = {};
    envText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      });

    const codexByokConfig =
      isCodex && codexByokEnabled
        ? {
            enabled: true,
            providerId: codexProviderId.trim() || "proxy",
            providerName: codexProviderName.trim() || "BYOK provider",
            baseUrl: codexBaseUrl.trim(),
            envKey: codexEnvKey.trim() || "OPENAI_API_KEY",
            wireApi: codexWireApi,
            apiKey: codexApiKey.trim() || undefined,
            apiKeyPreview: savedByok?.apiKeyPreview
          }
        : undefined;
    const claudeByokConfig =
      isClaude && codexByokEnabled
        ? {
            enabled: true,
            baseUrl: codexBaseUrl.trim(),
            envKey: codexEnvKey.trim() || "ANTHROPIC_API_KEY",
            apiKey: codexApiKey.trim() || undefined,
            apiKeyPreview: savedClaudeByok?.apiKeyPreview
          }
        : undefined;

    const override: CLIExecutorOverride = {
      id: ex.id,
      baseAdapter: ex.baseAdapter,
      label: isClone ? label.trim() || ex.label : undefined,
      binary:
        binary.trim() && binary.trim() !== ex.defaultBinary
          ? binary.trim()
          : undefined,
      extraArgs: withModelArg(cleanedExtraArgs, model),
      env: Object.keys(env).length ? env : undefined,
      icon: icon || undefined,
      codexByok: codexByokConfig,
      claudeByok: claudeByokConfig,
      enabled: true
    };
    try {
      await upsert(override);
      refreshMembers();
      setCodexApiKey("");
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
      isClone &&
      !window.confirm(t("settings.cli.deleteAgentConfirm", { label: ex.label }))
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
            <span className="adapter-editor-back-chevron">‹</span>
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
              {ex.docsUrl && (
                <a className="adapter-editor-docs-link" href={ex.docsUrl} target="_blank" rel="noreferrer">
                  {t("settings.cli.setupGuide")} ↗
                </a>
              )}
            </div>
          </div>
        </div>
        {ex.runtime?.installed ? (
          <span className="adapter-status adapter-editor-status ok">
            {t("settings.cli.installed")}
          </span>
        ) : (
          <span className="adapter-status adapter-editor-status muted">
            {t("settings.cli.notChecked")}
          </span>
        )}
      </header>

      <div className="adapter-editor-scroll">
        {/* ── Identity section ── */}
        <div className="adapter-editor-section">
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
                {t("settings.cli.byok.modeDefault")}
              </button>
              <button
                type="button"
                className={codexByokEnabled ? "active" : undefined}
                onClick={() => setCodexByokEnabled(true)}
              >
                {t("settings.cli.byok.modeCustom")}
              </button>
            </div>

            {codexByokEnabled && (
              <>
                <label className="adapter-editor-field">
                  <span className="adapter-editor-field-label">{t("settings.cli.byok.baseUrl")}</span>
                  <input
                    type="url"
                    value={codexBaseUrl}
                    placeholder={byokBaseUrlPlaceholder}
                    onChange={(e) => setCodexBaseUrl(e.target.value)}
                  />
                  <span className="settings-field-hint">
                    {t(
                      isClaude
                        ? "settings.cli.byok.baseUrlHintClaude"
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
                      savedByok?.apiKeyPreview ||
                      t("settings.cli.byok.apiKeyPlaceholder")
                    }
                    onChange={(e) => setCodexApiKey(e.target.value)}
                  />
                  <span className="settings-field-hint">
                    {savedByok?.apiKeyPreview
                      ? t("settings.cli.byok.savedKeyHint", {
                          preview: savedByok.apiKeyPreview
                        })
                      : t("settings.cli.byok.newKeyHint")}
                  </span>
                </label>

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
                        isClaude ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
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
                        <option value="responses">responses</option>
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
          disabled={saveStatus === "saving"}
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
