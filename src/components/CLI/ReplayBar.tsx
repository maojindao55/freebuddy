import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, RotateCcw, Square } from "lucide-react";

import type { ConversationMessage } from "@/services/cli/types";
import { pendingManualGatePhaseId } from "@/services/workflows/planning";
import type {
  WorkflowPlan,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStepRow,
  WorkflowStepStatus
} from "@/services/workflows/types";
import { useConversationStore } from "@/store/conversationStore";
import {
  REPLAY_BASE_INTERVAL_MS,
  REPLAY_TYPING_INTERVAL_MS,
  splitTextSteps,
  useReplayStore,
  type ReplayWorkflowSnapshot,
  type ReplayFrame
} from "@/store/replayStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { computeMessageBlocks } from "./messageBlocks";

const REPLAY_FIXED_SPEED = 1.5;
const EMPTY_MESSAGES: ConversationMessage[] = [];
const WORKFLOW_REPLAY_BLOCKED_STATUSES = new Set<WorkflowRunStatus>([
  "running",
  "paused",
  "blocked"
]);

interface WorkflowReplaySource {
  conversationId: string;
  run: WorkflowRunRow | null;
  steps: WorkflowStepRow[];
}

const WORKFLOW_TERMINAL_OK = new Set<WorkflowStepStatus>(["done", "skipped"]);

function sanitizePendingStep(step: WorkflowStepRow): WorkflowStepRow {
  return {
    ...step,
    status: "pending",
    summary: undefined,
    resultJson: undefined,
    cliTaskId: undefined,
    startedAt: undefined,
    endedAt: undefined
  };
}

function statusFromWorkflowMessage(
  message: ConversationMessage,
  complete: boolean
): WorkflowStepStatus {
  if (!complete) return "running";
  if (message.status === "failed" || message.status === "killed") return "failed";
  if (message.status === "done" || message.status === "sent") return "done";
  return "running";
}

function parseWorkflowPlan(run: WorkflowRunRow): WorkflowPlan | null {
  try {
    return JSON.parse(run.planJson) as WorkflowPlan;
  } catch {
    return null;
  }
}

function deriveReplayRunStatus(
  run: WorkflowRunRow,
  plan: WorkflowPlan | null,
  steps: WorkflowStepRow[]
): WorkflowRunStatus {
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "failed" || step.status === "blocked")) {
    return run.status === "failed" ? "failed" : "blocked";
  }
  if (
    plan &&
    pendingManualGatePhaseId(
      plan.phases,
      steps.map((step) => ({ stepId: step.stepId, status: step.status }))
    )
  ) {
    return "paused";
  }
  if (steps.length > 0 && steps.every((step) => WORKFLOW_TERMINAL_OK.has(step.status))) {
    return run.status;
  }
  return run.status === "pending_approval" ? "pending_approval" : "running";
}

function buildWorkflowSnapshot(
  messages: ConversationMessage[],
  frame: ReplayFrame,
  source?: WorkflowReplaySource
): ReplayWorkflowSnapshot | undefined {
  if (
    !source?.run ||
    source.run.conversationId !== source.conversationId ||
    source.steps.length === 0
  ) {
    return undefined;
  }

  const steps = source.steps.map(sanitizePendingStep);
  const stepIndexById = new Map(steps.map((step, index) => [step.id, index]));

  const applyMessage = (message: ConversationMessage | undefined, complete: boolean) => {
    if (
      !message?.workflowStepRowId ||
      message.workflowRunId !== source.run?.id
    ) {
      return;
    }
    const index = stepIndexById.get(message.workflowStepRowId);
    if (index == null) return;
    const original = source.steps[index];
    const status = statusFromWorkflowMessage(message, complete);
    const terminal = status === "done" || status === "failed" || status === "skipped";
    steps[index] = {
      ...original,
      status,
      summary: terminal ? original.summary : undefined,
      resultJson: terminal ? original.resultJson : undefined,
      endedAt: terminal ? original.endedAt : undefined
    };
  };

  for (let i = 0; i < frame.messageIndex; i += 1) {
    applyMessage(messages[i], true);
  }
  applyMessage(messages[frame.messageIndex], frame.messageComplete === true);

  const plan = parseWorkflowPlan(source.run);
  const status = deriveReplayRunStatus(source.run, plan, steps);
  const complete = steps.length > 0 && steps.every((step) => WORKFLOW_TERMINAL_OK.has(step.status));
  const currentMessage = messages[frame.messageIndex];
  const at = frame.messageComplete === true
    ? currentMessage?.updatedAt
    : currentMessage?.createdAt;
  return {
    run: {
      ...source.run,
      status,
      summary: complete ? source.run.summary : undefined,
      endedAt: complete ? source.run.endedAt : undefined
    },
    steps,
    at
  };
}

function withWorkflowSnapshot(
  frame: ReplayFrame,
  messages: ConversationMessage[],
  source?: WorkflowReplaySource
): ReplayFrame {
  const workflow = buildWorkflowSnapshot(messages, frame, source);
  return workflow ? { ...frame, workflow } : frame;
}

function buildReplayFrames(
  messages: ConversationMessage[],
  workflow?: WorkflowReplaySource
): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  messages.forEach((message, idx) => {
    if (message.role === "assistant") {
      const blocks = computeMessageBlocks(message.content);
      if (blocks.length === 0) {
        frames.push(
          withWorkflowSnapshot(
            { messageIndex: idx, messageComplete: true },
            messages,
            workflow
          )
        );
        return;
      }
      blocks.forEach((block, bi) => {
        const blockLimit = bi + 1;
        const isLastBlock = blockLimit === blocks.length;
        if (block.kind === "single") {
          const item = block.item;
          if (item.kind === "text" || item.kind === "raw") {
            const steps = splitTextSteps(item.content);
            if (steps.length === 0) {
              frames.push(
                withWorkflowSnapshot(
                  { messageIndex: idx, blockLimit, messageComplete: isLastBlock },
                  messages,
                  workflow
                )
              );
            } else {
              for (let si = 0; si < steps.length; si += 1) {
                const chars = steps[si];
                frames.push(
                  withWorkflowSnapshot(
                    {
                      messageIndex: idx,
                      blockLimit,
                      typingChars: chars,
                      messageComplete: isLastBlock && si === steps.length - 1
                    },
                    messages,
                    workflow
                  )
                );
              }
            }
            return;
          }
        }
        frames.push(
          withWorkflowSnapshot(
            { messageIndex: idx, blockLimit, messageComplete: isLastBlock },
            messages,
            workflow
          )
        );
      });
    } else {
      frames.push(
        withWorkflowSnapshot(
          { messageIndex: idx, messageComplete: true },
          messages,
          workflow
        )
      );
    }
  });
  return frames;
}

export function TitlebarOverflowMenu() {
  const { t } = useTranslation();
  const activeId = useConversationStore((s) => s.activeId);
  const messages = useConversationStore((s) =>
    activeId ? s.messages[activeId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES
  );
  const running = useConversationStore((s) =>
    activeId
      ? s.live[activeId]?.status === "running" ||
        s.live[activeId]?.status === "starting"
      : false
  );
  const activeRun = useWorkflowStore((s) => s.activeRun);
  const workflowSteps = useWorkflowStore((s) => s.steps);
  const replayConvId = useReplayStore((s) => s.conversationId);
  const index = useReplayStore((s) => s.index);
  const frames = useReplayStore((s) => s.frames);
  const playing = useReplayStore((s) => s.playing);
  const start = useReplayStore((s) => s.start);
  const stop = useReplayStore((s) => s.stop);
  const next = useReplayStore((s) => s.next);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const replaying = replayConvId === activeId && replayConvId !== null;
  const workflowBlocksReplay =
    activeRun != null &&
    activeRun.conversationId === activeId &&
    WORKFLOW_REPLAY_BLOCKED_STATUSES.has(activeRun.status);
  const canReplay =
    Boolean(activeId) &&
    messages.length >= 2 &&
    !running &&
    !workflowBlocksReplay;

  useEffect(() => {
    if (!replaying || !playing) return;
    const current = frames[index];
    const isTyping = current?.typingChars != null;
    const base = isTyping ? REPLAY_TYPING_INTERVAL_MS : REPLAY_BASE_INTERVAL_MS;
    const interval = Math.max(16, base / REPLAY_FIXED_SPEED);
    const id = window.setInterval(() => next(), interval);
    return () => window.clearInterval(id);
  }, [replaying, playing, next, frames, index]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!activeId) return null;

  const handleReplay = () => {
    if (replaying) {
      stop();
      setOpen(false);
      return;
    }
    if (!canReplay || !activeId) return;
    const nextFrames = buildReplayFrames(messages, {
      conversationId: activeId,
      run: activeRun?.conversationId === activeId ? activeRun : null,
      steps: activeRun?.conversationId === activeId ? workflowSteps : []
    });
    start(activeId, nextFrames);
    next();
    setOpen(false);
  };

  const replayLabel = replaying ? t("chat.replay.exitShort") : t("chat.replay.entry");
  const ReplayIcon = replaying ? Square : RotateCcw;
  let replayTitle = t("chat.replay.entry");
  if (replaying) {
    replayTitle = t("chat.replay.exit");
  } else if (running) {
    replayTitle = t("chat.replay.disabledRunning");
  } else if (workflowBlocksReplay) {
    replayTitle = t("chat.replay.disabledWorkflowActive");
  } else if (messages.length < 2) {
    replayTitle = t("chat.replay.disabledEmpty");
  }

  return (
    <div
      className={`titlebar-overflow${open ? " open" : ""}${replaying ? " replaying" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="titlebar-overflow-trigger"
        aria-label={t("chat.titlebarMore")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("chat.titlebarMore")}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="titlebar-overflow-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`titlebar-overflow-item${replaying ? " replaying" : ""}`}
            disabled={!replaying && !canReplay}
            aria-pressed={replaying}
            aria-label={replaying ? t("chat.replay.exit") : t("chat.replay.entry")}
            title={replayTitle}
            onClick={handleReplay}
          >
            <ReplayIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{replayLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** @deprecated Prefer TitlebarOverflowMenu. */
export function ReplayButton() {
  return <TitlebarOverflowMenu />;
}
