import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent
} from "react";

import { cliClient } from "@/services/cli/client";
import type { WorkspaceFileMatch } from "@/services/cli/types";
import {
  findWorkspaceFileMentionDraft,
  insertWorkspaceFileMention,
  type WorkspaceFileMentionDraft
} from "@/utils/workspaceFileMentions";

interface UseWorkspaceFileMentionsInput {
  value: string;
  cwd?: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useWorkspaceFileMentions({
  value,
  cwd,
  onChange,
  textareaRef
}: UseWorkspaceFileMentionsInput) {
  const [activeMention, setActiveMention] = useState<WorkspaceFileMentionDraft | null>(null);
  const [matches, setMatches] = useState<WorkspaceFileMatch[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestGenerationRef = useRef(0);
  const dismissedValueRef = useRef<string | null>(null);

  const updateActiveMention = useCallback((nextValue: string, cursor: number) => {
    if (dismissedValueRef.current === nextValue) {
      setActiveMention(null);
      return;
    }
    const nextMention = findWorkspaceFileMentionDraft(nextValue, cursor);
    setActiveMention((current) => {
      if (
        current?.start === nextMention?.start &&
        current?.end === nextMention?.end &&
        current?.query === nextMention?.query
      ) {
        return current;
      }
      return nextMention;
    });
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.currentTarget.value;
      dismissedValueRef.current = null;
      onChange(nextValue);
      updateActiveMention(nextValue, event.currentTarget.selectionStart ?? nextValue.length);
    },
    [onChange, updateActiveMention]
  );

  const handleCaretChange = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      updateActiveMention(target.value, target.selectionStart ?? target.value.length);
    },
    [updateActiveMention]
  );

  useEffect(() => {
    if (!value || !cwd) {
      dismissedValueRef.current = null;
      setActiveMention(null);
      setMatches([]);
      setLoading(false);
    }
  }, [cwd, value]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    setSelectedIndex(0);

    if (!activeMention || !cwd || !cliClient.isAvailable()) {
      setMatches([]);
      setLoading(false);
      return;
    }

    setMatches([]);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void cliClient
        .searchWorkspaceFiles(cwd, activeMention.query, 24)
        .then((nextMatches) => {
          if (requestGenerationRef.current === generation) setMatches(nextMatches);
        })
        .catch(() => {
          if (requestGenerationRef.current === generation) setMatches([]);
        })
        .finally(() => {
          if (requestGenerationRef.current === generation) setLoading(false);
        });
    }, 80);

    return () => window.clearTimeout(timer);
  }, [activeMention, cwd]);

  const selectMatch = useCallback(
    (match: WorkspaceFileMatch) => {
      if (!activeMention) return;
      const inserted = insertWorkspaceFileMention(value, activeMention, match.path);
      dismissedValueRef.current = inserted.value;
      requestGenerationRef.current += 1;
      setActiveMention(null);
      setMatches([]);
      setLoading(false);
      onChange(inserted.value);
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    },
    [activeMention, onChange, textareaRef, value]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!activeMention) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        dismissedValueRef.current = value;
        setActiveMention(null);
        setMatches([]);
        return true;
      }
      if (matches.length === 0) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % matches.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => (index - 1 + matches.length) % matches.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = matches[selectedIndex];
        if (selected) selectMatch(selected);
        return true;
      }
      return false;
    },
    [activeMention, matches, selectMatch, selectedIndex, value]
  );

  return {
    active: Boolean(activeMention && cwd),
    query: activeMention?.query ?? "",
    matches,
    selectedIndex,
    loading,
    handleChange,
    handleCaretChange,
    handleKeyDown,
    selectMatch
  };
}
