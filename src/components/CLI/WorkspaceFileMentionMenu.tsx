import { useEffect, useRef } from "react";
import { FileText, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkspaceFileMatch } from "@/services/cli/types";

export function WorkspaceFileMentionMenu({
  matches,
  selectedIndex,
  loading,
  onSelect
}: {
  matches: WorkspaceFileMatch[];
  selectedIndex: number;
  loading: boolean;
  onSelect: (match: WorkspaceFileMatch) => void;
}) {
  const { t } = useTranslation();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    optionRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (loading && matches.length === 0) {
    return (
      <div className="workspace-file-mention-menu workspace-file-mention-menu-empty" role="status">
        {t("chat.workspaceFilesLoading")}
      </div>
    );
  }

  if (matches.length === 0) {
    return (
      <div className="workspace-file-mention-menu workspace-file-mention-menu-empty" role="status">
        {t("chat.workspaceFilesEmpty")}
      </div>
    );
  }

  return (
    <ul
      className="workspace-file-mention-menu"
      role="listbox"
      aria-label={t("chat.workspaceFilesAria")}
    >
      {matches.map((match, index) => {
        const isDirectory = match.kind === "directory";
        const Icon = isDirectory ? Folder : FileText;
        return (
          <li key={match.root ? `${match.root}:${match.path}` : match.path} role="presentation">
            <button
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              type="button"
              className={`workspace-file-mention-option${index === selectedIndex ? " active" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              title={match.label ?? match.path}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(match);
              }}
            >
              <Icon
                className="workspace-file-mention-icon"
                aria-hidden="true"
                size={14}
                strokeWidth={1.8}
              />
              <span className="workspace-file-mention-name">
                @{match.name}
                {isDirectory ? "/" : ""}
              </span>
              <span className="workspace-file-mention-path">{match.label ?? match.path}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
