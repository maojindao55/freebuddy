import { Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMcpServerStore } from "@/store/mcpServerStore";
import type { UserMcpServer } from "@/services/cli/types";

import "./McpServerPicker.css";

export interface McpServerPickerProps {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
}

function McpServerCheckboxItem({
  server,
  selected,
  onChange
}: {
  server: UserMcpServer;
  selected: boolean;
  onChange: (serverId: string, checked: boolean) => void;
}) {
  const isDisabled = !server.enabled;
  const statusOk = server.lastCheckStatus === "ok";
  const statusError = server.lastCheckStatus === "error";

  return (
    <label
      className={`mcp-picker-item${isDisabled ? " disabled" : ""}`}
      title={
        isDisabled
          ? "Server is disabled"
          : server.lastCheckError ?? undefined
      }
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={isDisabled}
        onChange={(e) => onChange(server.id, e.currentTarget.checked)}
      />
      <span className="mcp-picker-item-name">{server.name}</span>
      {statusOk && (
        <span className="mcp-picker-status ok" aria-label="OK">
          ●
        </span>
      )}
      {statusError && (
        <span className="mcp-picker-status error" aria-label="Error">
          ●
        </span>
      )}
      {isDisabled && <small className="mcp-picker-disabled-label">disabled</small>}
    </label>
  );
}

export function McpServerPicker({
  selectedIds,
  onSelectionChange,
  disabled = false
}: McpServerPickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { servers, loaded, load } = useMcpServerStore();

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      rootRef.current
        ?.querySelector<HTMLButtonElement>(".mcp-picker-trigger")
        ?.focus();
    };

    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const enabledServers = useMemo(
    () => servers.filter((s) => s.enabled),
    [servers]
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const selectedCount = useMemo(() => {
    return enabledServers.filter((s) => selectedSet.has(s.id)).length;
  }, [enabledServers, selectedSet]);

  const handleToggle = (serverId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(serverId);
    } else {
      next.delete(serverId);
    }
    onSelectionChange([...next]);
  };

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="mcp-picker-root" ref={rootRef}>
      <button
        className={`mcp-picker-trigger${open ? " active" : ""}${selectedCount > 0 ? " has-selection" : ""}`}
        type="button"
        aria-label={t("mcp.pickerLabel", "MCP Servers")}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("mcp.pickerLabel", "MCP Servers")}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Server size={14} aria-hidden="true" />
        <span className="mcp-picker-label">MCP</span>
        {selectedCount > 0 && (
          <span className="mcp-picker-badge">{selectedCount}</span>
        )}
      </button>

      {open && (
        <div className="mcp-picker-popover" role="listbox" aria-label={t("mcp.selectServers", "Select MCP Servers")}>
          <div className="mcp-picker-heading">
            <strong>{t("mcp.selectForSession", "MCP Servers")}</strong>
            <span>
              {selectedCount}/{enabledServers.length}
            </span>
          </div>
          <div className="mcp-picker-list">
            {enabledServers.length === 0 && (
              <p className="mcp-picker-empty">
                {t("mcp.noServersConfigured", "No MCP servers configured")}
              </p>
            )}
            {enabledServers.map((server) => (
              <McpServerCheckboxItem
                key={server.id}
                server={server}
                selected={selectedSet.has(server.id)}
                onChange={handleToggle}
              />
            ))}
            {servers.some((s) => !s.enabled) && (
              <p className="mcp-picker-hint">
                {t("mcp.disabledServersHidden", "Disabled servers are hidden")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
