import { ChevronRight, Plus, Sparkles, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SkillRecord } from "@/services/skills/types";

export function ComposerAddMenu({
  skills,
  selectedIds,
  onSkillsChange,
  onSelectAttachments,
  attachmentDisabled = false,
  skillsDisabled = false
}: {
  skills: SkillRecord[];
  selectedIds: string[];
  onSkillsChange: (ids: string[]) => void;
  onSelectAttachments: () => void;
  attachmentDisabled?: boolean;
  skillsDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const available = useMemo(
    () => skills.filter((skill) => skill.enabled && skill.trusted),
    [skills]
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedAvailableCount = available.reduce(
    (count, skill) => count + (selected.has(skill.id) ? 1 : 0),
    0
  );
  const disabled = attachmentDisabled && skillsDisabled;

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSkillsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setSkillsOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".composer-add-trigger")?.focus();
    };

    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setSkillsOpen(false);
  }, [disabled]);

  const toggleSkill = (skillId: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(skillId);
    else next.delete(skillId);
    onSkillsChange([...next]);
  };

  return (
    <div className="composer-add-menu-root" ref={rootRef}>
      <button
        className={`composer-add-trigger${open ? " active" : ""}`}
        type="button"
        aria-label={t("chat.addTools")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chat.addTools")}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => {
            if (current) setSkillsOpen(false);
            return !current;
          });
        }}
      >
        <Plus aria-hidden="true" />
      </button>

      {open ? (
        <div className="composer-add-popover">
          <div className="composer-add-primary" role="menu" aria-label={t("chat.addMenuAria")}>
            <button
              className="composer-add-menu-item"
              type="button"
              role="menuitem"
              disabled={attachmentDisabled}
              onClick={() => {
                setOpen(false);
                setSkillsOpen(false);
                onSelectAttachments();
              }}
            >
              <UploadCloud className="composer-add-menu-icon" aria-hidden="true" />
              <span>{t("chat.addFile")}</span>
            </button>
            <button
              className={`composer-add-menu-item composer-add-skills-item${skillsOpen ? " active" : ""}`}
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={skillsOpen}
              disabled={skillsDisabled}
              onMouseEnter={() => setSkillsOpen(true)}
              onFocus={() => setSkillsOpen(true)}
              onClick={() => setSkillsOpen(true)}
            >
              <Sparkles className="composer-add-menu-icon" aria-hidden="true" />
              <span>
                {t("skills.menuSummary", {
                  selected: selectedAvailableCount,
                  total: available.length
                })}
              </span>
              <ChevronRight className="composer-add-menu-chevron" aria-hidden="true" />
            </button>
          </div>

          {skillsOpen ? (
            <div
              className="composer-add-skills-panel"
              role="group"
              aria-label={t("skills.selectionAria")}
            >
              <div className="composer-add-skills-heading">
                <strong>{t("skills.activeForTask")}</strong>
                <span>{selectedAvailableCount}/{available.length}</span>
              </div>
              <div className="composer-add-skills-list">
                {available.length ? (
                  available.map((skill) => (
                    <label key={skill.id} title={skill.description}>
                      <input
                        type="checkbox"
                        checked={selected.has(skill.id)}
                        onChange={(event) => toggleSkill(skill.id, event.currentTarget.checked)}
                      />
                      <span>{skill.name}</span>
                    </label>
                  ))
                ) : (
                  <p>{t("skills.none")}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
