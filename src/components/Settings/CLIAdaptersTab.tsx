import { useEffect, useMemo, useState } from "react";

import { useCliExecutorStore, type ResolvedExecutor } from "@/store/cliExecutorStore";
import { cliClient } from "@/services/cli/client";
import type { CLIExecutorOverride } from "@/services/cli/types";

export function CLIAdaptersTab() {
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
        <h3 className="settings-section-title">CLI Adapters</h3>
        <p className="muted">
          CLI bridge is unavailable. Run the desktop app to manage CLI agents.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-tab">
      <h3 className="settings-section-title">CLI Adapters</h3>
      <p className="muted">
        Configure local CLI coding agents. Each adapter becomes a first-class
        FreeBuddy member.
      </p>

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
                  alert(`Install failed (exit ${r.exitCode}):\n${r.stderr || r.stdout}`);
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
  const rt = ex.runtime;
  return (
    <div className="adapter-row">
      <div className="adapter-row-main">
        <div className="adapter-row-title">
          <strong>{ex.label}</strong>
          <code>{ex.binary}</code>
        </div>
        <div className="adapter-row-meta">
          {rt?.installed ? (
            <span className="adapter-status ok">
              ✓ installed {rt.version ? `(${rt.version})` : ""}
            </span>
          ) : rt ? (
            <span className="adapter-status warn">not installed</span>
          ) : (
            <span className="adapter-status muted">not checked</span>
          )}
          {rt?.binaryPath && <span className="muted">{rt.binaryPath}</span>}
          {ex.extraArgs.length > 0 && (
            <span className="muted">
              args: <code>{ex.extraArgs.join(" ")}</code>
            </span>
          )}
        </div>
      </div>
      <div className="adapter-row-actions">
        <button onClick={onCheck}>Check</button>
        {!rt?.installed && ex.installHint && (
          <button onClick={onInstall} disabled={installing}>
            {installing ? "Installing…" : "Install"}
          </button>
        )}
        <button onClick={onEdit}>Edit</button>
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
  const resolve = useCliExecutorStore((s) => s.resolve);
  const override = useCliExecutorStore((s) => s.overrides[executorId]);
  const ex = resolve(executorId);
  const upsert = useCliExecutorStore((s) => s.upsertOverride);
  const reset = useCliExecutorStore((s) => s.resetOverride);

  const [binary, setBinary] = useState(ex?.override?.binary ?? "");
  const [extraArgs, setExtraArgs] = useState(
    (ex?.override?.extraArgs ?? []).join("\n")
  );
  const [envText, setEnvText] = useState(
    Object.entries(ex?.override?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
  );

  if (!ex) return null;

  const onSave = async () => {
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
      binary: binary.trim() || undefined,
      extraArgs: extraArgs
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      env: Object.keys(env).length ? env : undefined,
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
          <h2>Edit {ex.label}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <label>
          Binary path
          <input
            value={binary}
            placeholder={ex.defaultBinary}
            onChange={(e) => setBinary(e.target.value)}
          />
        </label>

        <label>
          Extra args (one per line)
          <textarea
            rows={4}
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </label>

        <label>
          Environment (KEY=value per line)
          <textarea
            rows={4}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </label>

        {ex.docsUrl && (
          <p className="muted">
            Docs:{" "}
            <a href={ex.docsUrl} target="_blank" rel="noreferrer">
              {ex.docsUrl}
            </a>
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onReset}>Reset</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
