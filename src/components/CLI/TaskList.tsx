import { useCliTaskStore } from "@/store/cliTaskStore";
import { TaskStream } from "./TaskStream";

export function TaskList() {
  const tasks = useCliTaskStore((s) => s.tasks);
  const order = useCliTaskStore((s) => s.taskOrder);
  const clearFinished = useCliTaskStore((s) => s.clearFinished);

  const live = order.filter((id) => {
    const t = tasks[id];
    return t && (t.status === "starting" || t.status === "running");
  });
  const finished = order.filter((id) => !live.includes(id));

  return (
    <div className="task-list">
      <div className="task-list-header">
        <strong>CLI Tasks</strong>
        <span className="muted">
          {live.length} running · {finished.length} finished
        </span>
        {finished.length > 0 && (
          <button onClick={clearFinished}>Clear finished</button>
        )}
      </div>
      {order.length === 0 && (
        <div className="muted task-empty">
          Run a CLI agent above to see the structured stream here.
        </div>
      )}
      {order.map((id) => {
        const t = tasks[id];
        return t ? <TaskStream key={id} task={t} /> : null;
      })}
    </div>
  );
}
