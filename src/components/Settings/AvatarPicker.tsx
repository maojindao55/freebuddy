import { useMemo, useState } from "react";
import { toc, type IconToc } from "@lobehub/icons";

import { getAgentIconId } from "@/config/agentIcon";
import {
  encodeLobehubAvatar,
  lobehubAvatarUrl,
  parseLobehubAvatar
} from "@/utils/lobehubAvatar";

type IconGroup = IconToc["group"] | "all";

const GROUPS: { value: IconGroup; label: string }[] = [
  { value: "all", label: "All" },
  { value: "model", label: "Models" },
  { value: "provider", label: "Providers" },
  { value: "application", label: "Apps" }
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
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<IconGroup>("all");

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

  return (
    <div className="avatar-picker">
      <div className="avatar-picker-controls">
        <input
          className="avatar-picker-search"
          placeholder="Search icons (DeepSeek, Qwen, Cursor…)"
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
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="avatar-picker-grid">
        <button
          type="button"
          className={`avatar-picker-tile${value === "" ? " selected" : ""}`}
          title="Use default"
          onClick={() => onChange("")}
        >
          {defaultIconId ? (
            <img
              src={lobehubAvatarUrl(defaultIconId)}
              alt="Default"
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
          <div className="avatar-picker-empty">No matching icons.</div>
        )}
      </div>
      <div className="avatar-picker-source">
        Icons from{" "}
        <a href="https://lobehub.com/icons" target="_blank" rel="noreferrer">
          LobeHub Icons
        </a>
      </div>
    </div>
  );
}
