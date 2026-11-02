import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useMcpServerStore } from "@/store/mcpServerStore";
import type { UserMcpServer } from "@/services/cli/types";

import "./McpServerPicker.css";

export interface McpServerChecklistProps {
  servers: UserMcpServer[];
  selectedIds: string[];
  onToggle: (serverId: string, checked: boolean) => void;
  disabled?: boolean;
}

function McpServerChecklistRow({
  server,
  selected,
  checking,
  disabled,
  onToggle
}: {
  server: UserMcpServer;
  selected: boolean;
  checking: boolean;
  disabled?: boolean;
  onToggle: (serverId: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const isDisabled = !server.enabled;
  const statusOk = server.lastCheckStatus === "ok";
  const statusError = server.lastCheckStatus === "error";
  const remoteUrl = (server.transport ?? "stdio") !== "stdio" ? server.url : undefined;

  const statusTitle = isDisabled
    ? selected
      ? t("mcp.serverDisabledWillSkip", "Server is disabled and will be skipped")
      : t("mcp.serverDisabled", "Server is disabled")
    : statusError
      ? t("mcp.lastCheckFailed", "Last check failed: {{error}}", {
          error: server.lastCheckError ?? "unknown"
        })
      : statusOk
        ? t("mcp.lastCheckOk", "Last check succeeded")
        : undefined;

  return (
    <label
      className={`mcp-picker-item${isDisabled ? " disabled" : ""}${isDisabled && selected ? " skipped" : ""}`}
      title={[server.name, remoteUrl, statusTitle].filter(Boolean).join("\n")}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={isDisabled || disabled}
        onChange={(e) => onToggle(server.id, e.currentTarget.checked)}
      />
      <span className="mcp-picker-item-name">{server.name}</span>
      {checking && (
        <Loader2
          className="mcp-picker-spinner"
          size={12}
          aria-label={t("mcp.checking", "Checking")}
        />
      )}
      {!checking && statusOk && (
        <CheckCircle2
          className="mcp-picker-status ok"
          size={12}
          aria-label={t("mcp.statusOk", "OK")}
        />
      )}
      {!checking && statusError && (
        <XCircle
          className="mcp-picker-status error"
          size={12}
          aria-label={t("mcp.statusError", "Error")}
        />
      )}
      {isDisabled && (
        <small className="mcp-picker-disabled-label">
          {selected ? t("mcp.willSkip", "skipped") : t("mcp.disabled", "disabled")}
        </small>
      )}
    </label>
  );
}

/** Enabled servers plus disabled servers that are still selected. */
export function McpServerChecklist({
  servers,
  selectedIds,
  onToggle,
  disabled = false
}: McpServerChecklistProps) {
  const checkingIds = useMcpServerStore((s) => s.checkingIds);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const checkingSet = useMemo(() => new Set(checkingIds), [checkingIds]);
  const visibleServers = useMemo(
    () => servers.filter((s) => s.enabled || selectedSet.has(s.id)),
    [servers, selectedSet]
  );

  return (
    <>
      {visibleServers.map((server) => (
        <McpServerChecklistRow
          key={server.id}
          server={server}
          selected={selectedSet.has(server.id)}
          checking={checkingSet.has(server.id)}
          disabled={disabled}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}
