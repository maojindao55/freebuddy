import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillSnapshot } from "@/services/skills/types";

export function MessageSkillTags({ skills, onRemove, disabled = false }: {
  skills: SkillSnapshot[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!skills.length) return null;
  return <div className={onRemove ? "composer-message-skills" : "message-skill-tags"} aria-label={t("chat.messageSkills")}>
    {skills.map(skill => <span key={skill.id} className="message-skill-tag" title={skill.description}>
      <Sparkles size={13} aria-hidden="true" />
      <span>{skill.name}</span>
      {onRemove && <button type="button" disabled={disabled} onClick={() => onRemove(skill.id)} aria-label={t("chat.removeMessageSkill", { name: skill.name })}>
        <X size={12} aria-hidden="true" />
      </button>}
    </span>)}
    {onRemove && <span className="message-skills-scope">{t("chat.skillsThisMessage")}</span>}
  </div>;
}
