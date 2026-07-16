import { Sparkles } from "lucide-react";
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
  const available = skills.filter((skill) => skill.enabled && skill.trusted);
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
        {available.length ? available.map((skill) => (
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
        )) : <p>{t("skills.none")}</p>}
      </div>
    </details>
  );
}
