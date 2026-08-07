import { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { SkillRecord } from "@/services/skills/types";

export function partitionPickerSkills(
  skills: SkillRecord[],
  selectedIds: string[],
  query: string
): { selected: SkillRecord[]; available: SkillRecord[] } {
  const enabled = skills.filter((skill) => skill.enabled && skill.trusted);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (skill: SkillRecord) =>
    !needle ||
    `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle);
  const byId = new Map(enabled.map((skill) => [skill.id, skill]));
  const selectedSet = new Set(selectedIds);
  const selected: SkillRecord[] = [];
  for (const id of selectedIds) {
    const skill = byId.get(id);
    if (skill && matches(skill)) selected.push(skill);
  }
  const available = enabled.filter(
    (skill) => !selectedSet.has(skill.id) && matches(skill)
  );
  return { selected, available };
}

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
  const selected = new Set(selectedIds);
  const { selected: selectedSkills, available: availableSkills } =
    partitionPickerSkills(skills, selectedIds, query);
  const hasCatalog = skills.some((skill) => skill.enabled && skill.trusted);
  const hasResults = selectedSkills.length > 0 || availableSkills.length > 0;

  const renderSkill = (skill: SkillRecord) => (
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
      <span>
        <b>{skill.name}</b>
        <small>{skill.description}</small>
      </span>
    </label>
  );

  return (
    <details className="skill-picker">
      <summary
        className={`composer-tool-chip${disabled ? " disabled" : ""}`}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
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
          {!hasCatalog ? <p>{t("skills.none")}</p> : null}
          {hasCatalog && !hasResults ? <p>{t("skills.noResults")}</p> : null}
          {selectedSkills.length > 0 ? (
            <div className="skill-picker-group">
              <div className="skill-picker-group-label">
                {t("skills.selectedGroup", { count: selectedSkills.length })}
              </div>
              {selectedSkills.map(renderSkill)}
            </div>
          ) : null}
          {availableSkills.length > 0 ? (
            <div className="skill-picker-group">
              <div className="skill-picker-group-label">
                {t("skills.availableGroup", { count: availableSkills.length })}
              </div>
              {availableSkills.map(renderSkill)}
            </div>
          ) : null}
        </div>
      </div>
    </details>
  );
}
