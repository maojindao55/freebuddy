import { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SkillRecord } from "@/services/skills/types";

export function SkillPicker({
  skills,
  selectedIds,
  onChange,
  disabled
}: {
  skills: SkillRecord[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const available = skills.filter((skill) => skill.enabled && skill.trusted);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = available.filter((skill) =>
    !needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)
  );
  const selected = new Set(selectedIds);
  return (
    <details className="skill-picker">
      <summary className={`composer-tool-chip${disabled ? " disabled" : ""}`} onClick={(event) => {
        if (disabled) event.preventDefault();
      }}>
        <Sparkles size={14} />
        {t("skills.picker", { count: selectedIds.length })}
      </summary>
      <div className="skill-picker-menu">
        <strong>{t("skills.activeForTask")}</strong>
        <label className="skill-picker-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("skills.search")}
            aria-label={t("skills.search")}
          />
        </label>
        <div className="skill-picker-list">
          {!available.length ? <p>{t("skills.none")}</p> : null}
          {available.length && !filtered.length ? <p>{t("skills.noResults")}</p> : null}
          {filtered.map((skill) => (
            <label key={skill.id}>
              <input
                type="checkbox"
                checked={selected.has(skill.id)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.currentTarget.checked) next.add(skill.id);
                  else next.delete(skill.id);
                  onChange([...next]);
                }}
              />
              <span><b>{skill.name}</b><small>{skill.description}</small></span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
