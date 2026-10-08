import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Folder, FolderLock, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Conversation, GitWorkspaceInfo, Project } from "@/services/cli/types";
import { copyToClipboard } from "@/utils/clipboard";
import { folderBaseName, formatDisplayPath, pathsEqual } from "@/utils/projectPaths";
import { conversationDisplayCwd } from "./conversationProjectGrouping";

export function ComposerWorkspaceMeta({ conversation, project, gitInfo }: {
  conversation: Conversation;
  project?: Project;
  gitInfo?: GitWorkspaceInfo;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const folders = project?.folders?.map(folder => folder.trim()).filter(Boolean) ?? [];
  const hasProject = folders.length > 0 && Boolean(project);
  const path = conversationDisplayCwd(conversation);
  const name = hasProject
    ? project?.name?.trim() || folderBaseName(project?.primaryPath || path || folders[0])
    : path ? folderBaseName(path) : t("chat.noWorkspace");
  const folderCount = t("chat.folderCount", { count: folders.length });
  const label = hasProject ? `${name} · ${folderCount}` : name;
  const workspaceTitle = conversation.sourceCwd && conversation.cwd
    ? t("chat.isolatedWorkspaceTooltip", { source: conversation.sourceCwd, workspace: conversation.cwd })
    : conversation.cwd;
  const taskWorkspace = conversation.metadata?.taskWorkspace;
  const sourceBranch = taskWorkspace && typeof taskWorkspace === "object" &&
    "mode" in taskWorkspace && taskWorkspace.mode === "worktree" &&
    "branch" in taskWorkspace && typeof taskWorkspace.branch === "string"
    ? taskWorkspace.branch.trim() : undefined;
  // A worktree's saved branch is its starting point, not its current HEAD.
  const branchLabel = !gitInfo?.isGitRepository ? undefined : gitInfo.currentBranch ||
    (sourceBranch ? t("chat.composerBranchBasedOn", { branch: sourceBranch }) : t("chat.composerBranchDetached"));

  const close = useCallback(() => {
    setOpen(false);
    setPosition(undefined);
  }, []);
  const reposition = useCallback(() => {
    const anchor = summaryRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    setPosition({
      top: Math.max(12, rect.top - 8),
      left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    });
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); summaryRef.current?.focus(); }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
    };
  }, [open, close, reposition]);
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [branchLabel]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return <div className="composer-workspace-meta" ref={rootRef}>
    {hasProject ? (
      <button
        ref={summaryRef}
        type="button"
        className={`composer-workspace-summary${open ? " open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${t("chat.workspaceDetails")}: ${label}`}
        title={`${label}${workspaceTitle ? `\n${workspaceTitle}` : ""}`}
        onClick={() => { if (open) close(); else { reposition(); setOpen(true); } }}
      >
        {conversation.sourceCwd
          ? <FolderLock aria-hidden="true" size={12} strokeWidth={1.8} />
          : <Folder aria-hidden="true" size={12} strokeWidth={1.8} />}
        <span className="composer-workspace-project-name">{name}</span>
        <span className="composer-workspace-folder-count">· {folderCount}</span>
      </button>
    ) : (
      <span className="composer-workspace-context" title={workspaceTitle}>
        {conversation.sourceCwd ? <FolderLock size={13} strokeWidth={1.8} aria-hidden="true" /> : null}
        <span className="composer-workspace-name">{name}</span>
      </span>
    )}
    {conversation.sourceCwd ? <span className="composer-workspace-badge" title={workspaceTitle}>{t("chat.isolatedWorkspace")}</span> : null}
    {branchLabel && <>
      <span className="composer-workspace-separator" aria-hidden="true">·</span>
      <button
        type="button"
        className="composer-branch-info"
        aria-label={t("chat.copyBranchInfo", { branch: branchLabel })}
        title={`${copied ? t("workspace.copied") : t("chat.copyBranchInfo", { branch: branchLabel })}\n${conversation.cwd || ""}`}
        onClick={() => {
          void copyToClipboard(branchLabel).then(() => {
            setCopied(true);
            setCopyFailed(false);
          }).catch(() => setCopyFailed(true));
        }}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <GitBranch size={12} aria-hidden="true" />}
        <span>{branchLabel}</span>
      </button>
    </>}
    {open && hasProject && project && position ? (
      <div className="composer-workspace-popover" role="dialog" aria-label={t("chat.workspaceDetails")} style={{ ...position, transform: "translateY(-100%)" }}>
        <div className="composer-workspace-popover-title">{project.name}</div>
        <ul className="composer-workspace-popover-list">
          {folders.map(folder => <li key={folder} title={folder}>
            <Folder aria-hidden="true" size={13} strokeWidth={1.7} />
            <span>{formatDisplayPath(folder)}</span>
            {folders.length > 1 && pathsEqual(folder, project.primaryPath) ? <em>{t("chat.primaryBadge")}</em> : null}
          </li>)}
        </ul>
      </div>
    ) : null}
    <span className="sr-only" role="status">{copyFailed ? t("workspace.copyFailed") : copied ? t("workspace.copied") : ""}</span>
  </div>;
}
