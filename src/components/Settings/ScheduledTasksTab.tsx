import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  FolderOpen,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
  X,
  XCircle
} from "lucide-react";

import { cliClient } from "@/services/cli/client";
import type { SessionConfigOption, SessionConfigProbeInput } from "@/services/cli/types";
import { scheduledTasksClient } from "@/services/scheduledTasks/client";
import type {
  ScheduledTask,
  ScheduledTaskAgent,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskScheduleType
} from "@/services/scheduledTasks/types";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_KEYS: Record<number, string> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat"
};

function localDateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function blankInput(agentId = ""): ScheduledTaskInput {
  return {
    title: "",
    prompt: "",
    agentId,
    scheduleType: "daily",
    timeLocal: "08:00",
    scheduleDate: localDateAfter(1),
    weekdays: [1, 2, 3, 4, 5],
    monthDay: new Date().getDate(),
    cwd: undefined,
    executionMode: "new_conversation",
    enabled: true
  };
}

function inputFromTask(task: ScheduledTask): ScheduledTaskInput {
  return {
    title: task.title,
    prompt: task.prompt,
    agentId: task.agentId,
    scheduleType: task.scheduleType,
    timeLocal: task.timeLocal,
    scheduleDate: task.scheduleDate ?? localDateAfter(1),
    weekdays: task.weekdays?.length ? task.weekdays : [1, 2, 3, 4, 5],
    monthDay: task.monthDay ?? new Date().getDate(),
    cwd: task.cwd,
    configOptionOverrides: task.configOptionOverrides,
    executionMode: task.executionMode,
    enabled: task.enabled
  };
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function ScheduledTasksTab({
  onOpenConversation
}: {
  onOpenConversation?: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<ScheduledTaskAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<ScheduledTaskInput>(() => blankInput());
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsByTask, setRunsByTask] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const members = useConversationStore((state) => state.members);
  const executorsLoaded = useCliExecutorStore((state) => state.loaded);
  const executorOverrides = useCliExecutorStore((state) => state.overrides);
  const [modelOptions, setModelOptions] = useState<SessionConfigOption[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const modelProbeGenerationRef = useRef(0);

  const togglePromptExpanded = (taskId: string) => {
    setExpandedPrompts((current) => ({
      ...current,
      [taskId]: !current[taskId]
    }));
  };

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents]
  );

  const modelOption = useMemo(
    () =>
      modelOptions.find((option) => option.category === "model") ??
      modelOptions.find((option) => option.id === "model"),
    [modelOptions]
  );
  const persistedModelEntry = useMemo(
    () =>
      Object.entries(draft.configOptionOverrides ?? {}).find(
        ([id]) => id === modelOption?.id || id === "model"
      ),
    [draft.configOptionOverrides, modelOption?.id]
  );
  const selectedModelValue = modelOption
    ? draft.configOptionOverrides?.[modelOption.id] ?? ""
    : persistedModelEntry?.[1] ?? "";
  const selectableModels = useMemo(() => {
    const values = [...(modelOption?.values ?? [])];
    if (selectedModelValue && !values.some((value) => value.id === selectedModelValue)) {
      values.unshift({ id: selectedModelValue, name: selectedModelValue });
    }
    return values;
  }, [modelOption?.values, selectedModelValue]);

  const translateTaskError = (error: string): string => {
    const legacyKeys: Record<string, string> = {
      "task title is required": "scheduledTasks.errors.titleRequired",
      "task instructions are required": "scheduledTasks.errors.instructionsRequired",
      "schedule type is invalid": "scheduledTasks.errors.invalidScheduleType",
      "execution mode is invalid": "scheduledTasks.errors.invalidExecutionMode",
      "working directory must be an absolute path": "scheduledTasks.errors.absoluteWorkingDirectory",
      "run time must use HH:mm": "scheduledTasks.errors.invalidRunTime",
      "a valid run date is required": "scheduledTasks.errors.validRunDateRequired",
      "select at least one weekday": "scheduledTasks.errors.weekdayRequired",
      "month day must be between 1 and 31": "scheduledTasks.errors.invalidMonthDay",
      "one-time task must be scheduled in the future": "scheduledTasks.errors.oneTimeMustBeFuture",
      "selected agent is unavailable": "scheduledTasks.errors.agentUnavailable",
      "task not found": "scheduledTasks.errors.taskNotFound",
      "FreeBuddy window is not available": "scheduledTasks.errors.windowUnavailable",
      "FreeBuddy closed before the task completed": "scheduledTasks.errors.appClosed"
    };
    const workingDirectoryPrefix = "working directory is unavailable: ";
    if (error.startsWith(workingDirectoryPrefix)) {
      return t("scheduledTasks.errors.workingDirectoryUnavailable", {
        path: error.slice(workingDirectoryPrefix.length)
      });
    }
    const key = error.startsWith("scheduledTasks.errors.") ? error : legacyKeys[error];
    return key ? t(key) : error;
  };

  useEffect(() => {
    const generation = ++modelProbeGenerationRef.current;
    setModelOptions([]);
    setModelLoading(false);
    if (!editingId || !draft.agentId || !executorsLoaded || !cliClient.isAvailable()) return;

    const member = members.find((entry) => entry.id === draft.agentId);
    const scheduledAgent = agents.find((entry) => entry.id === draft.agentId);
    if (!member && !scheduledAgent) return;

    const timer = window.setTimeout(() => {
      const adapter = (member?.cli.adapter ??
        scheduledAgent!.adapter) as SessionConfigProbeInput["adapter"];
      const resolved = useCliExecutorStore.getState().resolve(adapter);
      const probeInput: SessionConfigProbeInput = {
        agentId: draft.agentId,
        adapter,
        binary: member?.cli.binary || resolved?.binary,
        extraArgs: [...(resolved?.extraArgs ?? []), ...(member?.cli.extraArgs ?? [])],
        env: { ...(resolved?.env ?? {}), ...(member?.cli.env ?? {}) },
        cwd: draft.cwd?.trim() || undefined
      };
      setModelLoading(true);
      void (async () => {
        let hasCachedOptions = false;
        try {
          const cached = await cliClient.getCachedSessionConfigOptions(probeInput);
          if (modelProbeGenerationRef.current !== generation) return;
          if (cached.length > 0) {
            hasCachedOptions = true;
            setModelOptions(cached);
            setModelLoading(false);
          }

          const fresh = await cliClient.inspectSessionConfigOptions(probeInput);
          if (modelProbeGenerationRef.current !== generation) return;
          if (fresh.length > 0) setModelOptions(fresh);
        } catch {
          if (modelProbeGenerationRef.current === generation && !hasCachedOptions) {
            setModelOptions([]);
          }
        } finally {
          if (modelProbeGenerationRef.current === generation) setModelLoading(false);
        }
      })();
    }, 150);

    return () => window.clearTimeout(timer);
  }, [
    agents,
    draft.agentId,
    draft.cwd,
    editingId,
    executorsLoaded,
    executorOverrides,
    members
  ]);

  const setSelectedModel = (value: string) => {
    const optionId = modelOption?.id ?? persistedModelEntry?.[0] ?? "model";
    setDraft((current) => {
      const nextOverrides = { ...(current.configOptionOverrides ?? {}) };
      if (value) nextOverrides[optionId] = value;
      else delete nextOverrides[optionId];
      return {
        ...current,
        configOptionOverrides:
          Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined
      };
    });
  };

  const load = async () => {
    if (!scheduledTasksClient.isAvailable()) return;
    const [nextTasks, nextAgents] = await Promise.all([
      scheduledTasksClient.list(),
      scheduledTasksClient.listAgents()
    ]);
    setTasks(nextTasks);
    setAgents(nextAgents);
    setDraft((current) =>
      current.agentId || !nextAgents[0]
        ? current
        : { ...current, agentId: nextAgents[0].id }
    );
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
    if (!scheduledTasksClient.isAvailable()) return;
    return scheduledTasksClient.onChanged((task) => {
      void load();
      if (task?.id && task.id === expandedId) {
        void scheduledTasksClient.listRuns(task.id).then((runs) =>
          setRunsByTask((current) => ({ ...current, [task.id]: runs }))
        );
      }
    });
  }, [expandedId]);

  const weekdayLabel = (day: number) =>
    t(`scheduledTasks.weekdays.${WEEKDAY_KEYS[day]}`);

  const formatSchedule = (task: ScheduledTask): string => {
    if (task.scheduleType === "manual") {
      return t("scheduledTasks.summary.manual");
    }
    if (task.scheduleType === "hourly") {
      return t("scheduledTasks.summary.hourly");
    }
    if (task.scheduleType === "once") {
      return t("scheduledTasks.summary.once", {
        date: task.scheduleDate,
        time: task.timeLocal
      });
    }
    if (task.scheduleType === "weekly") {
      const days = new Intl.ListFormat(undefined, {
        style: "short",
        type: "conjunction"
      }).format((task.weekdays ?? []).map(weekdayLabel));
      return t("scheduledTasks.summary.weekly", {
        days,
        time: task.timeLocal
      });
    }
    if (task.scheduleType === "monthly") {
      return t("scheduledTasks.summary.monthly", {
        day: task.monthDay,
        time: task.timeLocal
      });
    }
    if (task.scheduleType === "weekdays") {
      return t("scheduledTasks.summary.weekdays", { time: task.timeLocal });
    }
    return t("scheduledTasks.summary.daily", { time: task.timeLocal });
  };

  const toggleHistory = async (taskId: string) => {
    if (expandedId === taskId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(taskId);
    const runs = await scheduledTasksClient.listRuns(taskId);
    setRunsByTask((current) => ({ ...current, [taskId]: runs }));
  };

  const startCreate = () => {
    setEditingId("new");
    setDraft(blankInput(agents[0]?.id));
    setErrors([]);
  };

  const startEdit = (task: ScheduledTask) => {
    setEditingId(task.id);
    setDraft(inputFromTask(task));
    setErrors([]);
  };

  const save = async () => {
    setSaving(true);
    setErrors([]);
    try {
      const result =
        editingId === "new"
          ? await scheduledTasksClient.create(draft)
          : await scheduledTasksClient.update(editingId!, draft);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      await load();
      setEditingId(null);
    } catch (error) {
      setErrors([(error as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(t("scheduledTasks.deleteConfirm", { title: task.title }))) return;
    await scheduledTasksClient.delete(task.id);
    await load();
  };

  const runNow = async (task: ScheduledTask) => {
    setTasks((current) =>
      current.map((entry) =>
        entry.id === task.id ? { ...entry, lastStatus: "running" } : entry
      )
    );
    const accepted = await scheduledTasksClient.run(task.id);
    if (!accepted) await load();
  };

  const toggleEnabled = async (task: ScheduledTask) => {
    const result = await scheduledTasksClient.update(task.id, {
      ...inputFromTask(task),
      enabled: !task.enabled
    });
    if (result.ok) await load();
  };

  const setScheduleType = (scheduleType: ScheduledTaskScheduleType) => {
    setDraft({
      ...draft,
      scheduleType,
      enabled: scheduleType === "manual" ? true : draft.enabled
    });
  };

  const toggleWeekday = (day: number) => {
    const selected = draft.weekdays ?? [];
    setDraft({
      ...draft,
      weekdays: selected.includes(day)
        ? selected.filter((entry) => entry !== day)
        : [...selected, day]
    });
  };

  const chooseWorkingDirectory = async () => {
    const directory = await cliClient.selectDirectory();
    if (directory) {
      setDraft((current) => ({ ...current, cwd: directory }));
    }
  };

  if (editingId) {
    return (
      <div className="scheduled-task-editor">
        <header className="scheduled-task-editor-header">
          <button
            type="button"
            className="scheduled-task-back"
            onClick={() => setEditingId(null)}
            aria-label={t("settings.backToApp")}
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h3>
              {editingId === "new"
                ? t("scheduledTasks.createTitle")
                : t("scheduledTasks.editTitle")}
            </h3>
            <p>{t("scheduledTasks.editorDescription")}</p>
          </div>
        </header>

        {errors.length > 0 && (
          <ul className="scheduled-task-errors">
            {errors.map((error) => <li key={error}>{translateTaskError(error)}</li>)}
          </ul>
        )}

        <section className="scheduled-task-form-card">
          <div className="scheduled-task-form-layout">
            <div className="scheduled-task-form-left">
              <label>
                <span>{t("scheduledTasks.name")}</span>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })}
                  placeholder={t("scheduledTasks.namePlaceholder")}
                  maxLength={120}
                />
              </label>
              <label style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <span>{t("scheduledTasks.prompt")}</span>
                <textarea
                  style={{ flex: 1, minHeight: "260px" }}
                  value={draft.prompt}
                  onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })}
                  placeholder={t("scheduledTasks.promptPlaceholder")}
                />
              </label>
            </div>

            <div className="scheduled-task-form-right">
              <div className="scheduled-task-form-grid">
                <label>
                  <span>{t("scheduledTasks.agent")}</span>
                  <select
                    value={draft.agentId}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        agentId: event.currentTarget.value,
                        configOptionOverrides: undefined
                      })
                    }
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("scheduledTasks.model")}</span>
                  <select
                    value={selectedModelValue}
                    onChange={(event) => setSelectedModel(event.currentTarget.value)}
                    disabled={!modelOption && !persistedModelEntry}
                  >
                    <option value="">
                      {modelLoading && selectableModels.length === 0
                        ? t("scheduledTasks.modelLoading")
                        : modelOption?.currentLabel || modelOption?.currentValue
                          ? t("scheduledTasks.defaultModelNamed", {
                              model: modelOption.currentLabel ?? modelOption.currentValue
                            })
                          : t("scheduledTasks.defaultModel")}
                    </option>
                    {selectableModels.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name ?? value.id}
                      </option>
                    ))}
                  </select>
                  {!modelLoading && !modelOption && !persistedModelEntry && (
                    <small>{t("scheduledTasks.modelUnavailable")}</small>
                  )}
                </label>
                <label>
                  <span>{t("scheduledTasks.scheduleType")}</span>
                  <select
                    value={draft.scheduleType}
                    onChange={(event) =>
                      setScheduleType(event.currentTarget.value as ScheduledTaskScheduleType)
                    }
                  >
                    <option value="manual">{t("scheduledTasks.schedule.manual")}</option>
                    <option value="hourly">{t("scheduledTasks.schedule.hourly")}</option>
                    <option value="once">{t("scheduledTasks.schedule.once")}</option>
                    <option value="daily">{t("scheduledTasks.schedule.daily")}</option>
                    <option value="weekdays">{t("scheduledTasks.schedule.weekdays")}</option>
                    <option value="weekly">{t("scheduledTasks.schedule.weekly")}</option>
                    <option value="monthly">{t("scheduledTasks.schedule.monthly")}</option>
                  </select>
                </label>
                {draft.scheduleType !== "manual" && draft.scheduleType !== "hourly" && (
                  <label>
                    <span>{t("scheduledTasks.runTime")}</span>
                    <input
                      type="time"
                      value={draft.timeLocal}
                      onChange={(event) => setDraft({ ...draft, timeLocal: event.currentTarget.value })}
                    />
                  </label>
                )}
              </div>

              <label className="scheduled-task-condition-field">
                <span>{t("scheduledTasks.executionMode")}</span>
                <select
                  value={draft.executionMode}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      executionMode: event.currentTarget.value as ScheduledTaskInput["executionMode"]
                    })
                  }
                >
                  <option value="new_conversation">{t("scheduledTasks.execution.new")}</option>
                  <option value="continuous">{t("scheduledTasks.execution.continuous")}</option>
                </select>
                <small>{t(`scheduledTasks.executionHint.${draft.executionMode}`)}</small>
              </label>

              <div className="scheduled-task-workspace-field">
                <span>{t("scheduledTasks.workingDirectory")}</span>
                <div className="scheduled-task-workspace-picker">
                  <button
                    type="button"
                    className="scheduled-task-workspace-select"
                    onClick={() => void chooseWorkingDirectory()}
                    title={draft.cwd || t("scheduledTasks.selectDirectory")}
                  >
                    <FolderOpen size={14} />
                    <span>{draft.cwd || t("scheduledTasks.selectDirectory")}</span>
                  </button>
                  {draft.cwd && (
                    <button
                      type="button"
                      className="scheduled-task-workspace-clear"
                      onClick={() => setDraft({ ...draft, cwd: undefined })}
                      aria-label={t("scheduledTasks.clearDirectory")}
                      title={t("scheduledTasks.clearDirectory")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <small>{t("scheduledTasks.workingDirectoryHint")}</small>
              </div>

              {draft.scheduleType === "once" && (
                <label className="scheduled-task-condition-field">
                  <span>{t("scheduledTasks.runDate")}</span>
                  <input
                    type="date"
                    min={localDateAfter(0)}
                    value={draft.scheduleDate}
                    onChange={(event) =>
                      setDraft({ ...draft, scheduleDate: event.currentTarget.value })
                    }
                  />
                </label>
              )}

              {draft.scheduleType === "weekly" && (
                <div className="scheduled-task-weekday-field">
                  <span>{t("scheduledTasks.runWeekdays")}</span>
                  <div className="scheduled-task-weekdays">
                    {WEEKDAYS.map((day) => (
                      <button
                        key={day}
                        type="button"
                        className={(draft.weekdays ?? []).includes(day) ? "active" : ""}
                        aria-pressed={(draft.weekdays ?? []).includes(day)}
                        onClick={() => toggleWeekday(day)}
                      >
                        {weekdayLabel(day)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {draft.scheduleType === "monthly" && (
                <label className="scheduled-task-condition-field">
                  <span>{t("scheduledTasks.monthDay")}</span>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={draft.monthDay}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        monthDay: Math.max(1, Math.min(31, Number(event.currentTarget.value) || 1))
                      })
                    }
                  />
                </label>
              )}

              {draft.scheduleType !== "manual" && (
                <label className="scheduled-task-enabled">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
                  />
                  <span>{t("scheduledTasks.enabled")}</span>
                </label>
              )}
            </div>
          </div>

          <div className="scheduled-task-form-actions">
            <button type="button" className="scheduled-task-btn ghost" onClick={() => setEditingId(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="scheduled-task-btn btn-primary"
              disabled={saving || agents.length === 0}
              onClick={() => void save()}
            >
              {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
              {t("common.save")}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="scheduled-task-list">
      <header className="scheduled-task-list-header">
        <div>
          <h3>{t("scheduledTasks.title")}</h3>
          <p>{t("scheduledTasks.description")}</p>
        </div>
        <button type="button" className="primary" onClick={startCreate}>
          <Plus size={14} />
          {t("scheduledTasks.add")}
        </button>
      </header>

      <div className="scheduled-task-note">
        <CalendarClock size={15} />
        <span>{t("scheduledTasks.runningNote")}</span>
      </div>

      {loading ? (
        <div className="scheduled-task-empty"><Loader2 size={18} className="spin" /></div>
      ) : tasks.length === 0 ? (
        <div className="scheduled-task-empty">
          <div className="scheduled-task-empty-icon-wrapper">
            <Clock3 size={24} />
          </div>
          <strong>{t("scheduledTasks.emptyTitle")}</strong>
          <span>{t("scheduledTasks.emptyDescription")}</span>
          <button
            type="button"
            className="primary"
            style={{ marginTop: "12px" }}
            onClick={startCreate}
          >
            <Plus size={14} />
            {t("scheduledTasks.add")}
          </button>
        </div>
      ) : (
        <ul className="scheduled-task-items">
          {tasks.map((task) => (
            <li key={task.id} className={`scheduled-task-card ${task.enabled ? "" : "disabled"}`}>
              <div className="scheduled-task-card-main">
                <div className="scheduled-task-card-title-row">
                  <div className="scheduled-task-card-title">
                    <strong>{task.title}</strong>
                    <span className={`scheduled-task-status ${task.lastStatus ?? "idle"}`}>
                      {task.lastStatus === "running" && <Loader2 size={10} className="spin" />}
                      {task.lastStatus === "completed" && <CheckCircle2 size={10} />}
                      {task.lastStatus === "failed" && <XCircle size={10} />}
                      {t(`scheduledTasks.status.${task.lastStatus ?? "idle"}`)}
                    </span>
                  </div>
                  {task.scheduleType !== "manual" && (
                    <label className="scheduled-task-switch" title={t("scheduledTasks.enabled")}>
                      <input
                        type="checkbox"
                        checked={task.enabled}
                        onChange={() => void toggleEnabled(task)}
                      />
                      <span />
                    </label>
                  )}
                </div>

                <div
                  className="scheduled-task-prompt-container"
                  onClick={() => togglePromptExpanded(task.id)}
                  title={t("scheduledTasks.promptToggle")}
                >
                  <div className={`scheduled-task-prompt-text ${expandedPrompts[task.id] ? "expanded" : ""}`}>
                    {task.prompt}
                  </div>
                  {task.prompt.length > 90 && (
                    <div className="scheduled-task-prompt-expand-btn">
                      <span>
                        {expandedPrompts[task.id]
                          ? t("scheduledTasks.promptCollapse")
                          : t("scheduledTasks.promptExpand")}
                      </span>
                    </div>
                  )}
                </div>

                <div className="scheduled-task-meta">
                  <span className="scheduled-task-chip schedule-chip">
                    <Clock3 size={11} />
                    {formatSchedule(task)}
                  </span>
                  <span className="scheduled-task-chip agent-chip">
                    <Bot size={11} />
                    {t("scheduledTasks.agentValue", { agent: agentNames.get(task.agentId) ?? task.agentId })}
                  </span>
                  <span className="scheduled-task-chip">
                    <MessageSquare size={11} />
                    {t(`scheduledTasks.execution.${task.executionMode === "continuous" ? "continuous" : "new"}`)}
                  </span>
                  {task.cwd && (
                    <span className="scheduled-task-chip scheduled-task-workspace-meta" title={task.cwd}>
                      <FolderOpen size={11} />
                      {task.cwd}
                    </span>
                  )}
                  {task.scheduleType !== "manual" && (
                    <span className="scheduled-task-chip">
                      <CalendarClock size={11} />
                      {t("scheduledTasks.nextRun", { time: formatDate(task.nextRunAt) })}
                    </span>
                  )}
                </div>
                {task.lastError && (
                  <p className="scheduled-task-error">{translateTaskError(task.lastError)}</p>
                )}
              </div>

              <div className="scheduled-task-card-actions">
                <div className="scheduled-task-action-group-left">
                  <button
                    type="button"
                    className="scheduled-task-btn btn-primary"
                    disabled={task.lastStatus === "running"}
                    onClick={() => void runNow(task)}
                  >
                    <Play size={11} fill="currentColor" />
                    {t("scheduledTasks.runNow")}
                  </button>
                  {task.lastConversationId && (
                    <button
                      type="button"
                      className="scheduled-task-btn btn-link"
                      onClick={() => onOpenConversation?.(task.lastConversationId!)}
                    >
                      <ExternalLink size={11} />
                      {t("scheduledTasks.openResult")}
                    </button>
                  )}
                </div>
                <div className="scheduled-task-action-group-right">
                  <button
                    type="button"
                    className="scheduled-task-btn"
                    onClick={() => void toggleHistory(task.id)}
                  >
                    <History size={11} />
                    {t("scheduledTasks.history")}
                    {expandedId === task.id ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  </button>
                  <button
                    type="button"
                    className="scheduled-task-btn btn-icon"
                    onClick={() => startEdit(task)}
                    aria-label={t("common.edit")}
                    title={t("common.edit")}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    className="scheduled-task-btn btn-icon btn-danger"
                    disabled={task.lastStatus === "running"}
                    onClick={() => void remove(task)}
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>

              {expandedId === task.id && (
                <div className="scheduled-task-history">
                  <div className="scheduled-task-history-title">
                    <History size={12} />
                    <span>{t("scheduledTasks.history")}</span>
                  </div>
                  {(runsByTask[task.id] ?? []).length === 0 ? (
                    <div
                      className="scheduled-task-history-empty"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "11px",
                        color: "var(--fb-text-tertiary)",
                        padding: "4px 0"
                      }}
                    >
                      <span>{t("scheduledTasks.noHistory")}</span>
                    </div>
                  ) : (
                    <div className="scheduled-task-history-list">
                      {(runsByTask[task.id] ?? []).map((run) => (
                        <div key={run.id} className="scheduled-task-history-item">
                          <span className={`scheduled-task-history-dot ${run.status}`} />
                          <div className="scheduled-task-history-content">
                            <span
                              className={`scheduled-task-status ${run.status}`}
                              style={{ fontSize: "9px", padding: "1px 5px" }}
                            >
                              {t(`scheduledTasks.status.${run.status}`)}
                            </span>
                            <time>{formatDate(run.startedAt)}</time>
                            {run.error && (
                              <span
                                className="scheduled-task-history-error-text"
                                title={translateTaskError(run.error)}
                              >
                                {translateTaskError(run.error)}
                              </span>
                            )}
                          </div>
                          {run.conversationId && (
                            <button
                              type="button"
                              onClick={() => onOpenConversation?.(run.conversationId!)}
                            >
                              {t("scheduledTasks.openResult")}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
