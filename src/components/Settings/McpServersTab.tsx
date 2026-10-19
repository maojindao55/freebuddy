import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Server,
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

const MCP_SERVER_TEMPLATES: Array<{
  name: string;
  command: string;
  args: string[];
}> = [
  {
    name: "everything",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"]
  },
  {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "${cwd}"]
  },
  {
    name: "memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"]
  },
  { name: "time", command: "uvx", args: ["mcp-server-time"] },
  { name: "fetch", command: "uvx", args: ["mcp-server-fetch"] }
];

interface EnvVarDraft {
  id: string;
  originalName?: string;
  name: string;
  value: string;
  valuePreview?: string;
  hasStoredSecret: boolean;
  secret: boolean;
}

type McpTransport = NonNullable<UserMcpServerInput["transport"]>;

function createValueDrafts(values: UserMcpServerEnvVar[] = []): EnvVarDraft[] {
  return values.map((entry) => ({
    id: nanoid(6),
    originalName: entry.name,
    name: entry.name,
    value: entry.secret ? "" : (entry.value ?? ""),
    valuePreview: entry.valuePreview,
    hasStoredSecret: entry.secret === true && Boolean(entry.hasValue),
    secret: entry.secret ?? false
  }));
}

function valueDraftsChanged(drafts: EnvVarDraft[], original: UserMcpServerEnvVar[] = []): boolean {
  const values = drafts.filter((entry) => entry.name.trim() || entry.value);
  if (values.length !== original.length) return true;
  return values.some((draft, index) => {
    const entry = original[index];
    if (draft.name.trim() !== entry.name || draft.secret !== (entry.secret ?? false)) return true;
    if (!draft.secret) return draft.value !== (entry.value ?? "");
    return draft.value !== "" || (!draft.hasStoredSecret && Boolean(entry.hasValue));
  });
}

function serializeValueDrafts(drafts: EnvVarDraft[]): UserMcpServerEnvVar[] {
  return drafts.filter((entry) => entry.name.trim()).map((entry) => {
    const name = entry.name.trim();
    if (!entry.secret) return { name, value: entry.value };
    if (entry.value) return { name, value: entry.value, secret: true };
    if (entry.hasStoredSecret && entry.originalName) {
      return { name, secret: true, previousName: entry.originalName };
    }
    return { name, value: "", secret: true };
  });
}

function McpValuesEditor({
  kind,
  values,
  onChange,
  disabled
}: {
  kind: "env" | "headers";
  values: EnvVarDraft[];
  onChange: (values: EnvVarDraft[]) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [showSecrets, setShowSecrets] = useState<Set<string>>(new Set());
  const isHeaders = kind === "headers";
  const nameLabel = t(isHeaders ? "mcpServers.headerName" : "mcpServers.envName");
  const valueLabel = t(isHeaders ? "mcpServers.headerValue" : "mcpServers.envValue");

  const update = (id: string, field: "name" | "value" | "secret", value: string | boolean) => {
    onChange(values.map((entry) => {
      if (entry.id !== id) return entry;
      if (field === "value") return { ...entry, value: value as string };
      if (field === "secret") return { ...entry, secret: value as boolean, hasStoredSecret: Boolean(value) && entry.hasStoredSecret };
      return { ...entry, name: value as string };
    }));
  };

  return (
    <div className="mcp-editor-section">
      <div className="mcp-section-title">{t(isHeaders ? "mcpServers.headers" : "mcpServers.envVars")}</div>
      <div className="mcp-env-list">
        {values.length === 0 && <p className="mcp-env-empty muted">{t(isHeaders ? "mcpServers.headersEmpty" : "mcpServers.envEmpty")}</p>}
        {isHeaders && <p className="mcp-form-hint">{t("mcpServers.headersHint")}</p>}
        <div className={`mcp-env-grid${isHeaders ? " mcp-headers-grid" : ""}`}>
          {values.length > 0 && (
            <div className="mcp-env-header">
              <span className="muted">{nameLabel}</span>
              <span className="muted">{valueLabel}</span>
              {!isHeaders && <span />}<span />
            </div>
          )}
          {values.map((entry) => (
            <div key={entry.id} className="mcp-env-row">
              <input type="text" value={entry.name} disabled={disabled}
                onChange={(event) => update(entry.id, "name", event.target.value)}
                placeholder={nameLabel} className="mcp-env-name" aria-label={nameLabel} title={entry.name}
                autoComplete="off" spellCheck={false} />
              <div className="mcp-env-value-wrapper">
                <input type={entry.secret && !showSecrets.has(entry.id) ? "password" : "text"}
                  value={entry.value} disabled={disabled}
                  onChange={(event) => update(entry.id, "value", event.target.value)}
                  placeholder={entry.secret && entry.hasStoredSecret
                    ? `${entry.valuePreview ?? "••••••••"} ${t("mcpServers.storedSecret")}` : valueLabel}
                  className="mcp-env-value" aria-label={valueLabel} autoComplete="off" spellCheck={false} />
                {entry.secret && (
                  <>
                    {(!isHeaders || !entry.hasStoredSecret || entry.value !== "") && <button type="button" className="mcp-env-toggle-secret" disabled={disabled}
                      onClick={() => setShowSecrets((previous) => {
                        const next = new Set(previous);
                        if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
                        return next;
                      })}
                      aria-label={t(showSecrets.has(entry.id) ? "mcpServers.hideSecret" : "mcpServers.showSecret")}
                      title={t(showSecrets.has(entry.id) ? "mcpServers.hideSecret" : "mcpServers.showSecret")}>
                      {showSecrets.has(entry.id) ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>}
                    {isHeaders && entry.hasStoredSecret && !entry.value && (
                      <button type="button" className="mcp-env-clear-secret" disabled={disabled}
                        onClick={() => onChange(values.map((value) => value.id === entry.id
                          ? { ...value, value: "", hasStoredSecret: false, valuePreview: undefined } : value))}
                        aria-label={t("mcpServers.clearSecret")} title={t("mcpServers.clearSecret")}>
                        <X size={14} />
                      </button>
                    )}
                  </>
                )}
              </div>
              {!isHeaders && <label className="mcp-env-secret-label">
                <input type="checkbox" checked={entry.secret} disabled={disabled}
                  onChange={(event) => update(entry.id, "secret", event.target.checked)} />
                {t("mcpServers.secret")}
              </label>}
              <button type="button" className="mcp-env-remove" disabled={disabled}
                onClick={() => onChange(values.filter((value) => value.id !== entry.id))}
                aria-label={t(isHeaders ? "mcpServers.removeHeader" : "mcpServers.removeEnvVar")}
                title={t(isHeaders ? "mcpServers.removeHeader" : "mcpServers.removeEnvVar")}><X size={14} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="mcp-env-add" disabled={disabled}
          onClick={() => onChange([...values, { id: nanoid(6), name: "", value: "", hasStoredSecret: false, secret: isHeaders }])}>
          <Plus size={14} />{t(isHeaders ? "mcpServers.addHeader" : "mcpServers.addEnvVar")}
        </button>
      </div>
    </div>
  );
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
    return (
      <Loader2
        size={10}
        className="mcp-status-dot checking"
        aria-label={t("mcp.checking", "Checking")}
      />
    );
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
        role="img"
        aria-label={t("mcpServers.statusOkTitle", "Latest self-check passed")}
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
        role="img"
        aria-label={t("mcpServers.statusErrorTitle", "Latest self-check failed")}
        title={t("mcpServers.statusErrorTitle", "Latest self-check failed") + errorDetail + (timeLabel ? `\n${timeLabel}` : "")}
      />
    );
  }
  return (
    <span
      className="mcp-status-dot unknown"
      role="img"
      aria-label={t("mcpServers.statusUnknownTitle", "Not checked yet")}
      title={t("mcpServers.statusUnknownTitle", "Not checked yet")}
    />
  );
}

function McpServerEditor({
  server,
  onSave,
  onDelete,
  onBack,
  isNew,
  autoSelfCheck,
  onAutoSelfCheckDone
}: {
  server: UserMcpServer | null;
  onSave: (input: UserMcpServerInput) => Promise<UserMcpServer | undefined>;
  onDelete?: (id: string) => Promise<void>;
  onBack: () => void;
  isNew: boolean;
  autoSelfCheck?: boolean;
  onAutoSelfCheckDone?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(server?.name ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [argsLines, setArgsLines] = useState(
    server?.args?.join("\n") ?? ""
  );
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "stdio");
  const [url, setUrl] = useState(server?.url ?? "");
  const [envVars, setEnvVars] = useState<EnvVarDraft[]>(() => createValueDrafts(server?.env));
  const [headers, setHeaders] = useState<EnvVarDraft[]>(() => createValueDrafts(server?.headers));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ackLocalExec, setAckLocalExec] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commandChanged = command.trim() !== (server?.command ?? "").trim();
  const needsLocalExecAck = transport === "stdio" && (isNew || commandChanged || (server?.transport ?? "stdio") !== "stdio");

  const selfCheck = useMcpServerStore((s) => s.selfCheck);
  const checkingIds = useMcpServerStore((s) => s.checkingIds);
  const checking = server ? checkingIds.includes(server.id) : false;
  const [checkResult, setCheckResult] = useState<{
    status: "ok" | "error";
    code?: string;
    error?: string;
    tools?: string[];
    stderr?: string;
  } | null>(null);
  const formId = useId();
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmDeleteTimer.current) {
        clearTimeout(confirmDeleteTimer.current);
      }
    };
  }, []);

  const parseArgsFromLines = (text: string): string[] => {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const dirty = useMemo(() => {
    if (isNew || !server) {
      return name.trim() !== "" || transport !== "stdio" || url.trim() !== "" ||
        command.trim() !== "" || argsLines.trim() !== "" ||
        valueDraftsChanged(envVars) || valueDraftsChanged(headers);
    }
    if (name.trim() !== server.name || transport !== (server.transport ?? "stdio")) return true;
    if (transport === "stdio") {
      return command.trim() !== server.command ||
        parseArgsFromLines(argsLines).join("\n") !== server.args.join("\n") ||
        valueDraftsChanged(envVars, server.env);
    }
    return url.trim() !== (server.url ?? "") || valueDraftsChanged(headers, server.headers);
  }, [isNew, server, name, transport, url, command, argsLines, envVars, headers]);

  useEffect(() => {
    setCheckResult(null);
    setError(null);
  }, [name, transport, url, command, argsLines, envVars, headers]);

  const mapSaveError = (err: unknown): string => {
    const raw = err instanceof Error ? err.message : "";
    const code = raw.match(/\[mcp:([a-z_]+)\]/)?.[1];
    if (code) {
      const key = `mcpServers.error.${code}`;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    const stripped = raw
      .replace(/^Error invoking remote method '[^']*':\s*/, "")
      .replace(/\[mcp:[a-z_]+\]\s*/, "");
    return stripped || t("mcpServers.error.saveFailed");
  };

  const handleBack = () => {
    if (dirty && !window.confirm(t("mcpServers.discardChanges"))) return;
    onBack();
  };

  const resetDrafts = (saved: UserMcpServer) => {
    setName(saved.name);
    setCommand(saved.command);
    setArgsLines(saved.args.join("\n"));
    setTransport(saved.transport ?? "stdio");
    setUrl(saved.url ?? "");
    setEnvVars(createValueDrafts(saved.env));
    setHeaders(createValueDrafts(saved.headers));
    setAckLocalExec(false);
  };

  const handleSave = async (): Promise<UserMcpServer | undefined> => {
    if (!name.trim()) {
      setError(t("mcpServers.error.nameRequired"));
      return undefined;
    }
    if (transport === "stdio" && !command.trim()) {
      setError(t("mcpServers.error.commandRequired"));
      return undefined;
    }
    if (transport !== "stdio") {
      if (!url.trim()) {
        setError(t("mcpServers.error.url_required"));
        return undefined;
      }
      try {
        const parsed = new URL(url.trim());
        if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error();
      } catch {
        setError(t("mcpServers.error.invalid_url"));
        return undefined;
      }
      const names = new Set<string>();
      for (const header of headers) {
        const name = header.name.trim();
        if (!name && !header.value && !header.hasStoredSecret) continue;
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
          setError(t("mcpServers.error.invalid_header_name"));
          return undefined;
        }
        if (names.has(name.toLowerCase())) {
          setError(t("mcpServers.error.duplicate_header"));
          return undefined;
        }
        names.add(name.toLowerCase());
        if (/[\r\n\0]/.test(header.value)) {
          setError(t("mcpServers.error.invalid_header_value"));
          return undefined;
        }
      }
    }
    if (needsLocalExecAck && !ackLocalExec) {
      setError(t("mcpServers.error.confirmLocalExec"));
      return undefined;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await onSave({
        id: server?.id,
        name: name.trim(),
        transport,
        ...(transport === "stdio" ? {
          command: command.trim(),
          args: parseArgsFromLines(argsLines),
          env: serializeValueDrafts(envVars)
        } : {
          url: url.trim(),
          headers: serializeValueDrafts(headers)
        }),
        enabled: server?.enabled ?? true
      });
      return saved;
    } catch (err) {
      setError(mapSaveError(err));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!server || !onDelete) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      if (confirmDeleteTimer.current) {
        clearTimeout(confirmDeleteTimer.current);
      }
      confirmDeleteTimer.current = setTimeout(() => {
        setConfirmDelete(false);
        confirmDeleteTimer.current = null;
      }, 4000);
      return;
    }
    setDeleting(true);
    try {
      await onDelete(server.id);
      onBack();
    } catch {
      setError(t("mcpServers.error.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const runSelfCheck = async () => {
    if (!server) return;
    setCheckResult(null);
    const result = await selfCheck(server.id);
    setCheckResult(result);
  };

  const handleSelfCheck = async () => {
    if (!server) return;
    if (dirty) {
      const saved = await handleSave();
      if (!saved) return;
      resetDrafts(saved);
    }
    await runSelfCheck();
  };

  const autoCheckFired = useRef(false);
  useEffect(() => {
    if (autoCheckFired.current) return;
    if (!autoSelfCheck || !server) return;
    autoCheckFired.current = true;
    onAutoSelfCheckDone?.();
    if ((server.transport ?? "stdio") === "stdio" && server.args.some((arg) => arg.includes("${cwd}"))) return;
    void runSelfCheck();
  }, []);

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-editor-header">
        <button
          type="button"
          className="mcp-icon-btn"
          onClick={handleBack}
          disabled={saving || deleting}
        >
          <ChevronLeft size={16} />
          {t("common.back")}
        </button>
        <h3>
          {isNew ? t("mcpServers.new") : t("mcpServers.edit")}
          {server && <span className="muted"> {server.name}</span>}
        </h3>
      </div>

      {isNew && (
        <div className="mcp-templates">
          <span className="mcp-templates-label">
            {t("mcpServers.templates", "Quick fill")}
          </span>
          {MCP_SERVER_TEMPLATES.map((template) => (
            <button
              key={template.name}
              type="button"
              className="mcp-template-chip"
              disabled={saving}
              title={`${template.command} ${template.args.join(" ")}`}
              onClick={() => {
                setTransport("stdio");
                setAckLocalExec(false);
                setName(template.name);
                setCommand(template.command);
                setArgsLines(template.args.join("\n"));
              }}
            >
              {template.name}
            </button>
          ))}
        </div>
      )}

      <div className="mcp-editor-section">
        <div className="mcp-section-title">
          {t("mcpServers.sectionBasic", "Basic info")}
        </div>
        <div className="mcp-form-grid">
          <div className="mcp-form-group">
            <label htmlFor={`${formId}-name`}>{t("mcpServers.name")}</label>
            <input
              id={`${formId}-name`}
              type="text"
              value={name}
              disabled={saving || checking || deleting}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("mcpServers.namePlaceholder")}
            />
            <p className="mcp-form-hint">{t("mcpServers.nameHint")}</p>
          </div>

          <div className="mcp-form-group">
            <label htmlFor={`${formId}-transport`}>{t("mcpServers.transport")}</label>
            <select id={`${formId}-transport`} value={transport} disabled={saving || checking || deleting}
              onChange={(event) => {
                setTransport(event.target.value as McpTransport);
                setAckLocalExec(false);
              }}>
              <option value="stdio">{t("mcpServers.transportStdio")}</option>
              <option value="http">{t("mcpServers.transportHttp")}</option>
              <option value="sse">{t("mcpServers.transportSse")}</option>
            </select>
            <p className="mcp-form-hint">{t(transport === "sse" ? "mcpServers.sseHint" : "mcpServers.transportHint")}</p>
          </div>

          {transport === "stdio" ? <>
          <div className="mcp-form-group mcp-form-span">
            <label htmlFor={`${formId}-command`}>{t("mcpServers.command")}</label>
            <input
              id={`${formId}-command`}
              type="text"
              value={command}
              disabled={saving || checking || deleting}
              onChange={(e) => {
                setCommand(e.target.value);
                setAckLocalExec(false);
              }}
              placeholder="npx, uvx, node, python..."
            />
            <p className="mcp-form-hint">{t("mcpServers.commandHint")}</p>
          </div>

          <div className="mcp-form-group mcp-form-span">
            <label htmlFor={`${formId}-args`}>{t("mcpServers.args")}</label>
            <textarea
              id={`${formId}-args`}
              value={argsLines}
              disabled={saving || checking || deleting}
              onChange={(e) => setArgsLines(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n${cwd}"}
              rows={Math.min(
                10,
                Math.max(3, argsLines.split("\n").length + 1)
              )}
            />
            <p className="mcp-form-hint">{t("mcpServers.argsHintPerLine", "One argument per line. Use ${cwd} for workspace path.")}</p>
          </div>
          </> : <div className="mcp-form-group mcp-form-span">
            <label htmlFor={`${formId}-url`}>{t("mcpServers.url")}</label>
            <input id={`${formId}-url`} type="text" value={url} disabled={saving || checking || deleting}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={transport === "sse" ? "https://example.com/sse" : "https://example.com/mcp"}
              autoComplete="off" spellCheck={false} />
            <p className="mcp-form-hint">{t("mcpServers.urlHint")}</p>
          </div>}
        </div>
      </div>

      <McpValuesEditor key={transport === "stdio" ? "env" : "headers"}
        kind={transport === "stdio" ? "env" : "headers"}
        values={transport === "stdio" ? envVars : headers}
        onChange={transport === "stdio" ? setEnvVars : setHeaders}
        disabled={saving || checking || deleting} />

      {!isNew && server && (
        <div className="mcp-editor-section">
          <div className="mcp-section-title">{t("mcpServers.selfCheck")}</div>
          <div className="mcp-self-check">
            <button
              type="button"
              className="secondary"
              onClick={handleSelfCheck}
              disabled={checking || saving || deleting}
            >
              {checking ? (
                <Loader2 size={14} className="spinning" />
              ) : (
                <RefreshCw size={14} />
              )}
              {dirty
                ? t("mcpServers.saveAndCheck", "Save & check")
                : t("mcpServers.runSelfCheck")}
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
                    <span>
                      {checkResult.code === "cwd_required"
                        ? t("mcpServers.error.cwdRequired")
                        : checkResult.error}
                    </span>
                  </>
                )}
              </div>
            )}
            {checkResult?.tools && checkResult.tools.length > 0 && (
              <div className="mcp-tools-chips">
                {checkResult.tools.map((tool) => (
                  <span key={tool} className="mcp-tool-chip">
                    {tool}
                  </span>
                ))}
              </div>
            )}
            {checkResult?.stderr && (
              <details className="mcp-stderr">
                <summary>{t("mcpServers.stderr")}</summary>
                <pre>{checkResult.stderr}</pre>
              </details>
            )}
          </div>
        </div>
      )}

      {error && <div className="mcp-form-error" role="alert">{error}</div>}

      <div className="mcp-editor-footer">
        {!isNew && server && onDelete ? (
          <button
            type="button"
            className="secondary mcp-danger"
            onClick={handleDelete}
            disabled={deleting || saving || checking}
          >
            {deleting ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <Trash2 size={14} />
            )}
            {confirmDelete ? t("mcpServers.confirmDelete") : t("common.delete")}
          </button>
        ) : (
          <span />
        )}
        <div className="mcp-form-actions-right">
          {needsLocalExecAck && (
            <label className="mcp-local-exec-ack">
              <input
                type="checkbox"
                checked={ackLocalExec}
                disabled={saving || checking || deleting}
                onChange={(event) => setAckLocalExec(event.target.checked)}
              />
              {t("mcpServers.confirmLocalExec")}
            </label>
          )}
          <button
            type="button"
            className="secondary"
            onClick={handleBack}
            disabled={saving || deleting}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={async () => {
              const saved = await handleSave();
              if (saved && !isNew) onBack();
            }}
            disabled={saving || checking || deleting || (needsLocalExecAck && !ackLocalExec)}
            title={
              needsLocalExecAck && !ackLocalExec
                ? t("mcpServers.error.confirmLocalExec")
                : undefined
            }
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
  );
}

export function McpServersTab() {
  const { t } = useTranslation();
  const servers = useMcpServerStore((s) => s.servers);
  const secretStorageEncrypted = useMcpServerStore((s) => s.secretStorageEncrypted);
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
  const checkingIds = useMcpServerStore((s) => s.checkingIds);

  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [autoCheckId, setAutoCheckId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const checkingSet = useMemo(() => new Set(checkingIds), [checkingIds]);

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
      setAutoCheckId(server.id);
      setSelectedId(server.id);
      return server;
    },
    [create]
  );

  const handleUpdate = useCallback(
    async (input: UserMcpServerInput) => {
      if (!input.id) return undefined;
      return update(input.id, input);
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

  const handleCheckAll = useCallback(async () => {
    const queue = servers.filter((s) => s.enabled);
    const worker = async () => {
      let next = queue.shift();
      while (next) {
        await selfCheck(next.id);
        next = queue.shift();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(3, queue.length) }, worker)
    );
  }, [servers, selfCheck]);

  const handleToggleEnabled = useCallback(
    async (server: UserMcpServer, enabled: boolean) => {
      try {
        const ok = await setEnabled(server.id, enabled);
        setListError(ok ? null : t("mcpServers.error.toggleFailed"));
      } catch {
        setListError(t("mcpServers.error.toggleFailed"));
      }
    },
    [setEnabled, t]
  );

  if (selectedId) {
    return (
      <McpServerEditor
        key={selectedId}
        server={selectedServer}
        onSave={selectedId === "new" ? handleCreate : handleUpdate}
        onDelete={selectedId === "new" ? undefined : handleDelete}
        onBack={() => setSelectedId(null)}
        isNew={selectedId === "new"}
        autoSelfCheck={autoCheckId === selectedId}
        onAutoSelfCheckDone={() => setAutoCheckId(null)}
      />
    );
  }

  return (
    <div className="mcp-servers-tab">
      <div className="mcp-servers-heading">
        <div className="mcp-servers-heading-text">
          <h3>{t("mcpServers.title")}</h3>
          <p className="muted">{t("mcpServers.description")}</p>
        </div>
        <div className="plugins-heading-actions">
          {servers.length > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={handleCheckAll}
              disabled={checkingSet.size > 0}
            >
              <RefreshCw size={14} />
              {t("mcpServers.checkAll")}
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => setSelectedId("new")}
          >
            <Plus size={14} />
            {t("mcpServers.add")}
          </button>
        </div>
      </div>

      <p className="mcp-note muted">
        <Info size={14} aria-hidden="true" />
        {t("mcpServers.note")}
      </p>

      {loaded && !secretStorageEncrypted && (
        <div className="mcp-storage-warning" role="status">
          <AlertTriangle size={16} />
          <span>{t("mcpServers.secretStorageWarning")}</span>
        </div>
      )}

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

      {listError && (
        <div className="mcp-error">
          <AlertTriangle size={16} />
          <span>{listError}</span>
          <button type="button" onClick={() => setListError(null)}>
            {t("common.dismiss", "Dismiss")}
          </button>
        </div>
      )}

      {loaded && servers.length === 0 && (
        <div className="mcp-empty">
          <span className="mcp-empty-icon">
            <Server size={32} />
          </span>
          <h3>{t("mcpServers.empty")}</h3>
          <p className="muted">{t("mcpServers.emptyHint")}</p>
          <button
            type="button"
            className="primary"
            onClick={() => setSelectedId("new")}
          >
            <Plus size={14} />
            {t("mcpServers.add")}
          </button>
        </div>
      )}

      {loaded && servers.length > 0 && (
        <div className="mcp-servers-list">
          {servers.map((server) => {
            const statusPill = !server.enabled
              ? { cls: "disabled", text: t("mcp.disabled") }
              : server.lastCheckStatus === "ok"
                ? {
                    cls: "ok",
                    text: t("mcpServers.toolCount", {
                      count: server.lastCheckTools?.length ?? 0
                    })
                  }
                : server.lastCheckStatus === "error"
                  ? {
                      cls: "error",
                      text: t("mcpServers.statusFailed", "Check failed")
                    }
                  : {
                      cls: "unknown",
                      text: t("mcpServers.statusUnknown", "Not checked")
                    };
            const commandLine = (server.transport ?? "stdio") === "stdio"
              ? `${server.command} ${server.args.join(" ")}`.trim()
              : server.url ?? "";
            return (
              <div
                key={server.id}
                className={`mcp-server-card${!server.enabled ? " disabled" : ""}`}
              >
                <div className="mcp-server-icon">
                  <Server size={16} aria-hidden="true" />
                  <StatusDot
                    status={server.lastCheckStatus}
                    checking={checkingSet.has(server.id)}
                    lastCheckedAt={server.lastCheckedAt}
                    lastError={server.lastCheckError}
                  />
                </div>
                <button
                  type="button"
                  className="mcp-server-info"
                  onClick={() => setSelectedId(server.id)}
                >
                  <div className="mcp-server-row1">
                    <strong>{server.name}</strong>
                    <span className={`mcp-status-pill ${statusPill.cls}`}>
                      {statusPill.text}
                    </span>
                  </div>
                  <div className="mcp-server-command" title={commandLine}>
                    {commandLine}
                  </div>
                  {server.lastCheckStatus === "error" &&
                    server.lastCheckError && (
                      <div
                        className="mcp-server-last-error"
                        title={server.lastCheckError}
                      >
                        {server.lastCheckError}
                      </div>
                    )}
                </button>
                <div className="mcp-server-actions">
                  <button
                    type="button"
                    className="mcp-icon-btn"
                    onClick={() => void selfCheck(server.id)}
                    disabled={checkingSet.has(server.id)}
                    title={t("mcpServers.runSelfCheck")}
                    aria-label={t("mcpServers.runSelfCheck")}
                  >
                    {checkingSet.has(server.id) ? (
                      <Loader2 size={14} className="spinning" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </button>
                  <label
                    className="skills-switch"
                    title={
                      server.enabled
                        ? t("mcpServers.disable")
                        : t("mcpServers.enable")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      aria-label={
                        server.enabled
                          ? t("mcpServers.disable")
                          : t("mcpServers.enable")
                      }
                      onChange={(event) =>
                        void handleToggleEnabled(
                          server,
                          event.currentTarget.checked
                        )
                      }
                    />
                    <span aria-hidden="true" />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
