import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("WorkflowPlanCard renders preview stats and run/cancel actions", () => {
  const src = read("../src/components/Workflows/WorkflowPlanCard.tsx");
  assert.match(src, /workflow-plan-stats/);
  assert.match(src, /workflow-plan-phases/);
  assert.match(src, /workflow-plan-gates/);
  assert.match(src, /workflow-plan-risk/);
  assert.match(src, /gate\.type/);
  assert.match(src, /gate\.reason/);
  assert.match(src, /createAndStart/);
  assert.match(src, /clearPending/);
});

test("WorkflowRunPanel renders running actions and pause/resume/stop", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /workflow-run-actions/);
  assert.match(src, /workflow\.pause/);
  assert.match(src, /workflow\.resume/);
  assert.match(src, /workflow\.stop/);
  assert.match(src, /setInterval/);
});

test("WorkflowRunPanel uses replay workflow snapshots as read-only state", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /useReplayStore/);
  assert.match(src, /replayFrames\[replayIndex\]\?\.workflow/);
  assert.match(src, /const activeRun = replaySnapshot\?\.run \?\? storeActiveRun/);
  assert.match(src, /const steps = replaySnapshot\?\.steps \?\? storeSteps/);
  assert.match(src, /!replayingWorkflow && \(isLive \|\| gatingPhaseId \|\| canContinueImplementReview\)/);
  assert.match(src, /replayingWorkflow[\s\S]*\? undefined[\s\S]*: \(step\) => void retryStep/);
});

test("WorkflowRunPanel can continue build review after verification failure", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /verifyStep/);
  assert.match(src, /UNRESOLVED:\\s\*\[1-9\]\\d\*/);
  assert.match(src, /canContinueImplementReview/);
});

test("WorkflowRunPanel shows a progress bar and inline step details", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  const styles = read("../styles.css");
  assert.match(src, /workflow-progress-bar/);
  assert.match(src, /workflow-progress-fill/);
  assert.match(src, /WorkflowPhaseList/);
  assert.match(styles, /\.workflow-run-panel\s*\{[^}]*max-height:/s);
  assert.match(styles, /\.workflow-run-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.workflow-steps-antd\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.workflow-steps-antd\s*\{[^}]*min-height:\s*0/s);
  // approve gate button merged into the run-actions row
  assert.match(src, /workflow\.approveGate/);
  // separate details-card removed
  assert.doesNotMatch(src, /workflow-step-details-card/);
});

test("WorkflowPhaseList renders inline step details for the selected step", () => {
  const src = read("../src/components/Workflows/WorkflowPhaseList.tsx");
  assert.match(src, /WorkflowStepDetails/);
  assert.match(src, /selectedStepId/);
  assert.match(src, /workflowPhaseTitle\(phase, t\)/);
  assert.match(src, /workflowStepTitle\(step, t\)/);
});

test("WorkflowStepDetails renders retry when the selected step is retryable", () => {
  const src = read("../src/components/Workflows/WorkflowStepDetails.tsx");
  assert.match(src, /canRetry \? canRetry\(step\) : step\.status === "failed"/);
  assert.match(src, /workflow-retry-button/);
  assert.match(src, /workflowStepTitle\(step, t\)/);
});

test("WorkflowRunPanel allows retry for stopped stale running steps", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /step\.status === "blocked"/);
  assert.match(src, /step\.status === "running" && !isLive/);
  assert.match(src, /canRetry=\{canRetryStep\}/);
});

test("ReviewLoopSummary renders final status text", () => {
  const src = read("../src/components/Workflows/ReviewLoopSummary.tsx");
  assert.match(src, /workflow-summary-card/);
  assert.match(src, /workflow\.status\./);
  assert.match(src, /run\.summary/);
});

test("WorkspacePanel mounts the WorkflowRunPanel", () => {
  const src = read("../src/components/CLI/WorkspacePanel.tsx");
  assert.match(src, /import \{ WorkflowRunPanel \}/);
  assert.match(src, /<WorkflowRunPanel/);
});

test("WorkspacePanel syncs the run-state card with replay frames", () => {
  const src = read("../src/components/CLI/WorkspacePanel.tsx");
  assert.match(src, /useReplayStore/);
  assert.match(src, /const replayFrame =[\s\S]*?replayFrames\[replayIndex\]/);
  assert.match(src, /const displayMessages = replayFrame[\s\S]*?messages\.slice\(0, replayFrame\.messageIndex \+ 1\)[\s\S]*?: messages/);
  assert.match(src, /const displayLive = replayFrame \? undefined : live/);
  assert.match(src, /const displayRun = replayWorkflow\?\.run \?\? activeRun/);
  assert.match(src, /!replayFrame &&[\s\S]*?isTeamRun/);
  assert.match(src, /const end = replayWorkflow\?\.at[\s\S]*?Date\.parse\(replayWorkflow\.at\)/);
});

test("WorkflowStepRow shows the agent avatar inline", () => {
  const src = read("../src/components/Workflows/WorkflowStepRow.tsx");
  assert.match(src, /AgentAvatar/);
  assert.match(src, /workflow-step-agent-avatar/);
});

test("ChatView wires the team-mode trigger and plan preview", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /useWorkflowStore/);
  assert.match(src, /previewTeam/);
  assert.match(src, /teamMode/);
});

test("ChatView renders workflow approval decisions in the chat stream", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  const css = read("../styles.css");
  assert.match(src, /WorkflowApprovalCard/);
  assert.match(src, /pendingManualGatePhaseId/);
  assert.match(src, /workflowGateIsActionable/);
  assert.match(src, /activeRun\?\.status === "blocked"/);
  assert.doesNotMatch(src, /pendingWriteApprovalPhaseId/);
  assert.doesNotMatch(src, /approvalCardTitle/);
  assert.doesNotMatch(src, /workflow-approval-avatar/);
  assert.doesNotMatch(css, /workflow-approval-avatar/);
  assert.match(src, /workflow-approval-spacer/);
  assert.match(src, /workflow-approval-card/);
  assert.match(src, /approvedWorkflowGate/);
  assert.match(src, /workflowGateApprovedLocally/);
  assert.match(src, /setApprovedWorkflowGate/);
  assert.match(src, /then\(\(ok\) =>/);
  assert.match(css, /\.workflow-approval-spacer\s*\{[^}]*flex:\s*0 0 16px/s);
  assert.doesNotMatch(css, /\.workflow-approval-msg\s*\{[^}]*margin-left/s);
  assert.match(src, /requestGateChanges/);
  assert.match(src, /requestChangesPlaceholder/);
  assert.match(css, /\.workflow-approval-card/);
});

test("workflow store follows approval progress after acknowledging a gate", () => {
  const src = read("../src/store/workflowStore.ts");
  assert.match(src, /approveGate\(runId: string, phaseId: string\): Promise<boolean>/);
  assert.match(src, /const ok = await workflowClient\.approveGate\(\{ runId, phaseId \}\)/);
  assert.match(src, /if \(!ok\) return false/);
  assert.match(src, /await delay\(250\)/);
  assert.match(src, /activeRun\.status !== "paused"/);
  assert.match(src, /return true/);
});

test("new-task page exposes mode tabs and team submit", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /taskMode=\{taskMode\}/);
  assert.match(src, /onTaskMode=\{/);
  assert.match(src, /onSubmit=\{\(\) => void onCreateAndSend\(\)\}/);
  assert.match(src, /new-task-mode-tabs/);
});

test("ConversationList includes workflow runs in the running indicator set", () => {
  const src = read("../src/components/CLI/ConversationList.tsx");
  const css = read("../styles.css");
  assert.match(src, /useWorkflowStore/);
  assert.match(src, /workflowActiveRuns/);
  assert.match(src, /loadWorkflowActiveRuns/);
  assert.match(src, /workflowRunningSet\.has\(c\.id\)/);
  assert.match(src, /isWorkflowRunning=\{workflowRunningSet\.has\(c\.id\)\}/);
  assert.match(src, /conv-running-dot\$\{isWorkflowRunning \? " workflow" : ""\}/);
  assert.match(css, /\.conv-running-dot\.workflow/);
  assert.match(css, /--fb-workflow/);
});

test("ChatView titles team workflow conversations from the prompt", () => {
  const src = read("../src/components/CLI/ChatView.tsx");
  assert.match(src, /buildConversationTitle\(\{\s*prompt,\s*attachmentName: attachmentsToSend\[0\]\?\.name,\s*fallback: team\.name/s);
  assert.match(src, /attachmentName: attachmentsToSend\[0\]\?\.name/);
  assert.match(src, /buildConversationTitle\(\{\s*prompt: pendingTeamPreview\.goal,\s*fallback: pendingTeamPreview\.teamName/s);
  assert.doesNotMatch(src, /title: \(prompt \|\| team\.name\)\.slice\(0, 24\)/);
  assert.doesNotMatch(src, /title: \(pendingTeamPreview\.goal \|\| pendingTeamPreview\.teamName/);
});

test("workflow i18n keys exist in both locales", () => {
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  for (const key of ["mode", "normalMode", "run", "cancel", "summary", "progress", "gates", "risk", "runningIndicator", "phaseTitles", "stepTitles", "approvalCardEyebrow", "approvalCardBody", "requestChanges", "requestChangesPlaceholder"]) {
    assert.ok(en.workflow?.[key], `missing en workflow.${key}`);
    assert.ok(zh.workflow?.[key], `missing zh-CN workflow.${key}`);
  }
  for (const teamId of ["team-delivery-example", "team-root-cause-analysis", "team-research-report"]) {
    assert.ok(en.workflow.builtinTeams?.[teamId]?.name, `missing en workflow.builtinTeams.${teamId}.name`);
    assert.ok(en.workflow.builtinTeams?.[teamId]?.description, `missing en workflow.builtinTeams.${teamId}.description`);
    assert.ok(zh.workflow.builtinTeams?.[teamId]?.name, `missing zh-CN workflow.builtinTeams.${teamId}.name`);
    assert.ok(zh.workflow.builtinTeams?.[teamId]?.description, `missing zh-CN workflow.builtinTeams.${teamId}.description`);
  }
  assert.ok(en.workflow.status?.running);
  assert.ok(zh.workflow.status?.running);
  assert.ok(en.workflow.stepStatus?.failed);
  assert.ok(zh.workflow.stepStatus?.failed);
  assert.ok(en.workflow.phaseTitles?.plan);
  assert.ok(zh.workflow.phaseTitles?.plan);
  assert.ok(en.workflow.stepTitles?.["plan-delivery"]);
  assert.ok(zh.workflow.stepTitles?.["plan-delivery"]);
  assert.ok(en.workflow.stepTitles?.["summarize-delivery"]);
  assert.ok(zh.workflow.stepTitles?.["summarize-delivery"]);
});

test("WorkflowRunPanel translates workflow run names", () => {
  const src = read("../src/components/Workflows/WorkflowRunPanel.tsx");
  assert.match(src, /workflowRunName/);
  assert.match(src, /workflow\.builtinTeams\.team-delivery-example\.name/);
  assert.match(src, /workflow\.builtinTeams\.team-research-report\.name/);
  assert.match(src, /workflow\.implementReviewLoop/);
});

test("Settings page opens with CLI agents before General", () => {
  const src = read("../src/components/Settings/SettingsModal.tsx");
  assert.match(src, /initialTab = "cli"/);
  assert.match(src, /useState<SettingsTab>\(initialTab\)/);
  assert.match(src, /export function SettingsPage/);
  assert.match(src, /export const SETTINGS_TABS[\s\S]*key: "cli"[\s\S]*key: "workflowTeams"[\s\S]*key: "general"/);
});

test("MessageBubble supports right-click and inline copy button", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  const css = read("../styles.css");
  assert.match(src, /onContextMenu=\{handleContextMenu\}/);
  assert.match(src, /navigator\.clipboard\?\.writeText/);
  assert.match(src, /message\.copySelection/);
  assert.match(src, /getSelectionText/);
  assert.match(src, /copyableItemText/);
  assert.match(src, /item\.kind === "text" \|\| item\.kind === "raw"/);
  const copyableHelper = src.match(/function copyableItemText[\s\S]*?function messageText/)?.[0] ?? src;
  assert.doesNotMatch(copyableHelper, /tool-call/);
  assert.match(src, /showActionBar = message\.role === "assistant" && message\.status === "done"/);
  assert.match(src, /msg-actions/);
  assert.match(src, /msg-action-btn/);
  assert.match(src, /<Copy className="msg-action-icon"/);
  assert.match(src, /<Check className="msg-action-icon"/);
  assert.match(src, /<ThumbsUp className="msg-action-icon"/);
  assert.match(src, /<ThumbsDown className="msg-action-icon"/);
  assert.match(src, /message\.upvote/);
  assert.match(src, /message\.downvote/);
  assert.match(css, /\.message-context-menu/);
  assert.match(css, /\.msg-actions/);
  assert.match(css, /\.msg-action-btn\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/);
  assert.match(css, /\.msg-action-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?flex:\s*0 0 16px;/);
  assert.doesNotMatch(css, /msg-content-wrapper:hover \.msg-actions/);
});

test("MessageBubble compacts execution process while preserving final text", () => {
  const src = read("../src/components/CLI/MessageBubble.tsx");
  const css = read("../styles.css");
  const en = JSON.parse(read("../src/locales/en.json"));
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  assert.match(src, /function StreamProcessGroup/);
  assert.match(src, /const hasRunning = blocks\.some\(blockIsRunning\)/);
  assert.doesNotMatch(src, /messageStatus=\{message\.status\}/);
  assert.match(src, /countProcessActivity/);
  assert.match(src, /countProcessOutcomes/);
  assert.match(src, /formatOutcomeSummary/);
  assert.match(src, /if \(counts\.failed <= 0\) \{\s*return "";\s*\}/);
  assert.match(src, /parts\.join\(" \/ "\)/);
  assert.match(src, /stream-process-outcome/);
  assert.match(src, /<span className="stream-process-outcome">\{outcomeSummary\}<\/span>/);
  assert.doesNotMatch(src, /displaySummary/);
  assert.match(src, /dominantActivityIcon/);
  assert.match(src, /if \(counts\.edit > 0\) return SquarePen/);
  assert.match(src, /if \(counts\.command > 0\) return SquareTerminal/);
  assert.match(src, /function buildDisplaySections/);
  assert.match(src, /function isProcessBlock/);
  assert.match(src, /section\.kind === "process"/);
  assert.match(src, /renderMessageBlock\(section\.block, `block-\$\{i\}`\)/);
  assert.match(src, /<StreamItem key=\{key\} item=\{block\.item\} \/>/);
  assert.match(src, /stream-process-running-text/);
  assert.match(src, /stream-process-title-separator/);
  assert.doesNotMatch(src, /open=\{hasIssue \? true : undefined\}/);
  assert.doesNotMatch(src, /activityNeedsAttention/);
  assert.doesNotMatch(src, /hasIssue \? " failed" : ""/);
  assert.doesNotMatch(src, /item\.kind === "command-output" && item\.stream === "stderr"/);
  assert.doesNotMatch(src, /open=\{hasRunning \|\| hasIssue \? true : undefined\}/);
  assert.doesNotMatch(src, /stream-process-head/);
  assert.doesNotMatch(src, /stream-process-recent/);
  assert.match(css, /\.stream-process\s*\{/);
  assert.match(css, /\.stream-process > summary\s*\{/);
  assert.match(css, /\.stream-process > summary::after\s*\{/);
  assert.match(css, /\.stream-process\[open\] > summary::after\s*\{/);
  assert.doesNotMatch(css, /\.stream-process summary::after\s*\{/);
  assert.doesNotMatch(css, /\.stream-process\[open\] summary::after\s*\{/);
  assert.match(css, /\.stream-process-title\s*\{/);
  assert.match(css, /\.stream-process-title\s*\{[\s\S]*?display:\s*inline-flex;/);
  assert.match(css, /\.stream-process-outcome\s*\{[\s\S]*?color:\s*#9fa7b2;[\s\S]*?font-size:\s*inherit;[\s\S]*?font-weight:\s*600;/);
  assert.doesNotMatch(css, /\.stream-process-outcome::before/);
  assert.match(css, /\.stream-process\.running \.stream-process-running-text\s*\{/);
  assert.doesNotMatch(css, /\.stream-process\.running \.stream-process-title\s*\{/);
  assert.doesNotMatch(css, /\.stream-process\.failed/);
  assert.match(css, /stream-process-title-shimmer/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.stream-process-icon\s*\{[\s\S]*?width:\s*16px;[\s\S]*?height:\s*16px;[\s\S]*?flex:\s*0 0 16px;/);
  assert.equal(en.stream.activityEditedFiles_one, "Edited {{count}} file");
  assert.equal(en.stream.activitySucceeded_one, "{{count}} succeeded");
  assert.equal(en.stream.activityFailed_one, "{{count}} failed");
  assert.equal(zh.stream.activitySucceeded, "成功 {{count}} 次");
  assert.equal(zh.stream.activityFailed, "失败 {{count}} 次");
  assert.equal(zh.stream.activityRanCommands, "已运行 {{count}} 条命令");
});

test("AgentBridgeListener keeps status/error events out of chat history", () => {
  const src = read("../src/components/AgentBridge/AgentBridgeListener.tsx");
  assert.match(src, /if \(action === "status"\)/);
  assert.match(src, /if \(action === "error"\)/);
  assert.doesNotMatch(src, /appendBridgeMessage/);
  assert.doesNotMatch(src, /role: "system"/);
  assert.doesNotMatch(src, /appendMessage/);
});

test("DraftCanvas renders markdown, document, pdf, and image targets without iframe", () => {
  const src = read("../src/components/Draft/DraftCanvas.tsx");
  const toolbarSrc = read("../src/components/Draft/DraftToolbar.tsx");
  const css = read("../styles.css");
  assert.match(src, /isMarkdownTarget/);
  assert.match(src, /MarkdownText/);
  assert.match(src, /readDraftMarkdown/);
  assert.match(src, /isDocumentTarget/);
  assert.match(src, /DocumentText/);
  assert.match(src, /draft-document-wrap/);
  assert.match(src, /isPdfTarget/);
  assert.match(src, /#view=FitH&navpanes=0/);
  assert.match(src, /draft-pdf/);
  assert.match(src, /type="application\/pdf"/);
  assert.match(src, /isImageDraftTarget/);
  assert.match(src, /draft-image-wrap/);
  assert.match(src, /onImageWheel/);
  assert.match(src, /onWheel=\{onImageWheel\}/);
  assert.match(src, /event\.preventDefault\(\)/);
  assert.match(src, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(src, /MAX_IMAGE_ZOOM = 8/);
  assert.doesNotMatch(src, /useEffect\(\(\) => \{\s*setPan\(\{ x: 0, y: 0 \}\);\s*\}, \[zoom\]\)/);
  assert.match(toolbarSrc, /MAX_ZOOM = 8/);
  assert.match(toolbarSrc, /isRemoteHttpUrl\(url\)/);
  assert.match(toolbarSrc, /window\.open\(url, "_blank", "noopener,noreferrer"\)/);
  assert.match(src, /translate\(\$\{pan\.x\}px, \$\{pan\.y\}px\) scale\(\$\{zoom\}\)/);
  assert.doesNotMatch(src, /\bzoom,\n\s*transform: `translate/);
  assert.match(src, /draft-markdown-wrap/);
  assert.match(css, /\.draft-image-wrap/);
  assert.match(css, /\.draft-markdown-wrap/);
  assert.match(css, /\.draft-document-text/);
  assert.match(css, /\.draft-pdf/);
});

test("conversationStore routes workflow follow-ups to the workflow summary agent", () => {
  const src = read("../src/store/conversationStore.ts");
  const chat = read("../src/components/CLI/ChatView.tsx");
  const types = read("../src/services/workflows/types.ts");
  assert.match(types, /function workflowFollowupAgentId/);
  assert.match(types, /step\.mode === "summarize"/);
  assert.match(types, /step\.mode !== "write"/);
  assert.match(src, /workflowRunForConversation/);
  assert.match(src, /memberForWorkflowFollowup\(workflowRun, get\(\)\.members\)/);
  assert.match(src, /workflow-followup:\$\{run\.id\}:\$\{member\.id\}/);
  assert.match(src, /workflowFollowupContextForRun\(workflowRun\)/);
  assert.match(src, /conversation:\$\{conv\.id\}/);
  assert.doesNotMatch(src, /: conv\.cwd \?\? `conversation:\$\{conv\.id\}`/);
  assert.match(chat, /workflowFollowupAgentId\(activeRun\)/);
  assert.match(chat, /workflowFollowupAgent \?\? conv\.agentId/);
  assert.match(chat, /resolveWorkflowFollowupMember/);
  assert.match(chat, /await workflowClient\.listRuns\(conv\.id\)/);
  assert.match(chat, /preflightMember\(targetMember\)/);
});
