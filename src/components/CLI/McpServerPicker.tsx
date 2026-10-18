import { Server, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMcpServerStore } from "@/store/mcpServerStore";

import { McpServerChecklist } from "./McpServerChecklist";
import "./McpServerPicker.css";

export interface McpServerPickerProps {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
  cwd?: string;
  onOpenSettings?: () => void;
}

export function McpServerPicker({
  selectedIds,
  onSelectionChange,
  disabled = false,
  cwd,
  onOpenSettings
}: McpServerPickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const servers = useMcpServerStore((s) => s.servers);
  const loaded = useMcpServerStore((s) => s.loaded);
  const load = useMcpServerStore((s) => s.load);
  const checkingIds = useMcpServerStore((s) => s.checkingIds);
  const selfCheck = useMcpServerStore((s) => s.selfCheck);

  useEffect(() => {
    if (!loaded) {
      void load();
    }
  }, [loaded, load]);

  useEffect(() => {
    if (!open) return;

    rootRef.current
      ?.querySelector<HTMLInputElement>(
        '.mcp-picker-popover input[type="checkbox"]'
      )
      ?.focus();

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

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const checkingSet = useMemo(() => new Set(checkingIds), [checkingIds]);

  const enabledServers = useMemo(
    () => servers.filter((s) => s.enabled),
    [servers]
  );

  // Count only enabled servers that are selected (disabled ones are skipped at runtime)
  const selectedCount = useMemo(() => {
    return enabledServers.filter((s) => selectedSet.has(s.id)).length;
  }, [enabledServers, selectedSet]);

  // Count disabled-but-selected servers for the warning
  const disabledSelectedCount = useMemo(() => {
    return servers.filter((s) => !s.enabled && selectedSet.has(s.id)).length;
  }, [servers, selectedSet]);

  const visibleCount = useMemo(
    () => servers.filter((s) => s.enabled || selectedSet.has(s.id)).length,
    [servers, selectedSet]
  );
  const handleToggle = (serverId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(serverId);
    } else {
      next.delete(serverId);
    }
    onSelectionChange([...next]);
    if (!checked || !cwd?.trim()) return;
    const server = servers.find((entry) => entry.id === serverId);
    if (!server?.enabled || checkingSet.has(serverId)) return;
    if (server.lastCheckedAt) {
      const lastChecked = new Date(server.lastCheckedAt).getTime();
      if (lastChecked > Date.now() - 5 * 60 * 1000) return;
    }
    void selfCheck(serverId, cwd);
  };

  if (loaded && servers.length === 0) {
    return (
      <button
        className="mcp-picker-trigger"
        type="button"
        disabled={disabled}
        onClick={onOpenSettings}
        title={t("mcp.openSettings", "Configure MCP servers")}
      >
        <Server size={14} aria-hidden="true" />
        <span className="mcp-picker-label">{t("mcp.configure", "MCP")}</span>
      </button>
    );
  }

  if (servers.length === 0) {
    return null;
  }

  return (
    <div className="mcp-picker-root" ref={rootRef}>
      <button
        className={`mcp-picker-trigger${open ? " active" : ""}${selectedCount > 0 ? " has-selection" : ""}`}
        type="button"
        aria-label={t("mcp.pickerLabel", "MCP Servers")}
        aria-haspopup="dialog"
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
        <div
          className="mcp-picker-popover"
          role="dialog"
          aria-label={t("mcp.selectServers", "Select MCP Servers")}
        >
          <div className="mcp-picker-heading">
            <strong>{t("mcp.selectForSession", "MCP Servers")}</strong>
            <span>
              {selectedCount}/{enabledServers.length}
            </span>
          </div>
          <div className="mcp-picker-list">
            {visibleCount === 0 && (
              <p className="mcp-picker-empty">
                {servers.length === 0
                  ? t("mcp.noServersConfigured", "No MCP servers configured")
                  : t("mcp.allServersDisabled", "All MCP servers are disabled")}
              </p>
            )}
            <McpServerChecklist
              servers={servers}
              selectedIds={selectedIds}
              onToggle={handleToggle}
            />
            {disabledSelectedCount > 0 && (
              <p className="mcp-picker-hint mcp-picker-warning">
                {t("mcp.disabledServersSkipped", "{{count}} disabled server(s) will be skipped", { count: disabledSelectedCount })}
              </p>
            )}
          </div>
          {onOpenSettings && (
            <div className="mcp-picker-footer">
              <button
                type="button"
                className="mcp-picker-manage"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <Settings2 size={12} aria-hidden="true" />
                {t("mcp.manageServers", "Manage MCP servers…")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
