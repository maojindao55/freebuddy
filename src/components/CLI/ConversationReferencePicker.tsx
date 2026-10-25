import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MessagesSquare, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useConversationStore } from "@/store/conversationStore";
import { findReferenceConversations, mergeConversationReferences, type ConversationReferenceDraft } from "@/utils/conversationReferences";

export function ConversationReferenceTags({ references, onRemove, disabled = false }: {
  references: ConversationReferenceDraft[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!references.length) return null;
  return <div className="composer-conversation-references" aria-label={t("contextShare.referencesLabel")}>
    {references.map(reference => <span className="message-skill-tag conversation-reference-tag" key={reference.id} title={`${reference.title} · ${reference.agentName}`}>
      <MessagesSquare size={13} aria-hidden="true" /><span>{reference.title}</span>
      {onRemove && <button type="button" disabled={disabled} aria-label={t("contextShare.removeNamedReference", { title: reference.title })} onClick={() => onRemove(reference.id)}><X size={12} aria-hidden="true" /></button>}
    </span>)}
  </div>;
}

export function ConversationReferencePicker({ targetId, selected, onChange, onClose }: {
  targetId?: string;
  selected: ConversationReferenceDraft[];
  onChange: (references: ConversationReferenceDraft[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const conversations = useConversationStore(state => state.conversations);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(selected);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => findReferenceConversations(conversations, query, targetId), [conversations, query, targetId]);
  const selectedIds = new Set(pending.map(reference => reference.id));
  const listId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (previous?.isConnected && previous !== document.body) previous.focus();
      else document.querySelector<HTMLTextAreaElement>(".chat-composer textarea, .new-task-composer textarea")?.focus();
    };
  }, []);
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { dialogRef.current?.querySelector(`#${CSS.escape(`${listId}-${index}`)}`)?.scrollIntoView({ block: "nearest" }); }, [index, listId]);
  const toggle = (reference: ConversationReferenceDraft) => {
    setPending(current => current.some(item => item.id === reference.id)
      ? current.filter(item => item.id !== reference.id)
      : mergeConversationReferences(current, [{ id: reference.id, title: reference.title, agentName: reference.agentName }]));
  };
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="modal conversation-reference-picker" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])];
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="conversation-reference-heading"><h3 id={titleId}>{t("contextShare.addReference")}</h3><button type="button" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button></div>
      <p id={descriptionId}>{t("contextShare.referenceHint")}</p>
      <label className="conversation-reference-search"><Search size={17} aria-hidden="true" /><input ref={inputRef} type="search" value={query} placeholder={t("contextShare.searchConversations")} aria-label={t("contextShare.searchConversations")}
        role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={matches.length ? `${listId}-${Math.min(index, matches.length - 1)}` : undefined}
        onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(current => matches.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0); }
          if (event.key === "Enter") { event.preventDefault(); const reference = matches[Math.min(index, matches.length - 1)]; if (reference) toggle(reference); }
        }} /></label>
      <div className="conversation-reference-list" id={listId} role="listbox" aria-multiselectable="true" aria-label={t("contextShare.addReference")}>
        {matches.length ? matches.map((conversation, matchIndex) => <div key={conversation.id} id={`${listId}-${matchIndex}`} role="option" aria-selected={selectedIds.has(conversation.id)}
          className={`conversation-reference-option${index === matchIndex ? " is-highlighted" : ""}`} onMouseEnter={() => setIndex(matchIndex)} onMouseDown={event => event.preventDefault()} onClick={() => toggle(conversation)}>
          <MessagesSquare size={18} aria-hidden="true" /><span><strong>{conversation.title}</strong><small>{conversation.agentName}{conversation.cwd ? ` · ${conversation.cwd.split(/[\\/]/).filter(Boolean).at(-1)}` : ""}{conversation.archived ? ` · ${t("contextShare.archived")}` : ""}</small></span>
          <span className={`conversation-reference-check${selectedIds.has(conversation.id) ? " is-selected" : ""}`}>{selectedIds.has(conversation.id) && <Check size={14} aria-hidden="true" />}</span>
        </div>) : <p className="conversation-reference-empty">{t(query.trim() ? "contextShare.noMatchingConversations" : "contextShare.noOtherConversations")}</p>}
      </div>
      <div className="transfer-dialog-actions conversation-reference-footer"><span role="status" aria-live="polite">{t("contextShare.selectedCount", { count: pending.length })}</span><button type="button" onClick={onClose}>{t("handoff.cancel")}</button><button type="button" className="primary" onClick={() => { onChange(pending); onClose(); }}>{t("contextShare.confirmReferences")}</button></div>
    </div>
  </div>, document.body);
}
