import type {
  ScheduledTask,
  ScheduledTaskAgent,
  ScheduledTaskInput,
  ScheduledTaskMutationResult
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
  listAgents(): Promise<ScheduledTaskAgent[]> {
    return api().listAgents();
  },
  create(input: ScheduledTaskInput): Promise<ScheduledTaskMutationResult> {
    return api().create(input);
  },
  update(id: string, input: ScheduledTaskInput): Promise<ScheduledTaskMutationResult> {
    return api().update({ id, input });
  },
  delete(id: string): Promise<boolean> {
    return api().delete(id);
  },
  run(id: string): Promise<boolean> {
    return api().run(id);
  },
  onChanged(cb: (task?: ScheduledTask) => void): () => void {
    return api().onChanged(cb);
  }
};
