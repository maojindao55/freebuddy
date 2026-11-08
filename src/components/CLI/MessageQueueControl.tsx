import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, List, Paperclip, Pause, Pencil, Play, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";
import { useMessageQueueStore } from "@/store/messageQueueStore";
import type { MessageQueueCommand, QueuedMessage } from "../../../electron/shared/messageQueueTypes";

export function MessageQueueControl({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation();
  const queue = useMessageQueueStore(state => state.queues[conversationId]);
  const change = useMessageQueueStore(state => state.change);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editLease = useRef<{ id: string; token: string } | undefined>(undefined);

  async function mutate(command: MessageQueueCommand) {
    setPending(true); setError(undefined);
    try { await change(command); return true; }
    catch (failure) { setError(t("messageQueue.changeFailed", { error: failure instanceof Error ? failure.message : String(failure) })); return false; }
    finally { setPending(false); }
  }
  async function cancelEdit() {
    const lease = editLease.current;
    if (lease && !(await mutate({ conversationId, action: "cancelEdit", ...lease }))) return;
    editLease.current = undefined;
    setEditing(undefined);
    triggerRef.current?.focus();
  }
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!editLease.current && !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!open || event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (editLease.current) void cancelEdit();
      else { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open, conversationId]);
  useEffect(() => {
    if (!queue?.entries.length) setOpen(false);
  }, [queue?.entries.length]);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const lease = editLease.current;
      if (lease) void change({ conversationId, action: "edit", ...lease }).catch(() => setError(t("messageQueue.editExpired")));
    }, 15_000);
    return () => {
      clearInterval(timer);
      const lease = editLease.current;
      if (lease) void change({ conversationId, action: "cancelEdit", ...lease }).catch(() => {});
    };
  }, [conversationId, change, t]);

  async function beginEdit(entry: QueuedMessage) {
    const lease = { id: entry.id, token: nanoid() };
    if (await mutate({ conversationId, action: "edit", ...lease })) {
      editLease.current = lease; setEditing(entry.id); setText(entry.prompt);
    }
  }
  if (!queue?.entries.length) return null;
  const editingElsewhere = Boolean(queue.editingId && queue.editingId !== editing);
  const waitingForFinish = queue.paused && queue.busy && (queue.reason === "stopped" || queue.reason === "failed");
  const status = editing ? t("messageQueue.editing") : editingElsewhere ? t("messageQueue.editingElsewhere") : waitingForFinish ? t("messageQueue.waitingForFinish") : queue.paused ? t(`messageQueue.reason.${queue.reason ?? "manual"}`) : undefined;
  return <div className="message-queue-control" ref={rootRef}>
    {open && <section className="message-queue-popover" id={`message-queue-${conversationId}`} role="dialog" aria-label={t("messageQueue.title")}>
      <header><div><h3>{t("messageQueue.count", { count: queue.entries.length })}</h3>{status && <p>{status}</p>}</div>
        <button type="button" className="message-queue-icon" disabled={pending || Boolean(queue.editingId) || waitingForFinish} title={t(queue.paused ? "messageQueue.resume" : "messageQueue.pause")} aria-label={t(queue.paused ? "messageQueue.resume" : "messageQueue.pause")} onClick={() => void mutate({ conversationId, action: queue.paused ? "resume" : "pause" })}>{queue.paused ? <Play size={16} /> : <Pause size={16} />}</button>
      </header>
      <ol>{queue.entries.map((entry, index) => <li key={entry.id}>
        <span className="message-queue-number">{index + 1}</span>
        {editing === entry.id ? <div className="message-queue-edit">
          <label className="message-queue-sr-only" htmlFor={`queue-edit-${conversationId}`}>{t("messageQueue.edit")}</label>
          <textarea ref={inputRef} id={`queue-edit-${conversationId}`} value={text} rows={3} disabled={pending} onChange={event => setText(event.target.value)} />
          <div className="message-queue-edit-actions"><button type="button" disabled={pending} onClick={() => void cancelEdit()}>{t("common.cancel")}</button><button type="button" className="message-queue-save" disabled={pending || (!text.trim() && !entry.attachments.length)} onClick={async () => {
            const lease = editLease.current;
            if (lease && await mutate({ conversationId, action: "save", ...lease, prompt: text })) { editLease.current = undefined; setEditing(undefined); triggerRef.current?.focus(); }
          }}><Check size={13} />{t("common.save")}</button></div>
        </div> : <><div className="message-queue-content"><p>{entry.prompt || t("messageQueue.attachmentMessage")}</p>
          <div className="message-queue-metadata">
            {entry.attachments.map(file => <span key={file.id}><Paperclip size={11} />{file.name}</span>)}
            {entry.messageSkills?.map(skill => <span key={skill.id}>/{skill.name}</span>)}
            {entry.conversationReferences?.map(reference => <span key={reference.id}>{t("messageQueue.reference", { title: reference.title })}</span>)}
            {entry.configOptionOverrides?.model && <span>{entry.configOptionOverrides.model}</span>}
            {entry.sending && <span>{t("messageQueue.sending")}</span>}
          </div></div><div className="message-queue-item-actions">
          <button type="button" className="message-queue-icon" disabled={pending || entry.sending || Boolean(queue.editingId)} title={t("messageQueue.edit")} aria-label={t("messageQueue.editItem", { index: index + 1 })} onClick={() => void beginEdit(entry)}><Pencil size={16} /></button>
          <button type="button" className="message-queue-icon" disabled={pending || entry.sending || Boolean(queue.editingId)} title={t("messageQueue.remove")} aria-label={t("messageQueue.removeItem", { index: index + 1 })} onClick={() => void mutate({ conversationId, action: "remove", id: entry.id })}><X size={17} /></button>
        </div></>}
      </li>)}</ol>
      {error && <p className="message-queue-error" role="alert">{error}</p>}
      {queue.paused && queue.error && <p className="message-queue-error" role="alert">{queue.error}</p>}
    </section>}
    <button type="button" className={`message-queue-trigger${queue.paused ? " paused" : ""}`} ref={triggerRef} aria-expanded={open} aria-controls={`message-queue-${conversationId}`} onClick={() => { if (!editing) setOpen(!open); }}>
      <span><List size={16} /><strong>{t("messageQueue.count", { count: queue.entries.length })}</strong>{queue.paused && <small>{t("messageQueue.paused")}</small>}</span>
      <span className="message-queue-timing">{t(queue.paused ? "messageQueue.waitingResume" : "messageQueue.afterReplyShort")}<ChevronDown size={16} className={open ? "expanded" : undefined} /></span>
    </button>
  </div>;
}
