import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillRecord } from "@/services/skills/types";

export { parseSlashDraft } from "@/utils/skillCommands";

export function SlashCommandMenu({ id, skills, selectedIndex, onSelect, onHighlight, query, loading = false, error, onRetry, anchorRef }: {
  id: string;
  skills: SkillRecord[];
  selectedIndex: number;
  query: string;
  onSelect: (skill: SkillRecord) => void;
  onHighlight: (index: number) => void;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const boundary = anchor.closest(".chat-view, .new-task-view")?.getBoundingClientRect();
      const minTop = Math.max(8, (boundary?.top ?? 0) + 8);
      const above = rect.top - minTop - 8;
      const below = window.innerHeight - rect.bottom - 16;
      const openAbove = above >= 220 || above >= below;
      const width = Math.min(rect.width, 560, window.innerWidth - 16);
      setPosition({
        top: openAbove ? rect.top - 8 : rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.min(350, Math.max(96, openAbove ? above : below)),
        transform: openAbove ? "translateY(-100%)" : undefined
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, skills.length, loading, error]);
  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return createPortal(<div ref={root} className="skill-command-menu" style={position}>
    <div className="skill-command-heading"><strong>{t("chat.chooseSkill")}</strong><span>{t("chat.skillsThisMessage")}</span></div>
    {loading ? <p role="status">{t("chat.skillsLoading")}</p> : error ? <p role="status">{t("chat.skillsLoadFailed")} <button type="button" onClick={onRetry}>{t("chat.skillsRetry")}</button></p> : skills.length ? <ul id={id} role="listbox" aria-label={t("chat.chooseSkill")}>
      {skills.map((skill, index) => <li key={skill.id} role="presentation">
        <button id={`${id}-${index}`} type="button" role="option" aria-selected={selectedIndex === index}
          className={`skill-command-option${selectedIndex === index ? " active" : ""}`}
          onMouseEnter={() => onHighlight(index)}
          onMouseDown={event => { event.preventDefault(); onSelect(skill); }}>
          <span className="skill-command-icon"><Sparkles size={16} aria-hidden="true" /></span>
          <span className="skill-command-copy"><strong>{skill.name}</strong><span>{skill.description}</span></span>
        </button>
      </li>)}
    </ul> : <p role="status">{t(query ? "skills.noResults" : "skills.none")}</p>}
    <div className="skill-command-footer">{skills.length > 0 && !loading && !error && <><span>↑ ↓ {t("chat.skillNavigate")}</span><span>↵ {t("chat.skillSelect")}</span></>}<span>Esc {t("chat.skillDismiss")}</span></div>
  </div>, document.body);
}
