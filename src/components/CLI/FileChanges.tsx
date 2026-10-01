import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Copy, FileDiff as FileDiffIcon } from "lucide-react";
import type { CliStreamItem } from "@/services/cli/parsers";
import { useFileDiffStore } from "@/store/fileDiffStore";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import { collectFileEdits, foldDiffRows, getFileDiff, inlineHighlights, mergeStoredFileEdits, pickerLabels, relativePath, splitPath, type DiffRow, type FileEdit } from "@/utils/fileDiff";
import { conversationWorktreePath } from "./conversationProjectGrouping";
import { copyToClipboard } from "@/utils/clipboard";

function useWorkspaceRoots(conversationId?: string) {
  const conversation = useConversationStore((s) => (conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined));
  return useMemo(() => [conversationWorktreePath(conversation), conversation?.cwd, conversation?.sourceCwd], [conversation]);
}

function Counts({ added, removed, className, title }: { added: number; removed: number; className: string; title?: string }) {
  return <span className={className} title={title}><span className="is-add">+{added}</span><span className="is-delete">−{removed}</span></span>;
}

export function FileChangesCard({ items, conversationId, messageId, storedTaskId, isRunning = false }: {
  items: CliStreamItem[]; conversationId: string; messageId: string; storedTaskId?: string; isRunning?: boolean;
}) {
  const { t } = useTranslation();
  const roots = useWorkspaceRoots(conversationId);
  const storedKey = JSON.stringify([conversationId, messageId, storedTaskId]);
  const [stored, setStored] = useState<{ key: string; edits: FileEdit[] }>();
  const [indexError, setIndexError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const counts = useFileDiffStore(state => state.counts);
  const edits = useMemo(() => mergeStoredFileEdits(collectFileEdits(items), stored?.key === storedKey ? stored.edits : undefined), [items, stored, storedKey]);
  useEffect(() => {
    let cancelled = false;
    setIndexError(false);
    if (!storedTaskId || isRunning) return;
    void (async () => {
      try {
        const collected: FileEdit[] = [];
        let cursor = 0;
        while (!cancelled) {
          const page = await cliClient.listMessageFileEdits(messageId, cursor);
          if (cancelled) return;
          collected.push(...page.edits);
          if (!page.hasMore) break;
          if (page.nextCursor <= cursor) throw new Error("Invalid file edit cursor");
          cursor = page.nextCursor;
        }
        if (!cancelled) setStored({ key: storedKey, edits: collected });
      } catch {
        if (!cancelled) setIndexError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [messageId, storedTaskId, storedKey, isRunning, attempt]);
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(() => {
    const grouped = new Map<string, { path: string; index: number; edits: number; added: number; removed: number; unknown: boolean }>();
    edits.forEach((edit, index) => {
      const file = grouped.get(edit.path) ?? { path: edit.path, index, edits: 0, added: 0, removed: 0, unknown: false };
      const summary = edit.blobKey ? counts[edit.blobKey] : undefined;
      const diff = summary ? { ...summary, notice: undefined } : getFileDiff(edit);
      file.edits++;
      file.added += diff.added;
      file.removed += diff.removed;
      file.unknown ||= !!diff.notice;
      grouped.set(edit.path, file);
    });
    return [...grouped.values()];
  }, [edits, counts]);
  useEffect(() => setExpanded(false), [conversationId, messageId]);
  useEffect(() => { useFileDiffStore.getState().refresh(conversationId, messageId, edits); }, [conversationId, messageId, edits]);
  if (!edits.length && !indexError) return null;
  const open = (index: number) => useFileDiffStore.getState().open({ conversationId, messageId, edits, index });
  return <section className="file-changes-card" aria-label={t("fileDiff.title")}>
    {indexError && <p className="file-diff-notice" role="status">{t("fileDiff.indexError")} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("fileDiff.retry")}</button></p>}
    {(expanded ? files : files.slice(0, 3)).map((file) => {
      const { name, dir } = splitPath(relativePath(file.path, roots));
      return <button type="button" className="file-change-entry" key={file.path} title={file.path} aria-label={`${t("fileDiff.view")}: ${file.path}`} onClick={() => open(file.index)}>
        <FileDiffIcon size={18} className="file-change-icon" aria-hidden="true" />
        <span className="file-change-path"><span className="file-change-name">{name}</span>{dir && <span className="file-change-dir">{dir}</span>}</span>
        {file.edits > 1 && <span className="file-change-edits">{t("fileDiff.editCount", { count: file.edits })}</span>}
        {file.unknown ? <span className="file-change-unavailable">{t("fileDiff.countsUnavailable")}</span> : <Counts className="file-change-counts" added={file.added} removed={file.removed} title={file.edits > 1 ? t("fileDiff.countsHint") : undefined} />}
        <ChevronRight size={16} className="file-change-chevron" aria-hidden="true" />
      </button>;
    })}
    {files.length > 3 && <button type="button" className="file-changes-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {t(expanded ? "fileDiff.showLess" : "fileDiff.showMore", { count: files.length - 3 })}<ChevronDown size={18} className={expanded ? "is-expanded" : undefined} />
    </button>}
  </section>;
}

function DiffLine({ row, mark }: { row: DiffRow; mark?: [number, number] }) {
  const { text } = row;
  return <div className={`file-diff-line file-diff-${row.kind}`}>
    <span className="file-diff-gutter">
      <span className="file-diff-number">{row.oldLine}</span><span className="file-diff-number">{row.newLine}</span>
      <span className="file-diff-sign">{row.kind === "add" ? "+" : row.kind === "delete" ? "−" : " "}</span>
    </span>
    <code>{mark && mark[1] > mark[0]
      ? <>{text.slice(0, mark[0])}<mark className="file-diff-word">{text.slice(mark[0], mark[1])}</mark>{text.slice(mark[1])}</>
      : text || " "}</code>
  </div>;
}

function DiffContent({ edit, path }: { edit: FileEdit; path: string }) {
  const { name, dir } = splitPath(path);
  const { t } = useTranslation();
  const diff = getFileDiff(edit);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const rows = useMemo(() => showAll ? diff.rows : foldDiffRows(diff.rows, openFolds), [diff, showAll, openFolds]);
  const marks = useMemo(() => inlineHighlights(diff.rows), [diff]);
  const hasFolds = rows.some((row) => row.kind === "fold");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const text = edit.patch ?? diff.rows.map((row) => `${row.kind === "add" ? "+" : row.kind === "delete" ? "-" : " "}${row.text}`).join("\n");
    try { await copyToClipboard(text); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  };
  return <>
    <div className="file-diff-heading">
      <span className="file-diff-title" title={edit.path}><strong>{name}</strong>{dir && <span className="file-diff-dir"><bdi dir="ltr">{dir}</bdi></span>}</span>
      {!diff.notice && <Counts className="file-diff-counts" added={diff.added} removed={diff.removed} />}
      {hasFolds && <button type="button" className="detail-panel-collapse-btn" onClick={() => setShowAll(true)} title={t("fileDiff.expandAll")} aria-label={t("fileDiff.expandAll")}><ChevronsUpDown size={15} /></button>}
      {!!diff.rows.length && <button type="button" className="detail-panel-collapse-btn" onClick={() => void copy()} title={t(copied ? "fileDiff.copied" : "fileDiff.copy")} aria-label={t(copied ? "fileDiff.copied" : "fileDiff.copy")}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>}
    </div>
    {diff.partial && <p className="file-diff-notice">{t("fileDiff.partial")}</p>}
    {diff.notice && <p className="file-diff-notice" role="status">{t(`fileDiff.${diff.notice}`)}</p>}
    {copyError && <p role="alert">{t("fileDiff.copyError")}</p>}
    {!diff.notice && !diff.added && !diff.removed && !diff.rows.some((row) => row.kind === "meta") && <p className="file-diff-notice">{t("fileDiff.identical")}</p>}
    <div className="file-diff-scroll" tabIndex={0} aria-label={t("fileDiff.title")}>
      <div className="file-diff-lines">
        {rows.map((row, index) => row.kind === "fold"
          ? <button type="button" className="file-diff-fold" key={`fold-${row.start}`} onClick={() => setOpenFolds((prev) => new Set(prev).add(row.start))}>{t("fileDiff.expand", { count: row.count })}</button>
          : <DiffLine key={index} row={row} mark={marks.get(row)} />)}
      </div>
    </div>
  </>;
}

export function FileDiffPanel() {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const selection = useFileDiffStore((s) => s.selection);
  const content = useFileDiffStore((s) => s.content);
  const current = selection?.conversationId === activeId ? selection : undefined;
  const edit = current?.edits[current.index];
  const loaded = edit?.blobKey && content?.key === JSON.stringify([current?.conversationId, edit.blobKey]) ? content : undefined;
  const total = current?.edits.length ?? 0;
  const roots = useWorkspaceRoots(current?.conversationId);
  const labels = useMemo(() => pickerLabels(current?.edits.map((item) => item.path) ?? [], roots), [current?.edits, roots]);
  const go = (delta: number) => { if (current) useFileDiffStore.getState().select(current.index + delta); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    go(event.key === "ArrowUp" ? -1 : 1);
  };
  return <section className="file-diff-panel" aria-label={t("fileDiff.title")} onKeyDown={onKeyDown}>
    {current && edit ? <>
      <div className="file-diff-toolbar">
        <label className="file-diff-picker">{t("fileDiff.record")}
          <select value={current.index} title={edit.path} onChange={(event) => useFileDiffStore.getState().select(Number(event.target.value))}>
            {current.edits.map((item, index) => <option key={index} value={index}>{index + 1}. {labels[index]} · {t(`fileDiff.${item.action}`)}</option>)}
          </select>
        </label>
        {total > 1 && <div className="file-diff-nav">
          <span aria-live="polite">{current.index + 1}/{total}</span>
          <button type="button" className="detail-panel-collapse-btn" disabled={current.index === 0} onClick={() => go(-1)} title={t("fileDiff.prev")} aria-label={t("fileDiff.prev")}><ChevronUp size={15} /></button>
          <button type="button" className="detail-panel-collapse-btn" disabled={current.index === total - 1} onClick={() => go(1)} title={t("fileDiff.next")} aria-label={t("fileDiff.next")}><ChevronDown size={15} /></button>
        </div>}
      </div>
      {edit.blobKey && loaded?.status !== "ready" ? <p className="file-diff-notice" role="status">
        {t(`fileDiff.${!loaded || loaded.status === "loading" ? "loading" : loaded.status === "error" ? "loadError" : loaded.status === "missing" ? "unavailable" : "large"}`)}
        {(loaded?.status === "error" || loaded?.status === "missing") && <button type="button" onClick={() => void useFileDiffStore.getState().loadSelected(true)}>{t("fileDiff.retry")}</button>}
      </p> : <DiffContent key={`${current.conversationId}:${current.messageId}:${current.index}:${edit.blobKey ?? edit.path}`} edit={loaded?.edit ?? edit} path={relativePath(edit.path, roots)} />}
    </> : <p className="file-diff-empty"><FileDiffIcon size={30} />{t("fileDiff.empty")}</p>}
  </section>;
}
