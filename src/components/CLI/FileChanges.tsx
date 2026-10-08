import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Copy, FileDiff as FileDiffIcon, Maximize2, Minimize2, WrapText } from "lucide-react";
import type { CliStreamItem } from "@/services/cli/parsers";
import { useFileDiffStore } from "@/store/fileDiffStore";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";
import { collectFileEdits, foldDiffRows, getFileDiff, getFileEditCounts, groupFileEditRecords, inlineHighlights, isMarkdownFile, markdownVersions, mergeStoredFileEdits, pickerLabels, relativePath, splitPath, type DiffRow, type FileEdit } from "@/utils/fileDiff";
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
      const diff = summary === null ? undefined : summary ?? getFileEditCounts(edit);
      file.edits++;
      file.added += diff?.added ?? 0;
      file.removed += diff?.removed ?? 0;
      file.unknown ||= !diff;
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
  const markdown = isMarkdownFile(edit.path);
  const versions = useMemo(() => markdownVersions(edit), [edit]);
  const [mode, setMode] = useState<"source" | "preview">("source");
  const [version, setVersion] = useState<"before" | "after">(versions.after !== undefined ? "after" : "before");
  const [wrap, setWrap] = useState(markdown);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const rows = useMemo(() => showAll ? diff.rows : foldDiffRows(diff.rows, openFolds), [diff, showAll, openFolds]);
  const marks = useMemo(() => inlineHighlights(diff.rows), [diff]);
  const hasFolds = rows.some((row) => row.kind === "fold");
  const previewAvailable = versions.before !== undefined || versions.after !== undefined;
  const previewUnavailable = t(diff.notice === "large" ? "fileDiff.large" : "fileDiff.previewUnavailable");
  const preview = mode === "preview" && previewAvailable;
  const previewText = versions[version] ?? versions.after ?? versions.before;
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
      {hasFolds && !preview && <button type="button" className="detail-panel-collapse-btn" onClick={() => setShowAll(true)} title={t("fileDiff.expandAll")} aria-label={t("fileDiff.expandAll")}><ChevronsUpDown size={15} /></button>}
      {!!diff.rows.length && <button type="button" className="detail-panel-collapse-btn" onClick={() => void copy()} title={t(copied ? "fileDiff.copied" : "fileDiff.copy")} aria-label={t(copied ? "fileDiff.copied" : "fileDiff.copy")}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>}
    </div>
    <div className="file-diff-view-toolbar">
      {markdown && <div className="file-diff-segmented" role="group" aria-label={t("fileDiff.viewMode")}>
        <button type="button" aria-pressed={!preview} onClick={() => setMode("source")}>{t("fileDiff.source")}</button>
        <button type="button" aria-pressed={preview} disabled={!previewAvailable} title={!previewAvailable ? previewUnavailable : undefined} onClick={() => setMode("preview")}>{t("fileDiff.preview")}</button>
      </div>}
      {preview ? <div className="file-diff-segmented" role="group" aria-label={t("fileDiff.version")}>
        <button type="button" aria-pressed={version === "before"} disabled={versions.before === undefined} onClick={() => setVersion("before")}>{t("fileDiff.before")}</button>
        <button type="button" aria-pressed={version === "after"} disabled={versions.after === undefined} onClick={() => setVersion("after")}>{t("fileDiff.after")}</button>
      </div> : !diff.notice && <button type="button" className="file-diff-wrap-toggle" aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={15} aria-hidden="true" />{t("fileDiff.wrap")}</button>}
    </div>
    {diff.partial && <p className="file-diff-notice">{t("fileDiff.partial")}</p>}
    {diff.notice && <p className="file-diff-notice" role="status">{t(`fileDiff.${diff.notice}`)}</p>}
    {copyError && <p role="alert">{t("fileDiff.copyError")}</p>}
    {!diff.notice && !diff.added && !diff.removed && !diff.rows.some((row) => row.kind === "meta") && <p className="file-diff-notice">{t("fileDiff.identical")}</p>}
    {markdown && !previewAvailable && !diff.notice && <p className="file-diff-preview-hint">{previewUnavailable}</p>}
    {diff.notice === "truncated" && [edit.oldText, edit.newText, edit.patch].some(text => text !== undefined) && <details className="file-diff-captured">
      <summary>{t("fileDiff.captured")}</summary>
      {([{ label: "before", text: edit.oldText }, { label: "after", text: edit.newText }, { label: "patch", text: edit.patch }]).map(({ label, text }) => text !== undefined && <div key={label}>
        <p>{t(`fileDiff.${label}`)}</p><pre>{text || t("fileDiff.emptyDocument")}</pre>
      </div>)}
    </details>}
    {!diff.notice || diff.rows.length > 0 ? <div className={`file-diff-scroll${wrap ? " file-diff-wrapped" : ""}${markdown ? " file-diff-markdown" : ""}${preview ? " file-diff-preview" : ""}`} tabIndex={0} aria-label={t(preview ? "fileDiff.preview" : "fileDiff.title")}>
      {preview ? <article className="markdown-body">
        {previewText ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ a: ({ node: _node, children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{previewText}</ReactMarkdown> : <p className="file-diff-preview-hint">{t("fileDiff.emptyDocument")}</p>}
      </article> : <div className="file-diff-lines">
        {rows.map((row, index) => row.kind === "fold"
          ? <button type="button" className="file-diff-fold" key={`fold-${row.start}`} onClick={() => setOpenFolds((prev) => new Set(prev).add(row.start))}>{t("fileDiff.expand", { count: row.count })}</button>
          : <DiffLine key={index} row={row} mark={marks.get(row)} />)}
      </div>}
    </div> : null}
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
  const files = useMemo(() => groupFileEditRecords(current?.edits ?? []), [current?.edits]);
  const records = files.find(file => file.path === edit?.path)?.indices ?? [];
  const recordIndex = current ? records.indexOf(current.index) : -1;
  const total = records.length;
  const roots = useWorkspaceRoots(current?.conversationId);
  const labels = useMemo(() => pickerLabels(files.map(file => file.path), roots), [files, roots]);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => setExpanded(false), [activeId]);
  // Keep a single reader mounted while moving the native dialog into the top
  // layer. Native modal behavior supplies focus containment and Escape handling.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focused = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    dialog.close();
    if (expanded) dialog.showModal();
    else dialog.show();
    focused?.focus({ preventScroll: true });
  }, [expanded]);
  const go = (delta: number) => {
    const index = records[recordIndex + delta];
    if (index !== undefined) useFileDiffStore.getState().select(index);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    go(event.key === "ArrowUp" ? -1 : 1);
  };
  return <dialog ref={dialogRef} className={`file-diff-host${expanded ? " is-expanded" : ""}`} role={expanded ? "dialog" : "region"} aria-modal={expanded ? true : undefined} aria-label={t("fileDiff.title")} onCancel={(event) => { event.preventDefault(); setExpanded(false); }}>
    <section className="file-diff-panel" aria-label={t("fileDiff.title")} onKeyDown={onKeyDown}>
    {current && edit ? <>
      <div className="file-diff-toolbar">
        <label className="file-diff-picker">{t("fileDiff.file")}
          <select value={edit.path} title={edit.path} onChange={(event) => {
            const file = files.find(item => item.path === event.target.value);
            if (file) useFileDiffStore.getState().select(file.indices[0]);
          }}>
            {files.map((file, index) => <option key={file.path} value={file.path}>{labels[index]}</option>)}
          </select>
        </label>
        {total > 1 && <div className="file-diff-nav">
          <label className="file-diff-record-label">{t("fileDiff.record")}
            <select aria-label={t("fileDiff.record")} value={current.index} onChange={(event) => useFileDiffStore.getState().select(Number(event.target.value))}>
              {records.map((index, ordinal) => <option key={index} value={index}>{ordinal + 1}/{total} · {t(`fileDiff.${current.edits[index].action}`)}</option>)}
            </select>
          </label>
          <button type="button" className="detail-panel-collapse-btn" disabled={recordIndex === 0} onClick={() => go(-1)} title={t("fileDiff.prev")} aria-label={t("fileDiff.prev")}><ChevronUp size={15} /></button>
          <button type="button" className="detail-panel-collapse-btn" disabled={recordIndex === total - 1} onClick={() => go(1)} title={t("fileDiff.next")} aria-label={t("fileDiff.next")}><ChevronDown size={15} /></button>
        </div>}
        <button type="button" className="detail-panel-collapse-btn file-diff-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} title={t(expanded ? "fileDiff.exitExpanded" : "fileDiff.fullWidth")} aria-label={t(expanded ? "fileDiff.exitExpanded" : "fileDiff.fullWidth")}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
      </div>
      {edit.blobKey && loaded?.status !== "ready" ? <p className="file-diff-notice" role="status">
        {t(`fileDiff.${!loaded || loaded.status === "loading" ? "loading" : loaded.status === "error" ? "loadError" : loaded.status === "missing" ? "unavailable" : "large"}`)}
        {(loaded?.status === "error" || loaded?.status === "missing") && <button type="button" onClick={() => void useFileDiffStore.getState().loadSelected(true)}>{t("fileDiff.retry")}</button>}
      </p> : <DiffContent key={`${current.conversationId}:${current.messageId}:${current.index}:${edit.blobKey ?? edit.path}`} edit={loaded?.edit ?? edit} path={relativePath(edit.path, roots)} />}
    </> : <p className="file-diff-empty"><FileDiffIcon size={30} />{t("fileDiff.empty")}</p>}
    </section>
  </dialog>;
}
