import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toc, type IconToc } from "@lobehub/icons";

import { getAgentIconId } from "@/config/agentIcon";
import {
  encodeLobehubAvatar,
  lobehubAvatarUrl,
  parseLobehubAvatar
} from "@/utils/lobehubAvatar";

type IconGroup = IconToc["group"] | "all";

const GROUPS: { value: IconGroup; key: string }[] = [
  { value: "all", key: "all" },
  { value: "model", key: "models" },
  { value: "provider", key: "providers" },
  { value: "application", key: "apps" }
];

function matches(item: IconToc, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.id, item.title, item.fullTitle, item.docsUrl].some((f) =>
    f.toLowerCase().includes(q)
  );
}

interface AvatarPickerProps {
  value: string;
  onChange: (v: string) => void;
  defaultAdapter?: string;
  defaultLabel: string;
}

export function AvatarPicker({
  value,
  onChange,
  defaultAdapter,
  defaultLabel
}: AvatarPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<IconGroup>("all");
  const [expanded, setExpanded] = useState(false);

  const filtered = useMemo(
    () =>
      toc.filter((item) => {
        if (group !== "all" && item.group !== group) return false;
        return matches(item, query);
      }),
    [group, query]
  );

  const selectedId = parseLobehubAvatar(value);
  const defaultIconId = getAgentIconId(defaultAdapter);
  const selectedItem = useMemo(
    () => (selectedId ? toc.find((item) => item.id === selectedId) : undefined),
    [selectedId]
  );
  const previewIconId = selectedId || defaultIconId;
  const previewLabel =
    selectedItem?.fullTitle || selectedItem?.title || defaultLabel || t("settings.cli.useDefault");

  return (
    <div className="avatar-picker">
      <div className="avatar-picker-current">
        <button
          type="button"
          className="avatar-picker-preview"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="avatar-picker-preview-icon">
            {previewIconId ? (
              <img
                src={lobehubAvatarUrl(previewIconId)}
                alt={previewLabel}
                loading="lazy"
                className="avatar-picker-img"
              />
            ) : (
              <span className="avatar-picker-fallback">
                {defaultLabel.slice(0, 2).toUpperCase()}
              </span>
            )}
          </span>
          <span className="avatar-picker-preview-copy">
            <span className="avatar-picker-preview-title">{previewLabel}</span>
            <span className="avatar-picker-preview-subtitle">
              {value ? t("settings.cli.customAvatar") : t("settings.cli.useAgentDefault")}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="avatar-picker-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("settings.cli.collapseAvatarPicker") : t("settings.cli.changeAvatar")}
        </button>
      </div>

      {expanded && (
        <>
          <div className="avatar-picker-controls">
            <input
              className="avatar-picker-search"
              placeholder={t("settings.cli.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="avatar-picker-groups">
              {GROUPS.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  className={`avatar-picker-group${group === g.value ? " active" : ""}`}
                  onClick={() => setGroup(g.value)}
                >
                  {t(`settings.avatar.groups.${g.key}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="avatar-picker-grid">
            <button
              type="button"
              className={`avatar-picker-tile${value === "" ? " selected" : ""}`}
              title={t("settings.cli.useDefault")}
              onClick={() => onChange("")}
            >
              {defaultIconId ? (
                <img
                  src={lobehubAvatarUrl(defaultIconId)}
                  alt={t("settings.avatar.defaultAlt")}
                  loading="lazy"
                  className="avatar-picker-img"
                />
              ) : (
                <span className="avatar-picker-fallback">
                  {defaultLabel.slice(0, 2).toUpperCase()}
                </span>
              )}
            </button>
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`avatar-picker-tile${selectedId === item.id ? " selected" : ""}`}
                title={item.fullTitle || item.title}
                onClick={() => onChange(encodeLobehubAvatar(item.id))}
              >
                <img
                  src={lobehubAvatarUrl(item.id)}
                  alt={item.title}
                  loading="lazy"
                  className="avatar-picker-img"
                />
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="avatar-picker-empty">{t("settings.cli.noIcons")}</div>
            )}
          </div>
          <div className="avatar-picker-source">
            {t("settings.cli.iconsFrom")}{" "}
            <a href="https://lobehub.com/icons" target="_blank" rel="noreferrer">
              LobeHub Icons
            </a>
          </div>
        </>
      )}
    </div>
  );
}
