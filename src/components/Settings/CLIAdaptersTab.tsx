import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCliExecutorStore, type ResolvedExecutor } from "@/store/cliExecutorStore";
import { cliClient } from "@/services/cli/client";
import type { CLIExecutorOverride } from "@/services/cli/types";
import { AgentAvatar } from "@/components/CLI/AgentAvatar";
import { AvatarPicker } from "./AvatarPicker";

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

export function CLIAdaptersTab() {
  const { t } = useTranslation();
  const loaded = useCliExecutorStore((s) => s.loaded);
  const load = useCliExecutorStore((s) => s.load);
  const adapters = useCliExecutorStore((s) => s.adapters);
  const overrides = useCliExecutorStore((s) => s.overrides);
  const runtimes = useCliExecutorStore((s) => s.runtimes);
  const resolve = useCliExecutorStore((s) => s.resolve);
  const check = useCliExecutorStore((s) => s.check);

  const list = useMemo<ResolvedExecutor[]>(
    () =>
      adapters
        .filter((a) => a.protocol === "acp")
        .map((a) => resolve(a.id))
        .filter((x): x is ResolvedExecutor => !!x),
    // resolve is stable (zustand getter); recompute when inputs change.
    [adapters, overrides, runtimes, resolve]
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

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

  return (
    <div className="settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("settings.cli.title")}</h3>
        <span className="settings-section-desc">
          {t("settings.cli.description")}
        </span>
      </div>

      <div className="adapter-list">
        {list.map((ex) => (
          <AdapterRow
            key={ex.id}
            ex={ex}
            onCheck={() => void check(ex.id)}
            onEdit={() => setEditingId(ex.id)}
            onInstall={async () => {
              if (!ex.installHint) return;
              setInstalling(ex.id);
              try {
                const r = await cliClient.install(ex.installHint);
                if (!r.success) {
                  alert(t("settings.cli.installFailed", { code: r.exitCode, output: r.stderr || r.stdout }));
                } else {
                  await check(ex.id);
                }
              } finally {
                setInstalling(null);
              }
            }}
            installing={installing === ex.id}
          />
        ))}
      </div>

      {editingId && (
        <EditOverrideDialog
          executorId={editingId}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function AdapterRow({
  ex,
  onCheck,
  onEdit,
  onInstall,
  installing
}: {
  ex: ResolvedExecutor;
  onCheck: () => void;
  onEdit: () => void;
  onInstall: () => void;
  installing: boolean;
}) {
  const { t } = useTranslation();
  const rt = ex.runtime;
  const parsedExtraArgs = extractModelArg(ex.extraArgs);
  const model = parsedExtraArgs.model;
  return (
    <div className="adapter-row">
      <AgentAvatar
        adapter={ex.id}
        className="adapter-avatar"
        fallback={<span>{ex.label.slice(0, 2).toUpperCase()}</span>}
      />
      <div className="adapter-row-main">
        <div className="adapter-row-title">
          <strong>{ex.label}</strong>
        </div>
        <div className="adapter-row-meta">
          {rt?.installed ? (
            <span className="adapter-status ok">
              {t("settings.cli.installed")} {rt.version ? `(${rt.version})` : ""}
            </span>
          ) : rt ? (
            <span className="adapter-status warn">{t("settings.cli.notInstalled")}</span>
          ) : (
            <span className="adapter-status muted">{t("settings.cli.notChecked")}</span>
          )}
          {model && (
            <span className="muted">
              {t("settings.cli.modelLabel")}: <code>{model}</code>
            </span>
          )}
        </div>
      </div>
      <div className="adapter-row-actions">
        <button onClick={onCheck}>{t("common.check")}</button>
        {!rt?.installed && ex.installHint && (
          <button onClick={onInstall} disabled={installing}>
            {installing ? t("common.installing") : t("common.install")}
          </button>
        )}
        <button onClick={onEdit}>{t("common.edit")}</button>
      </div>
    </div>
  );
}

function EditOverrideDialog({
  executorId,
  onClose
}: {
  executorId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const resolve = useCliExecutorStore((s) => s.resolve);
  const override = useCliExecutorStore((s) => s.overrides[executorId]);
  const ex = resolve(executorId);
  const upsert = useCliExecutorStore((s) => s.upsertOverride);
  const reset = useCliExecutorStore((s) => s.resetOverride);

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

  if (!ex) return null;

  const onSave = async () => {
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

    const override: CLIExecutorOverride = {
      id: ex.id,
      binary:
        binary.trim() && binary.trim() !== ex.defaultBinary
          ? binary.trim()
          : undefined,
      extraArgs: withModelArg(cleanedExtraArgs, model),
      env: Object.keys(env).length ? env : undefined,
      icon: icon || undefined,
      enabled: true
    };
    await upsert(override);
    onClose();
  };

  const onReset = async () => {
    await reset(ex.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("settings.cli.editTitle", { label: ex.label })}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>

        <div className="icon-picker-field">
          <span className="icon-picker-label">{t("settings.cli.avatar")}</span>
          <AvatarPicker
            value={icon}
            onChange={setIcon}
            defaultAdapter={ex.id}
            defaultLabel={ex.label}
          />
        </div>

        <label>
          {t("settings.cli.commandOverride")}
          <input
            value={binary}
            placeholder={t("settings.cli.useDefault")}
            onChange={(e) => setBinary(e.target.value)}
          />
        </label>

        <label>
          {t("settings.cli.model")}
          <input
            value={model}
            placeholder={t("settings.cli.useAgentDefault")}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <label>
          {t("settings.cli.extraArgs")}
          <textarea
            rows={4}
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </label>

        <label>
          {t("settings.cli.environment")}
          <textarea
            rows={4}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </label>

        {ex.docsUrl && (
          <p className="muted">
            {t("settings.cli.docs")}{" "}
            <a href={ex.docsUrl} target="_blank" rel="noreferrer">
              {t("settings.cli.setupGuide")}
            </a>
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onReset}>{t("common.reset")}</button>
          <button onClick={onClose}>{t("common.cancel")}</button>
          <button className="primary" onClick={onSave}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
