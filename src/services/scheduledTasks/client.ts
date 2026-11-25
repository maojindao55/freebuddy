import type {
  ScheduledTask,
  ScheduledTaskAgent,
  ScheduledTaskDispatchClaimResult,
  ScheduledTaskDispatchOutcome,
  ScheduledTaskInput,
  ScheduledTaskMutationResult,
  ScheduledTaskRun
} from "./types";

function api() {
  const scheduledTasks = window.freebuddy?.scheduledTasks;
  if (!scheduledTasks) throw new Error("scheduled tasks bridge unavailable");
  return scheduledTasks;
}

export const scheduledTasksClient = {
  isAvailable(): boolean {
    return Boolean(window.freebuddy?.scheduledTasks);
  },
  list(): Promise<ScheduledTask[]> {
    return api().list();
  },
  listRuns(taskId: string): Promise<ScheduledTaskRun[]> {
    return api().listRuns(taskId);
  },
  listAgents(): Promise<ScheduledTaskAgent[]> {
    return api().listAgents();
  },
  create(input: ScheduledTaskInput): Promise<ScheduledTaskMutationResult> {
    return api().create(input);
  },
  update(id: string, input: ScheduledTaskInput): Promise<ScheduledTaskMutationResult> {
    return api().update({ id, input });
  },
  delete(id: string, options?: { preserveAttachments?: boolean }): Promise<boolean> {
    return api().delete(id, options);
  },
  run(id: string): Promise<boolean> {
    return api().run(id);
  },
  claimDispatch(
    id: string,
    options?: { force?: boolean }
  ): Promise<ScheduledTaskDispatchClaimResult> {
    return api().claimDispatch(id, options);
  },
  completeDispatch(args: {
    id: string;
    claimToken: string;
    outcome: ScheduledTaskDispatchOutcome;
    error?: string;
    preserveAttachments?: boolean;
  }): Promise<boolean> {
    return api().completeDispatch(args);
  },
  markWaiting(id: string): Promise<boolean> {
    return api().markWaiting(id);
  },
  onChanged(cb: (task?: ScheduledTask) => void): (() => void) | undefined {
    return window.freebuddy?.scheduledTasks?.onChanged?.(cb);
  }
};
