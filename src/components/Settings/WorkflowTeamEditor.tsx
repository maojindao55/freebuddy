import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamRole
} from "@/services/workflowTeams/types";
import {
  workflowTeamDescription,
  workflowTeamName
} from "@/services/workflowTeams/types";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import { useConversationStore } from "@/store/conversationStore";

function emptyTeam(): WorkflowTeam {
  const now = new Date().toISOString();
  return {
    id: `team-user-${Math.random().toString(36).slice(2, 10)}`,
    name: "",
    description: "",
    icon: undefined,
    enabled: true,
    source: "user",
    roles: [],
    template: {
      id: `tpl-user-${Math.random().toString(36).slice(2, 10)}`,
      name: "Custom workflow",
      version: 1,
      nodes: [],
      edges: [],
      startNodeIds: [],
      finalNodeIds: []
    },
    policy: {
      allowWrites: true,
      requireApprovalBeforeWrite: true,
      requireApprovalAfterReview: false,
      maxParallelReadSteps: 1,
      maxParallelWriteSteps: 1,
      maxLoops: 1,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };
}

export function WorkflowTeamEditor({
  team,
  onSaved,
  onCancel
}: {
  team?: WorkflowTeam;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const members = useConversationStore((s) => s.members);
  const create = useWorkflowTeamStore((s) => s.create);
  const update = useWorkflowTeamStore((s) => s.update);
  const isNew = !team;
  const [draft, setDraft] = useState<WorkflowTeam>(() =>
    team ? structuredClone(team) : emptyTeam()
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isBuiltin = team?.source === "builtin";
  const displayName = team ? workflowTeamName(team, t) : draft.name;
  const displayDescription = team
    ? workflowTeamDescription(team, t)
    : draft.description;

  useEffect(() => {
    setDraft(team ? structuredClone(team) : emptyTeam());
    setErrors([]);
  }, [team]);

  const setRoleAgent = (roleId: string, agentId: string) => {
    setDraft((d) => ({
      ...d,
      roles: d.roles.map((r) => (r.id === roleId ? { ...r, agentId } : r))
    }));
  };

  const setPolicy = <K extends keyof WorkflowTeamPolicy>(
    key: K,
    value: WorkflowTeamPolicy[K]
  ) => {
    setDraft((d) => ({ ...d, policy: { ...d.policy, [key]: value } }));
  };

  const handleSave = async () => {
    setErrors([]);
    if (!draft.name.trim()) {
      setErrors([t("workflow.teamNameRequired")]);
      return;
    }
    if (isNew) {
      const res = await create({
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description?.trim() || undefined,
        icon: draft.icon,
        enabled: draft.enabled,
        roles: draft.roles,
        template: draft.template,
        policy: draft.policy
      });
      if (!res.ok) {
        setErrors(res.errors ?? ["unknown error"]);
        return;
      }
    } else {
      const res = await update(draft.id, {
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        icon: draft.icon ?? null,
        enabled: draft.enabled,
        roles: draft.roles,
        policy: draft.policy
      });
      if (!res.ok) {
        setErrors(res.errors ?? ["unknown error"]);
        return;
      }
    }
    onSaved();
  };

  const roleAgentName = (role: WorkflowTeamRole) =>
    members.find((m) => m.id === role.agentId)?.name ?? role.agentId;

  const writeNodeCount = useMemo(
    () => draft.template.nodes.filter((n) => n.mode === "write").length,
    [draft.template.nodes]
  );

  return (
    <div className="workflow-team-editor">
      <div className="workflow-team-editor-header">
        <button
          type="button"
          className="workflow-team-editor-back"
          onClick={onCancel}
          aria-label={t("common.cancel")}
        >
          ←
        </button>
        <div className="workflow-team-editor-title">
          <h4>{isNew ? t("workflow.newTeam") : displayName || t("workflow.teamEditor")}</h4>
          {isBuiltin && (
            <span className="workflow-team-badge builtin">
              {t("workflow.builtinTeam")}
            </span>
          )}
        </div>
        <div className="workflow-team-editor-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleSave()}
          >
            {t("common.save")}
          </button>
        </div>
      </div>

      {isBuiltin && (
        <p className="workflow-team-editor-hint">
          {t("workflow.teamBuiltinLocked")}
        </p>
      )}

      {errors.length > 0 && (
        <ul className="workflow-team-editor-errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <section className="workflow-team-editor-section">
        <h5>{t("workflow.teamOverview")}</h5>
        <label className="workflow-team-editor-field">
          <span>{t("workflow.teamName")}</span>
          <input
            type="text"
            value={isBuiltin ? displayName : draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            disabled={isBuiltin}
            placeholder={t("workflow.teamName")}
          />
        </label>
        <label className="workflow-team-editor-field">
          <span>{t("workflow.teamDescription")}</span>
          <textarea
            value={isBuiltin ? displayDescription ?? "" : draft.description ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            disabled={isBuiltin}
            rows={2}
            placeholder={t("workflow.teamDescription")}
          />
        </label>
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("workflow.teamRoles")}</h5>
        {draft.roles.length === 0 ? (
          <p className="muted small">{t("workflow.noTeams")}</p>
        ) : (
          <ul className="workflow-team-roles">
            {draft.roles.map((role) => (
              <li key={role.id}>
                <div className="workflow-team-role-info">
                  <strong>{role.label}</strong>
                  <span className="workflow-team-badge muted">{role.kind}</span>
                  {role.canWrite && (
                    <span className="workflow-team-badge write">
                      {t("workflow.writeNodes")}
                    </span>
                  )}
                </div>
                <label className="workflow-team-role-agent">
                  <span>{t("workflow.currentAgent")}</span>
                  <select
                    value={role.agentId}
                    onChange={(e) => setRoleAgent(role.id, e.target.value)}
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("workflow.teamWorkflow")}</h5>
        <p className="workflow-team-editor-section-desc">
          {draft.template.nodes.length} {t("workflow.steps").toLowerCase()}
          {writeNodeCount > 0 && (
            <>
              {" · "}
              <span className="write-count">
                {writeNodeCount} {t("workflow.writeNodes").toLowerCase()}
              </span>
            </>
          )}
        </p>
        <ol className="workflow-team-nodes timeline">
          {draft.template.nodes.map((n) => {
            const role = n.roleId
              ? draft.roles.find((r) => r.id === n.roleId)
              : undefined;
            return (
              <li key={n.id} className={n.mode}>
                <div className="workflow-team-node-content">
                  <strong>{n.title}</strong>
                  <div className="workflow-team-node-meta">
                    <span className="workflow-team-badge muted">{n.mode}</span>
                    {role && (
                      <span className="workflow-team-node-role">
                        {role.label} · {roleAgentName(role)}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("workflow.teamPolicy")}</h5>
        <div className="workflow-team-editor-subgroup">
          <p className="workflow-team-editor-subgroup-title">
            {t("workflow.teamPolicyGates")}
          </p>
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={draft.policy.allowWrites}
              onChange={(e) => setPolicy("allowWrites", e.target.checked)}
            />
            <span>{t("workflow.allowWrites")}</span>
          </label>
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={draft.policy.requireApprovalBeforeWrite}
              onChange={(e) =>
                setPolicy("requireApprovalBeforeWrite", e.target.checked)
              }
              disabled={!draft.policy.allowWrites}
            />
            <span>{t("workflow.requireApprovalBeforeWrite")}</span>
          </label>
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={draft.policy.requireApprovalAfterReview}
              onChange={(e) =>
                setPolicy("requireApprovalAfterReview", e.target.checked)
              }
            />
            <span>{t("workflow.requireApprovalAfterReview")}</span>
          </label>
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={draft.policy.stopOnVerifyFailure}
              onChange={(e) =>
                setPolicy("stopOnVerifyFailure", e.target.checked)
              }
            />
            <span>{t("workflow.stopOnVerifyFailure")}</span>
          </label>
        </div>

        <div className="workflow-team-editor-subgroup">
          <p className="workflow-team-editor-subgroup-title">
            {t("workflow.teamPolicyLimits")}
          </p>
          <div className="workflow-team-editor-limits">
            <label className="workflow-team-editor-field inline">
              <span>{t("workflow.maxLoops")}</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.policy.maxLoops}
                onChange={(e) =>
                  setPolicy(
                    "maxLoops",
                    Math.max(1, Math.min(10, Number(e.target.value) || 1))
                  )
                }
              />
            </label>
            <label className="workflow-team-editor-field inline">
              <span>{t("workflow.parallelReads")}</span>
              <input
                type="number"
                min={1}
                max={3}
                value={draft.policy.maxParallelReadSteps}
                onChange={(e) =>
                  setPolicy(
                    "maxParallelReadSteps",
                    Math.max(1, Math.min(3, Number(e.target.value) || 1))
                  )
                }
              />
            </label>
          </div>
        </div>
      </section>

      <section className="workflow-team-editor-section">
        <button
          type="button"
          className="workflow-team-editor-disclose"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span className="workflow-team-editor-disclose-icon">
            {showAdvanced ? "▾" : "▸"}
          </span>
          {t("workflow.advancedGraph")}
        </button>
        {showAdvanced && (
          <div className="workflow-team-editor-advanced">
            <p className="muted small">
              {t("workflow.startNodes")}: {draft.template.startNodeIds.join(", ")}
            </p>
            <p className="muted small">
              {t("workflow.finalNodes")}: {draft.template.finalNodeIds.join(", ")}
            </p>
            <pre className="workflow-team-editor-json">
              {JSON.stringify(draft.template, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
