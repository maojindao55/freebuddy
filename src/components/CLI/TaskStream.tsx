import { useEffect, useRef } from "react";

import { useCliTaskStore, type CliTaskState } from "@/store/cliTaskStore";
import { StreamItem } from "./StreamItem";

export function TaskStream({ task }: { task: CliTaskState }) {
  const kill = useCliTaskStore((s) => s.kill);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [task.items.length]);

  const isLive = task.status === "starting" || task.status === "running";

  return (
    <div className="task-stream">
      <header className="task-stream-header">
        <div>
          <strong>
            {task.agentName} <span className="muted">/ {task.adapter}</span>
          </strong>
          <span className={`status-pill ${task.status}`}>{task.status}</span>
          {task.resumedFromSessionId && (
            <span className="resume-hint" title={task.resumedFromSessionId}>
              resumed
            </span>
          )}
        </div>
        <div className="task-stream-actions">
          {isLive && (
            <button onClick={() => void kill(task.sessionId)}>Stop</button>
          )}
        </div>
      </header>

      {task.cwd && (
        <div className="task-meta">
          cwd: <code>{task.cwd}</code>
        </div>
      )}

      <div className="task-prompt">
        <span>prompt</span>
        <pre>{task.prompt}</pre>
      </div>

      <div className="task-items" ref={scrollRef}>
        {task.items.map((item, i) => (
          <StreamItem key={i} item={item} />
        ))}
        {task.items.length === 0 && isLive && (
          <div className="muted">Waiting for output…</div>
        )}
      </div>
    </div>
  );
}
