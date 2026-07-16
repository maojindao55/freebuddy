import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import type {
  SessionConfigOption,
  SessionConfigProbeInput
} from "@/services/cli/types";
import type {
  WorkflowNodeContract,
  WorkflowTeam,
  WorkflowTeamPolicy,
  WorkflowTeamRole,
  WorkflowTemplate2,
  WorkflowTemplateNodeMode
} from "@/services/workflowTeams/types";
import {
  workflowTeamDescription,
  workflowTeamName,
  workflowTeamNodeMode,
  workflowTeamNodeTitle,
  workflowTeamRoleKind,
  workflowTeamRoleLabel
} from "@/services/workflowTeams/types";
import { useWorkflowTeamStore } from "@/store/workflowTeamStore";
import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useSkillStore } from "@/store/skillStore";
import { SkillPicker } from "@/components/CLI/SkillPicker";

type DeliveryNodeContract = Exclude<
  WorkflowNodeContract,
  "approval" | "research" | "report" | "custom"
>;

interface DeliveryNodeDefinition {
  contract: DeliveryNodeContract;
  mode: WorkflowTemplateNodeMode;
  roleKind?: WorkflowTeamRole["kind"];
  roleId?: string;
  roleLabelKey?: string;
  titleKey: string;
  promptTemplate?: string;
  required?: boolean;
}

const DELIVERY_NODE_DEFS: DeliveryNodeDefinition[] = [
  {
    contract: "plan",
    mode: "research",
    roleKind: "planner",
    roleId: "role-planner",
    roleLabelKey: "workflow.rolePlanner",
    titleKey: "workflow.nodePlan",
    promptTemplate:
      "Plan the work needed for goal: {{goal}}. List concrete implementation steps, risks, and verification."
  },
  {
    contract: "implement",
    mode: "write",
    roleKind: "implementer",
    roleId: "role-implementer",
    roleLabelKey: "workflow.roleImplementer",
    titleKey: "workflow.nodeImplement",
    promptTemplate:
      "Implement the requested change for: {{goal}}. Make focused, minimal changes.",
    required: true
  },
  {
    contract: "review",
    mode: "review",
    roleKind: "reviewer",
    roleId: "role-reviewer",
    roleLabelKey: "workflow.roleReviewer",
    titleKey: "workflow.nodeReview",
    promptTemplate:
      "Review the implementation for: {{goal}}. End with REVIEW_STATUS: PASS or REVIEW_STATUS: FAIL."
  },
  {
    contract: "verify",
    mode: "verify",
    roleKind: "verifier",
    roleId: "role-verifier",
    roleLabelKey: "workflow.roleVerifier",
    titleKey: "workflow.nodeVerify",
    promptTemplate:
      "Verify the implementation for: {{goal}}. End your response with: UNRESOLVED: <count>"
  },
  {
    contract: "summarize",
    mode: "summarize",
    roleKind: "summarizer",
    roleId: "role-summarizer",
    roleLabelKey: "workflow.roleSummarizer",
    titleKey: "workflow.nodeSummarize",
    promptTemplate:
      "Summarize what was done, what was reviewed or verified, and what remains unresolved."
  }
];

const DEFAULT_DELIVERY_CONTRACTS: DeliveryNodeContract[] = [
  "plan",
  "implement",
  "verify",
  "summarize"
];

function selectedContractsFromTemplate(
  template: WorkflowTemplate2
): DeliveryNodeContract[] {
  const contracts = template.nodes
    .map((node) => node.contract)
    .filter((contract): contract is DeliveryNodeContract =>
      DELIVERY_NODE_DEFS.some((def) => def.contract === contract)
    );
  return contracts.length > 0 ? contracts : DEFAULT_DELIVERY_CONTRACTS;
}

function hasPlanApprovalGate(template: WorkflowTemplate2): boolean {
  return template.nodes.some((node) => {
    if (node.contract === "approval") return true;
    if (node.contract !== "plan") return false;
    return node.gates?.some((gate) => gate.type === "manual_approval") ?? false;
  });
}

function fallbackAgentForRole(
  members: Array<{ id: string; enabled?: boolean }>,
  kind: WorkflowTeamRole["kind"]
): string {
  const preferred = members.find((m) => {
    if (kind === "implementer") return /claude|opencode|codex/i.test(m.id);
    if (kind === "reviewer") return /kimi|codex/i.test(m.id);
    if (kind === "verifier") return /opencode|codex/i.test(m.id);
    return /codex/i.test(m.id);
  });
  return preferred?.id ?? members[0]?.id ?? "";
}

function buildDeliveryTemplate(
  contracts: DeliveryNodeContract[],
  t: ReturnType<typeof useTranslation>["t"],
  planApproval: boolean
): WorkflowTemplate2 {
  const selected = DELIVERY_NODE_DEFS.filter((def) =>
    contracts.includes(def.contract)
  );
  const nodes = selected.map((def) => {
    const gates =
      def.contract === "plan" && planApproval
        ? [
            {
              id: "approve-plan",
              type: "manual_approval" as const,
              placement: "after" as const,
              label: t("workflow.nodeApproval"),
              reason: t("workflow.nodeContract.approval"),
              blocks: "implement"
            }
          ]
        : undefined;
    return {
      id: def.contract,
      title: t(def.titleKey),
      mode: def.mode,
      contract: def.contract,
      ...(def.roleId ? { roleId: def.roleId } : {}),
      ...(gates ? { gates } : {}),
      ...(def.promptTemplate ? { promptTemplate: def.promptTemplate } : {})
    };
  });
  return {
    id: "tpl-configurable-delivery",
    name: "Configurable delivery",
    version: 1,
    nodes,
    edges: selected.slice(0, -1).map((def, index) => ({
      id: `e-${def.contract}-${selected[index + 1]!.contract}`,
      from: def.contract,
      to: selected[index + 1]!.contract
    })),
    startNodeIds: nodes[0] ? [nodes[0].id] : [],
    finalNodeIds: nodes.at(-1) ? [nodes.at(-1)!.id] : []
  };
}

function buildDeliveryRoles(
  contracts: DeliveryNodeContract[],
  currentRoles: WorkflowTeamRole[],
  members: Array<{ id: string; enabled?: boolean }>,
  t: ReturnType<typeof useTranslation>["t"]
): WorkflowTeamRole[] {
  return DELIVERY_NODE_DEFS.filter(
    (def) => contracts.includes(def.contract) && def.roleId && def.roleKind
  ).map((def) => {
    const existing = currentRoles.find((role) => role.id === def.roleId);
    return {
      id: def.roleId!,
      label: existing?.label ?? t(def.roleLabelKey!),
      kind: def.roleKind!,
      agentId:
        existing?.agentId ??
        fallbackAgentForRole(members, def.roleKind!),
      model: existing?.model,
      modelOptionId: existing?.modelOptionId,
      skillIds: existing?.skillIds,
      required: true,
      canWrite: def.mode === "write",
      description: existing?.description
    };
  });
}

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
      id: "tpl-configurable-delivery",
      name: "Configurable delivery",
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
      maxLoops: 2,
      stopOnVerifyFailure: false
    },
    createdAt: now,
    updatedAt: now
  };
}

const getRoleIcon = (kind: string) => {
  switch (kind) {
    case "planner":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
          <path d="M9 14h6"/>
          <path d="M9 18h6"/>
          <path d="M9 10h6"/>
        </svg>
      );
    case "implementer":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6"/>
          <polyline points="8 6 2 12 8 18"/>
        </svg>
      );
    case "reviewer":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      );
    case "verifier":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 11l2 2 4-4"/>
        </svg>
      );
    case "summarizer":
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      );
  }
};

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
  const skills = useSkillStore((s) => s.skills);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const loadSkills = useSkillStore((s) => s.load);
  const create = useWorkflowTeamStore((s) => s.create);
  const update = useWorkflowTeamStore((s) => s.update);
  const isNew = !team;
  const [draft, setDraft] = useState<WorkflowTeam>(() =>
    team ? structuredClone(team) : emptyTeam()
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelOptionsByAgent, setModelOptionsByAgent] = useState<
    Record<string, SessionConfigOption[]>
  >({});
  const [modelLoadingByAgent, setModelLoadingByAgent] = useState<
    Record<string, boolean>
  >({});
  const modelProbeInFlightRef = useRef(new Set<string>());
  const modelRefreshedRef = useRef(new Set<string>());
  const isBuiltin = team?.source === "builtin";
  const displayName = team ? workflowTeamName(team, t) : draft.name;
  const displayDescription = team
    ? workflowTeamDescription(team, t)
    : draft.description;
  const selectedDeliveryContracts = selectedContractsFromTemplate(draft.template);
  const planApprovalEnabled =
    hasPlanApprovalGate(draft.template) || draft.policy.requireApprovalBeforeWrite;
  const roleAgentIdsKey = useMemo(
    () =>
      Array.from(new Set(draft.roles.map((role) => role.agentId).filter(Boolean)))
        .sort()
        .join("\u0000"),
    [draft.roles]
  );

  useEffect(() => {
    if (!skillsLoaded) void loadSkills();
  }, [loadSkills, skillsLoaded]);

  const sessionProbeInputForAgent = useCallback(
    (agentId: string): SessionConfigProbeInput | undefined => {
      const member = members.find((entry) => entry.id === agentId);
      if (!member) return undefined;
      const resolved = useCliExecutorStore
        .getState()
        .resolve(member.cli.adapter);
      return {
        agentId: member.id,
        adapter: member.cli.adapter,
        binary: member.cli.binary || resolved?.binary,
        extraArgs: [
          ...(resolved?.extraArgs ?? []),
          ...(member.cli.extraArgs ?? [])
        ],
        env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) }
      };
    },
    [members]
  );

  useEffect(() => {
    if (team) {
      setDraft(structuredClone(team));
      setErrors([]);
      return;
    }
    const next = emptyTeam();
    next.template = buildDeliveryTemplate(DEFAULT_DELIVERY_CONTRACTS, t, true);
    next.roles = buildDeliveryRoles(
      DEFAULT_DELIVERY_CONTRACTS,
      [],
      members,
      t
    );
    setDraft(next);
    setErrors([]);
  }, [team, members, t]);

  useEffect(() => {
    if (!roleAgentIdsKey || !cliClient.isAvailable()) return;
    let cancelled = false;
    const agentIds = roleAgentIdsKey.split("\u0000");
    void Promise.all(
      agentIds.map(async (agentId) => {
        const input = sessionProbeInputForAgent(agentId);
        if (!input) return [agentId, [] as SessionConfigOption[]] as const;
        try {
          return [
            agentId,
            await cliClient.getCachedSessionConfigOptions(input)
          ] as const;
        } catch {
          return [agentId, [] as SessionConfigOption[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setModelOptionsByAgent((current) => {
        const next = { ...current };
        for (const [agentId, options] of entries) {
          if (options.length > 0) next[agentId] = options;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [roleAgentIdsKey, sessionProbeInputForAgent]);

  const refreshRoleModels = async (agentId: string) => {
    if (
      !cliClient.isAvailable() ||
      modelRefreshedRef.current.has(agentId) ||
      modelProbeInFlightRef.current.has(agentId)
    ) {
      return;
    }
    const input = sessionProbeInputForAgent(agentId);
    if (!input) return;
    modelProbeInFlightRef.current.add(agentId);
    setModelLoadingByAgent((current) => ({ ...current, [agentId]: true }));
    try {
      const options = await cliClient.inspectSessionConfigOptions(input);
      if (options.length > 0) {
        modelRefreshedRef.current.add(agentId);
        setModelOptionsByAgent((current) => ({
          ...current,
          [agentId]: options
        }));
      }
    } catch {
      // Keep any persisted options and allow another refresh attempt.
    } finally {
      modelProbeInFlightRef.current.delete(agentId);
      setModelLoadingByAgent((current) => ({ ...current, [agentId]: false }));
    }
  };

  const setRoleAgent = (roleId: string, agentId: string) => {
    setDraft((d) => ({
      ...d,
      roles: d.roles.map((r) =>
        r.id === roleId
          ? { ...r, agentId, model: undefined, modelOptionId: undefined }
          : r
      )
    }));
  };

  const setRoleModel = (roleId: string, model: string, modelOptionId: string) => {
    setDraft((d) => ({
      ...d,
      roles: d.roles.map((role) =>
        role.id === roleId
          ? {
              ...role,
              model: model.trim() || undefined,
              modelOptionId: model.trim() ? modelOptionId : undefined
            }
          : role
      )
    }));
  };

  const setRoleSkills = (roleId: string, skillIds: string[]) => {
    setDraft((current) => ({
      ...current,
      roles: current.roles.map((role) =>
        role.id === roleId ? { ...role, skillIds } : role
      )
    }));
  };

  const setPolicy = <K extends keyof WorkflowTeamPolicy>(
    key: K,
    value: WorkflowTeamPolicy[K]
  ) => {
    setDraft((d) => ({ ...d, policy: { ...d.policy, [key]: value } }));
  };

  const setDeliveryNodeEnabled = (
    contract: DeliveryNodeContract,
    enabled: boolean
  ) => {
    const definition = DELIVERY_NODE_DEFS.find((def) => def.contract === contract);
    if (!definition || definition.required) return;
    setDraft((d) => {
      const current = selectedContractsFromTemplate(d.template);
      let nextContracts = enabled
        ? [...current, contract]
        : current.filter((entry) => entry !== contract);
      if (contract === "plan" && !enabled) {
        nextContracts = nextContracts.filter((entry) => entry !== "plan");
      }
      const ordered = DELIVERY_NODE_DEFS.map((def) => def.contract).filter(
        (entry): entry is DeliveryNodeContract =>
          nextContracts.includes(entry as DeliveryNodeContract)
      );
      if (!ordered.includes("implement")) ordered.push("implement");
      return {
        ...d,
        roles: buildDeliveryRoles(ordered, d.roles, members, t),
        template: buildDeliveryTemplate(
          ordered,
          t,
          contract === "plan" && !enabled
            ? false
            : hasPlanApprovalGate(d.template)
        ),
        policy: {
          ...d.policy,
          allowWrites: true,
          requireApprovalBeforeWrite:
            contract === "plan" && !enabled
              ? false
              : hasPlanApprovalGate(d.template),
          maxLoops:
            ordered.includes("review") || ordered.includes("verify")
              ? Math.max(d.policy.maxLoops, 2)
              : d.policy.maxLoops
        }
      };
    });
  };

  const setPlanApprovalEnabled = (enabled: boolean) => {
    setDraft((d) => {
      const current = selectedContractsFromTemplate(d.template);
      const nextContracts =
        enabled && !current.includes("plan") ? ["plan", ...current] : current;
      const ordered = DELIVERY_NODE_DEFS.map((def) => def.contract).filter(
        (entry): entry is DeliveryNodeContract =>
          nextContracts.includes(entry as DeliveryNodeContract)
      );
      if (!ordered.includes("implement")) ordered.push("implement");
      return {
        ...d,
        roles: buildDeliveryRoles(ordered, d.roles, members, t),
        template: buildDeliveryTemplate(ordered, t, enabled),
        policy: {
          ...d.policy,
          allowWrites: true,
          requireApprovalBeforeWrite: enabled
        }
      };
    });
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
        setErrors(res.errors ?? [t("errors.unknown")]);
        return;
      }
    } else {
      const res = await update(draft.id, {
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        icon: draft.icon ?? null,
        enabled: draft.enabled,
        roles: draft.roles,
        ...(!isBuiltin ? { template: draft.template } : {}),
        policy: draft.policy
      });
      if (!res.ok) {
        setErrors(res.errors ?? [t("errors.unknown")]);
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
          <div className="workflow-team-role-cards">
            {draft.roles.map((role) => (
              <div key={role.id} className="workflow-team-role-card">
                <div className="workflow-team-role-header">
                  <div className={`workflow-team-role-icon-wrapper ${role.kind}`}>
                    {getRoleIcon(role.kind)}
                  </div>
                  <div className="workflow-team-role-meta">
                    <div className="workflow-team-role-title-row">
                      <span className="workflow-team-role-title">
                        {workflowTeamRoleLabel(draft, role, t)}
                      </span>
                      {role.canWrite ? (
                        <span className="workflow-team-badge write">
                          {t("workflow.writeNodes")}
                        </span>
                      ) : (
                        <span className="workflow-team-badge read">
                          {t("workflow.readNodes")}
                        </span>
                      )}
                    </div>
                    <div className="workflow-team-role-description">
                      {t(`workflow.roleDescriptions.${role.kind}`, { defaultValue: role.description })}
                    </div>
                  </div>
                </div>

                <div className="workflow-team-role-selectors">
                  <div className="workflow-team-role-selector">
                    <span className="selector-label">{t("workflow.currentAgent")}</span>
                    <div className="custom-select-wrapper">
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
                      <span className="custom-select-arrow">▼</span>
                    </div>
                  </div>

                  <div className="workflow-team-role-selector">
                    <span className="selector-label">{t("workflow.currentModel")}</span>
                    <div className="custom-select-wrapper">
                      <select
                        value={role.model ?? ""}
                        onFocus={() => void refreshRoleModels(role.agentId)}
                        onChange={(e) =>
                          setRoleModel(
                            role.id,
                            e.target.value,
                            (modelOptionsByAgent[role.agentId] ?? []).find(
                              (entry) => entry.category === "model"
                            )?.id ??
                              (modelOptionsByAgent[role.agentId] ?? []).find(
                                (entry) => entry.id === "model"
                              )?.id ??
                              role.modelOptionId ??
                              "model"
                          )
                        }
                      >
                        <option value="">{t("workflow.defaultModel")}</option>
                        {modelLoadingByAgent[role.agentId] &&
                        !(modelOptionsByAgent[role.agentId] ?? []).some(
                          (option) =>
                            option.category === "model" || option.id === "model"
                        ) ? (
                          <option disabled>{t("chat.modelLoading")}</option>
                        ) : null}
                        {(() => {
                          const option = (modelOptionsByAgent[role.agentId] ?? []).find(
                            (entry) => entry.category === "model"
                          ) ?? (modelOptionsByAgent[role.agentId] ?? []).find(
                            (entry) => entry.id === "model"
                          );
                          const values = [...(option?.values ?? [])];
                          if (
                            role.model &&
                            !values.some((value) => value.id === role.model)
                          ) {
                            values.unshift({ id: role.model, name: role.model });
                          }
                          return values.map((value) => (
                            <option key={value.id} value={value.id}>
                              {value.name || value.id}
                            </option>
                          ));
                        })()}
                      </select>
                      <span className="custom-select-arrow">▼</span>
                    </div>
                  </div>
                  <div className="workflow-team-role-selector workflow-team-role-skills">
                    <span className="selector-label">{t("skills.roleOverride")}</span>
                    <SkillPicker
                      skills={skills}
                      selectedIds={role.skillIds ?? []}
                      onChange={(ids) => setRoleSkills(role.id, ids)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("workflow.teamWorkflow")}</h5>
        {!isBuiltin && (
          <div className="workflow-node-config">
            <p className="workflow-team-editor-section-desc">
              {t("workflow.nodeConfigHint")}
            </p>
            <div className="workflow-node-options">
              {DELIVERY_NODE_DEFS.map((def) => {
                const checked = selectedDeliveryContracts.includes(def.contract);
                return (
                  <label
                    key={def.contract}
                    className={`workflow-node-option ${checked ? "selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={def.required}
                      onChange={(e) =>
                        setDeliveryNodeEnabled(def.contract, e.target.checked)
                      }
                    />
                    <span className="workflow-node-option-main">
                      <strong>{t(def.titleKey)}</strong>
                      <small>{t(`workflow.nodeContract.${def.contract}`)}</small>
                      {def.contract === "plan" && checked && (
                        <span
                          className="workflow-node-gate-option"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={planApprovalEnabled}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setPlanApprovalEnabled(e.target.checked)
                            }
                          />
                          <span>
                            <strong>{t("workflow.nodeApproval")}</strong>
                            <small>{t("workflow.nodeContract.approval")}</small>
                          </span>
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
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
                  <strong>{workflowTeamNodeTitle(draft, n, t)}</strong>
                  <div className="workflow-team-node-meta">
                    <span className="workflow-team-badge muted">
                      {workflowTeamNodeMode(n.mode, t)}
                    </span>
                    {role && (
                      <span className="workflow-team-node-role">
                        {workflowTeamRoleLabel(draft, role, t)} · {roleAgentName(role)}
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
              disabled={isBuiltin}
            />
            <span>{t("workflow.allowWrites")}</span>
          </label>
          <label className="workflow-team-editor-toggle">
            <input
              type="checkbox"
              checked={draft.policy.requireApprovalBeforeWrite}
              onChange={(e) =>
                setPlanApprovalEnabled(e.target.checked)
              }
              disabled={
                isBuiltin ||
                !draft.policy.allowWrites ||
                !selectedDeliveryContracts.includes("plan")
              }
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
              disabled={isBuiltin}
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
              disabled={isBuiltin}
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
                disabled={isBuiltin}
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
                disabled={isBuiltin}
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
