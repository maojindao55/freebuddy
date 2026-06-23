import { useTranslation } from "react-i18next";

import type { AvailableCommandItem } from "@/store/sessionMetaUtils";

export function SlashCommandMenu({
  commands,
  query,
  selectedIndex,
  onSelect
}: {
  commands: AvailableCommandItem[];
  query: string;
  selectedIndex: number;
  onSelect: (command: AvailableCommandItem) => void;
}) {
  const { t } = useTranslation();
  const normalized = query.trim().toLowerCase();
  const filtered = commands.filter((command) =>
    command.name.toLowerCase().startsWith(normalized)
  );

  if (!filtered.length) {
    return (
      <div className="slash-command-menu slash-command-menu-empty" role="status">
        {t("chat.slashCommandsEmpty")}
      </div>
    );
  }

  return (
    <ul className="slash-command-menu" role="listbox" aria-label={t("chat.slashCommandsAria")}>
      {filtered.map((command, index) => (
        <li key={command.name} role="presentation">
          <button
            type="button"
            className={`slash-command-option${index === selectedIndex ? " active" : ""}`}
            role="option"
            aria-selected={index === selectedIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command);
            }}
          >
            <span className="slash-command-name">/{command.name}</span>
            {command.description ? (
              <span className="slash-command-description">{command.description}</span>
            ) : null}
            {command.inputHint ? (
              <span className="slash-command-hint">{command.inputHint}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function parseSlashDraft(draft: string): { query: string } | null {
  const match = draft.match(/^\/([^\s]*)$/);
  if (!match) return null;
  return { query: match[1] ?? "" };
}
