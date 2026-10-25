import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import type { SkillRecord, SkillSnapshot } from "@/services/skills/types";
import { useSkillUsageStore } from "@/store/skillUsageStore";
import { filterCommandSkills, parseSlashDraft, snapshotCommandSkill } from "@/utils/skillCommands";

export function useSkillCommands({ draft, onDraft, skills, selected, onSelected, textareaRef, scopeKey, disabled = false }: {
  draft: string;
  onDraft: (value: string) => void;
  skills: SkillRecord[];
  selected: SkillSnapshot[];
  onSelected: (value: SkillSnapshot[]) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  scopeKey?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const recentIds = useSkillUsageStore(s => s.recentIds);
  const remember = useSkillUsageStore(s => s.remember);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pasted = useRef(false);
  const parsed = parseSlashDraft(draft);
  const query = parsed?.query ?? "";
  const matches = useMemo(() => filterCommandSkills(skills, query, recentIds), [skills, query, recentIds]);
  const active = open && !!parsed && !disabled;
  const index = Math.min(selectedIndex, Math.max(0, matches.length - 1));

  useEffect(() => { setOpen(false); setSelectedIndex(0); }, [scopeKey]);

  const select = (skill: SkillRecord) => {
    if (disabled || !skill.enabled || !skill.trusted) return;
    onSelected([...selected.filter(entry => entry.id !== skill.id), snapshotCommandSkill(skill)]);
    remember(skill.id);
    if (parsed) onDraft("");
    setOpen(false);
    textareaRef.current?.focus();
  };

  return {
    id, active, query, matches, selectedIndex: index, setSelectedIndex,
    select,
    remove(id: string) {
      if (disabled) return;
      onSelected(selected.filter(skill => skill.id !== id));
      textareaRef.current?.focus();
    },
    selectIds(ids: string[]) {
      if (disabled) return;
      const next = skills.filter(skill => ids.includes(skill.id) && skill.enabled && skill.trusted);
      for (const skill of next) if (!selected.some(entry => entry.id === skill.id)) remember(skill.id);
      onSelected(next.map(snapshotCommandSkill));
      if (parsed) onDraft("");
      setOpen(false);
    },
    handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
      const input = event.nativeEvent as InputEvent;
      const fromPaste = input.inputType === "insertFromPaste" || (!input.inputType && pasted.current);
      pasted.current = false;
      setOpen(!fromPaste && !!parseSlashDraft(event.currentTarget.value) &&
        event.currentTarget.selectionStart === event.currentTarget.value.length);
      setSelectedIndex(0);
    },
    handlePaste() { pasted.current = true; setOpen(false); },
    handleBlur() { setOpen(false); },
    handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
      if (!active) return false;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return true; }
      if (!matches.length) {
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return true; }
        return false;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault(); select(matches[index]); return true;
      }
      return false;
    }
  };
}
