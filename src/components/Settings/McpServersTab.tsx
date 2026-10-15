import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { nanoid } from "nanoid";
import { useMcpServerStore } from "@/store/mcpServerStore";
import type {
  UserMcpServer,
  UserMcpServerEnvVar,
  UserMcpServerInput
} from "@/services/cli/types";
import "./McpServersTab.css";

interface EnvVarDraft {
  id: string;
  name: string;
  value: string;
  valuePreview?: string;
  secret: boolean;
}

function StatusDot({
  status,
  checking,
  lastCheckedAt,
  lastError
}: {
  status: UserMcpServer["lastCheckStatus"];
  checking: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}) {
  const { t } = useTranslation();
  if (checking) {
    return <Loader2 size={12} className="mcp-status-dot checking" />;
  }
  const timeLabel = lastCheckedAt
    ? t("mcpServers.lastCheckedAt", "Last checked: {{time}}", {
        time: new Date(lastCheckedAt).toLocaleString()
      })
    : "";
  if (status === "ok") {
    return (
      <span
        className="mcp-status-dot ok"
        title={t("mcpServers.statusOkTitle", "Latest self-check passed") + (timeLabel ? `\n${timeLabel}` : "")}
      />
    );
  }
  if (status === "error") {
    const errorDetail = lastError
      ? `\n${t("mcpServers.errorDetail", "Error: {{error}}", { error: lastError })}`
      : "";
    return (
      <span
        className="mcp-status-dot error"
        title={t("mcpServers.statusErrorTitle", "Latest self-check failed") + errorDetail + (timeLabel ? `\n${timeLabel}` : "")}
      />
    );
  }
  return (
    <span
      className="mcp-status-dot unknown"
      title={t("mcpServers.statusUnknownTitle", "Not checked yet")}
    />
  );
}

function McpServerEditor({
  server,
  onSave,
  onDelete,
  onBack,
  isNew
}: {
  server: UserMcpServer | null;
  onSave: (input: UserMcpServerInput) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onBack: () => void;
  isNew: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsText, setArgsText] = useState(
    server?.args?.join(" ") ?? ""
  );
  const [envVars, setEnvVars] = useState<EnvVarDraft[]>(() =>
    (server?.env ?? []).map((e) => ({
      id: nanoid(6),
      name: e.name,
      value: e.value ?? "",
      valuePreview: e.valuePreview,
      secret: e.secret ?? false
    }))
  );
  const [showSecrets, setShowSecrets] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selfCheck = useMcpServerStore((s) => s.selfCheck);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    status: "ok" | "error";
    error?: string;
    tools?: string[];
    stderr?: string;
  } | null>(null);

  const parseArgs = (text: string): string[] => {
    const args: string[] = [];
    let current = "";
    let inQuote = false;
    let quoteChar = "";
    for (const char of text) {
      if (inQuote) {
        if (char === quoteChar) {
          inQuote = false;
        } else {
          current += char;
        }
      } else if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === " " || char === "\t") {
        if (current) {
          args.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
    if (current) args.push(current);
    return args;
  };

  const handleAddEnvVar = () => {
    setEnvVars([...envVars, { id: nanoid(6), name: "", value: "", secret: false }]);
  };

  const handleRemoveEnvVar = (id: string) => {
    setEnvVars(envVars.filter((e) => e.id !== id));
  };

  const handleEnvVarChange = (
    id: string,
    field: "name" | "value" | "secret",
    value: string | boolean
  ) => {
    setEnvVars(
      envVars.map((e) =>
        e.id === id ? { ...e, [field]: value } : e
      )
    );
  };

  const toggleShowSecret = (id: string) => {
    setShowSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t("mcpServers.error.nameRequired"));
      return;
    }
    if (!command.trim()) {
      setError(t("mcpServers.error.commandRequired"));
      return;
    }
    if (name.trim().toLowerCase().startsWith("freebuddy")) {
      setError(t("mcpServers.error.reservedPrefix"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const env: UserMcpServerEnvVar[] = envVars
        .filter((e) => e.name.trim())
        .map((e) => ({
          name: e.name.trim(),
          ...(e.secret
            ? { value: e.value, secret: true }
            : { value: e.value })
        }));

      await onSave({
        id: server?.id,
        name: name.trim(),
        command: command.trim(),
        args: parseArgs(argsText),
        env,
        enabled: server?.enabled ?? true
      });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!server || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(server.id);
      onBack();
    } catch {
      setError("Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const handleSelfCheck = async () => {
    if (!server) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await selfCheck(server.id);
      setCheckResult(result);
    } catch {
      setCheckResult({ status: "error", error: "Self-check failed" });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mcp-editor">
      <div className="mcp-editor-header">
        <button
          type="button"
          className="mcp-editor-back"
          onClick={onBack}
        >
          <ChevronLeft size={16} />
          {t("common.back")}
        </button>
        <h3>{isNew ? t("mcpServers.new") : t("mcpServers.edit")}</h3>
      </div>

      <div className="mcp-editor-form">
        <div className="mcp-form-group">
          <label>{t("mcpServers.name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("mcpServers.namePlaceholder")}
          />
          <p className="mcp-form-hint">{t("mcpServers.nameHint")}</p>
        </div>

        <div className="mcp-form-group">
          <label>{t("mcpServers.command")}</label>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx, uvx, node, python..."
          />
          <p className="mcp-form-hint">{t("mcpServers.commandHint")}</p>
        </div>

        <div className="mcp-form-group">
          <label>{t("mcpServers.args")}</label>
          <input
            type="text"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="-y @modelcontextprotocol/server-filesystem ${cwd}"
          />
          <p className="mcp-form-hint">{t("mcpServers.argsHint")}</p>
        </div>

        <div className="mcp-form-group">
          <label>{t("mcpServers.envVars")}</label>
          <div className="mcp-env-list">
            {envVars.map((e) => (
              <div key={e.id} className="mcp-env-row">
                <input
                  type="text"
                  value={e.name}
                  onChange={(ev) =>
                    handleEnvVarChange(e.id, "name", ev.target.value)
                  }
                  placeholder={t("mcpServers.envName")}
                  className="mcp-env-name"
                />
                <div className="mcp-env-value-wrapper">
                  <input
                    type={e.secret && !showSecrets.has(e.id) ? "password" : "text"}
                    value={e.value || (e.secret && e.valuePreview ? e.valuePreview : "")}
                    onChange={(ev) =>
                      handleEnvVarChange(e.id, "value", ev.target.value)
                    }
                    placeholder={
                      e.secret && e.valuePreview
                        ? e.valuePreview
                        : t("mcpServers.envValue")
                    }
                    className="mcp-env-value"
                  />
                  {e.secret && (
                    <button
                      type="button"
                      className="mcp-env-toggle-secret"
                      onClick={() => toggleShowSecret(e.id)}
                    >
                      {showSecrets.has(e.id) ? (
                        <EyeOff size={14} />
                      ) : (
                        <Eye size={14} />
                      )}
                    </button>
                  )}
                </div>
                <label className="mcp-env-secret-label">
                  <input
                    type="checkbox"
                    checked={e.secret}
                    onChange={(ev) =>
                      handleEnvVarChange(e.id, "secret", ev.target.checked)
                    }
                  />
                  {t("mcpServers.secret")}
                </label>
                <button
                  type="button"
                  className="mcp-env-remove"
                  onClick={() => handleRemoveEnvVar(e.id)}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mcp-env-add"
              onClick={handleAddEnvVar}
            >
              <Plus size={14} />
              {t("mcpServers.addEnvVar")}
            </button>
          </div>
        </div>

        {!isNew && server && (
          <div className="mcp-form-group">
            <label>{t("mcpServers.selfCheck")}</label>
            <div className="mcp-self-check">
              <button
                type="button"
                className="mcp-self-check-btn"
                onClick={handleSelfCheck}
                disabled={checking}
              >
                {checking ? (
                  <Loader2 size={14} className="spinning" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {t("mcpServers.runSelfCheck")}
              </button>
              {checkResult && (
                <div
                  className={`mcp-self-check-result ${checkResult.status}`}
                >
                  {checkResult.status === "ok" ? (
                    <>
                      <Check size={14} />
                      <span>
                        {t("mcpServers.selfCheckOk", {
                          count: checkResult.tools?.length ?? 0
                        })}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle size={14} />
                      <span>{checkResult.error}</span>
                    </>
                  )}
                </div>
              )}
              {checkResult?.tools && checkResult.tools.length > 0 && (
                <div className="mcp-tools-list">
                  <label>{t("mcpServers.tools")}</label>
                  <ul>
                    {checkResult.tools.map((tool) => (
                      <li key={tool}>{tool}</li>
                    ))}
                  </ul>
                </div>
              )}
              {checkResult?.stderr && (
                <div className="mcp-stderr">
                  <label>{t("mcpServers.stderr")}</label>
                  <pre>{checkResult.stderr}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <div className="mcp-form-error">{error}</div>}

        <div className="mcp-form-actions">
          {!isNew && server && onDelete && (
            <button
              type="button"
              className="mcp-delete-btn"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 size={14} className="spinning" />
              ) : (
                <Trash2 size={14} />
              )}
              {t("common.delete")}
            </button>
          )}
          <div className="mcp-form-actions-right">
            <button
              type="button"
              className="mcp-cancel-btn"
              onClick={onBack}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mcp-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? (
                <Loader2 size={14} className="spinning" />
              ) : (
                <Check size={14} />
              )}
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function McpServersTab() {
  const { t } = useTranslation();
  const servers = useMcpServerStore((s) => s.servers);
  const loaded = useMcpServerStore((s) => s.loaded);
  const loading = useMcpServerStore((s) => s.loading);
  const error = useMcpServerStore((s) => s.error);
  const load = useMcpServerStore((s) => s.load);
  const refresh = useMcpServerStore((s) => s.refresh);
  const create = useMcpServerStore((s) => s.create);
  const update = useMcpServerStore((s) => s.update);
  const remove = useMcpServerStore((s) => s.remove);
  const setEnabled = useMcpServerStore((s) => s.setEnabled);
  const selfCheck = useMcpServerStore((s) => s.selfCheck);

  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const selectedServer = useMemo(() => {
    if (selectedId === "new" || !selectedId) return null;
    return servers.find((s) => s.id === selectedId) ?? null;
  }, [selectedId, servers]);

  const handleCreate = useCallback(
    async (input: UserMcpServerInput) => {
      const server = await create(input);
      setSelectedId(server.id);
    },
    [create]
  );

  const handleUpdate = useCallback(
    async (input: UserMcpServerInput) => {
      if (!input.id) return;
      await update(input.id, input);
    },
    [update]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await remove(id);
      setSelectedId(null);
    },
    [remove]
  );

  const handleSelfCheck = useCallback(
    async (id: string) => {
      setCheckingIds((prev) => new Set([...prev, id]));
      try {
        await selfCheck(id);
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [selfCheck]
  );

  const handleCheckAll = useCallback(async () => {
    for (const server of servers.filter((s) => s.enabled)) {
      await handleSelfCheck(server.id);
    }
  }, [servers, handleSelfCheck]);

  if (selectedId) {
    return (
      <McpServerEditor
        server={selectedServer}
        onSave={selectedId === "new" ? handleCreate : handleUpdate}
        onDelete={selectedId === "new" ? undefined : handleDelete}
        onBack={() => setSelectedId(null)}
        isNew={selectedId === "new"}
      />
    );
  }

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-servers-header">
        <div className="mcp-servers-title">
          <Terminal size={20} />
          <h2>{t("mcpServers.title")}</h2>
        </div>
        <p className="mcp-servers-description">
          {t("mcpServers.description")}
        </p>
      </div>

      <div className="mcp-servers-toolbar">
        <button
          type="button"
          className="mcp-add-btn"
          onClick={() => setSelectedId("new")}
        >
          <Plus size={14} />
          {t("mcpServers.add")}
        </button>
        {servers.length > 0 && (
          <button
            type="button"
            className="mcp-check-all-btn"
            onClick={handleCheckAll}
            disabled={checkingIds.size > 0}
          >
            <RefreshCw size={14} />
            {t("mcpServers.checkAll")}
          </button>
        )}
      </div>

      {loading && !loaded && (
        <div className="mcp-loading">
          <Loader2 size={20} className="spinning" />
          <span>{t("common.loading")}</span>
        </div>
      )}

      {error && (
        <div className="mcp-error">
          <AlertTriangle size={16} />
          <span>{error}</span>
          <button type="button" onClick={() => refresh()}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {loaded && servers.length === 0 && (
        <div className="mcp-empty">
          <Terminal size={40} />
          <h3>{t("mcpServers.empty")}</h3>
          <p>{t("mcpServers.emptyHint")}</p>
        </div>
      )}

      {loaded && servers.length > 0 && (
        <div className="mcp-servers-list">
          {servers.map((server) => (
            <div
              key={server.id}
              className={`mcp-server-item ${!server.enabled ? "disabled" : ""}`}
            >
              <div className="mcp-server-status">
                <StatusDot
                  status={server.lastCheckStatus}
                  checking={checkingIds.has(server.id)}
                  lastCheckedAt={server.lastCheckedAt}
                  lastError={server.lastCheckError}
                />
              </div>
              <div
                className="mcp-server-info"
                onClick={() => setSelectedId(server.id)}
              >
                <div className="mcp-server-name">{server.name}</div>
                <div className="mcp-server-command">
                  {server.command} {server.args.join(" ")}
                </div>
                {server.lastCheckTools && server.lastCheckTools.length > 0 && (
                  <div className="mcp-server-tools-count">
                    {t("mcpServers.toolCount", {
                      count: server.lastCheckTools.length
                    })}
                  </div>
                )}
              </div>
              <div className="mcp-server-actions">
                <button
                  type="button"
                  className="mcp-server-check"
                  onClick={() => handleSelfCheck(server.id)}
                  disabled={checkingIds.has(server.id)}
                  title={t("mcpServers.runSelfCheck")}
                >
                  {checkingIds.has(server.id) ? (
                    <Loader2 size={14} className="spinning" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
                <button
                  type="button"
                  className={`mcp-server-toggle ${server.enabled ? "on" : "off"}`}
                  onClick={() => setEnabled(server.id, !server.enabled)}
                  title={
                    server.enabled
                      ? t("mcpServers.disable")
                      : t("mcpServers.enable")
                  }
                >
                  <Power size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mcp-servers-note">
        <p>{t("mcpServers.note")}</p>
      </div>
    </div>
  );
}
