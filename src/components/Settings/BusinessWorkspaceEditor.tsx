import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  BusinessSurface,
  BusinessSurfaceKind,
  BusinessWorkspace,
  ContractRole
} from "@/services/businessWorkspaces/types";
import { useBusinessWorkspaceStore } from "@/store/businessWorkspaceStore";
import { useConversationStore } from "@/store/conversationStore";
import { cliClient } from "@/services/cli/client";

const SURFACE_KINDS: BusinessSurfaceKind[] = [
  "client",
  "server",
  "admin",
  "shared",
  "docs",
  "test",
  "custom"
];
const CONTRACT_ROLES: ContractRole[] = ["provider", "consumer", "both", "none"];

const KIND_META: Record<BusinessSurfaceKind, { icon: string; labelKey: string; tone: string }> = {
  client: { icon: "◐", labelKey: "business.kind_client", tone: "client" },
  server: { icon: "●", labelKey: "business.kind_server", tone: "server" },
  admin: { icon: "◑", labelKey: "business.kind_admin", tone: "admin" },
  shared: { icon: "⇄", labelKey: "business.kind_shared", tone: "shared" },
  docs: { icon: "▤", labelKey: "business.kind_docs", tone: "docs" },
  test: { icon: "✓", labelKey: "business.kind_test", tone: "test" },
  custom: { icon: "⬚", labelKey: "business.kind_custom", tone: "custom" }
};

type WorkspaceTemplateId = "client-server-admin" | "client-server" | "single-repo" | "custom";

interface WorkspaceTemplateSurface {
  id: string;
  nameKey: string;
  kind: BusinessSurfaceKind;
  allowedPaths: string[];
  verifyCommands: string[];
  responsibilities: string[];
  contractRole: ContractRole;
}

interface WorkspaceTemplate {
  id: WorkspaceTemplateId;
  titleKey: string;
  descKey: string;
  surfaces: WorkspaceTemplateSurface[];
}

const WORKSPACE_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "client-server-admin",
    titleKey: "business.templateClientServerAdmin",
    descKey: "business.templateClientServerAdminDesc",
    surfaces: [
      {
        id: "client",
        nameKey: "business.repoClient",
        kind: "client",
        allowedPaths: ["src", "app", "pages"],
        verifyCommands: [],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer"
      },
      {
        id: "server",
        nameKey: "business.repoServer",
        kind: "server",
        allowedPaths: ["src", "app", "routes", "database"],
        verifyCommands: [],
        responsibilities: ["API", "business rules", "persistence"],
        contractRole: "provider"
      },
      {
        id: "admin",
        nameKey: "business.repoAdmin",
        kind: "admin",
        allowedPaths: ["src", "app", "pages"],
        verifyCommands: [],
        responsibilities: ["Admin UI", "API consumption"],
        contractRole: "consumer"
      }
    ]
  },
  {
    id: "client-server",
    titleKey: "business.templateClientServer",
    descKey: "business.templateClientServerDesc",
    surfaces: [
      {
        id: "client",
        nameKey: "business.repoClient",
        kind: "client",
        allowedPaths: ["src", "app", "pages"],
        verifyCommands: [],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer"
      },
      {
        id: "server",
        nameKey: "business.repoServer",
        kind: "server",
        allowedPaths: ["src", "app", "routes", "database"],
        verifyCommands: [],
        responsibilities: ["API", "business rules", "persistence"],
        contractRole: "provider"
      }
    ]
  },
  {
    id: "single-repo",
    titleKey: "business.templateSingleRepo",
    descKey: "business.templateSingleRepoDesc",
    surfaces: [
      {
        id: "app",
        nameKey: "business.repoApp",
        kind: "custom",
        allowedPaths: ["src"],
        verifyCommands: [],
        responsibilities: ["Full-stack changes"],
        contractRole: "none"
      }
    ]
  },
  {
    id: "custom",
    titleKey: "business.templateCustom",
    descKey: "business.templateCustomDesc",
    surfaces: []
  }
];

function defaultPolicy() {
  return {
    requireAssignmentApproval: true as const,
    requireCommitApproval: true as const,
    blockCommitOnVerificationFailure: true,
    requireCleanRepoBeforeRun: true,
    branchNameTemplate: "fb/{{runSlug}}/{{surfaceKey}}"
  };
}

function emptyWorkspace(): BusinessWorkspace {
  const now = new Date().toISOString();
  return {
    id: `biz-${Math.random().toString(36).slice(2, 10)}`,
    name: "",
    description: "",
    surfaces: [],
    defaultTeamId: undefined,
    policy: defaultPolicy(),
    createdAt: now,
    updatedAt: now
  };
}

function emptySurface(index: number): BusinessSurface {
  return {
    id: `surface-${index + 1}`,
    name: "",
    kind: "client",
    repoPath: "",
    defaultAgentId: "",
    allowedPaths: [],
    verifyCommands: [],
    responsibilities: [],
    contractRole: "none",
    enabled: true
  };
}

function surfaceIdFor(kind: BusinessSurfaceKind, index: number): string {
  if (kind === "client" || kind === "server" || kind === "admin") return kind;
  return `repo-${index + 1}`;
}

function defaultsForKind(kind: BusinessSurfaceKind) {
  if (kind === "client" || kind === "admin") {
    return {
      allowedPaths: ["src", "app", "pages"],
      verifyCommands: [],
      responsibilities: kind === "client" ? ["UI", "API consumption"] : ["Admin UI", "API consumption"],
      contractRole: "consumer" as ContractRole
    };
  }
  if (kind === "server") {
    return {
      allowedPaths: ["src", "app", "routes", "database"],
      verifyCommands: [],
      responsibilities: ["API", "business rules", "persistence"],
      contractRole: "provider" as ContractRole
    };
  }
  return {
    allowedPaths: ["src"],
    verifyCommands: [],
    responsibilities: [],
    contractRole: "none" as ContractRole
  };
}

const splitLines = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const joinLines = (value: string[]): string => value.join("\n");

function matchTemplate(surfaces: BusinessSurface[]): WorkspaceTemplateId | undefined {
  if (surfaces.length === 0) return undefined;
  const sig = (list: { kind: BusinessSurfaceKind }[]) => list.map((s) => s.kind).join(",");
  const sigs: Record<WorkspaceTemplateId, string> = {
    "client-server-admin": "client,server,admin",
    "client-server": "client,server",
    "single-repo": "custom",
    custom: ""
  };
  const current = sig(surfaces);
  return (Object.keys(sigs) as WorkspaceTemplateId[]).find((id) => sigs[id] === current);
}

export function BusinessWorkspaceEditor({
  workspace,
  onSaved,
  onCancel
}: {
  workspace?: BusinessWorkspace;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const members = useConversationStore((s) => s.members);
  const create = useBusinessWorkspaceStore((s) => s.create);
  const update = useBusinessWorkspaceStore((s) => s.update);
  const isNew = !workspace;
  const editorTopRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<BusinessWorkspace>(() =>
    workspace ? structuredClone(workspace) : emptyWorkspace()
  );
  const selectedTemplateId = matchTemplate(draft.surfaces);
  const selectedTemplate = selectedTemplateId
    ? WORKSPACE_TEMPLATES.find((template) => template.id === selectedTemplateId)
    : undefined;
  const enabledSurfaceCount = draft.surfaces.filter((surface) => surface.enabled).length;
  const configuredSurfaceCount = draft.surfaces.filter((surface) => surface.repoPath.trim()).length;
  const policyItemCount = enabledSurfaceCount + 3;
  const businessInfoReady = draft.name.trim().length > 0;
  const repositoriesReady = draft.surfaces.length > 0 && configuredSurfaceCount === draft.surfaces.length;
  const [errors, setErrors] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [editorTab, setEditorTab] = useState<"general" | "repos" | "policies">("general");

  useEffect(() => {
    setDraft(workspace ? structuredClone(workspace) : emptyWorkspace());
    setErrors([]);
    setNameError(false);
    setEditorTab("general");
  }, [workspace]);

  useEffect(() => {
    editorTopRef.current?.scrollIntoView({ block: "start" });
  }, [editorTab]);

  const setSurface = (index: number, patch: Partial<BusinessSurface>) => {
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.map((s, i) => (i === index ? { ...s, ...patch } : s))
    }));
  };

  const setSurfaceKind = (index: number, kind: BusinessSurfaceKind) => {
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.map((surface, i) => {
        if (i !== index) return surface;
        const defaults = defaultsForKind(kind);
        return {
          ...surface,
          kind,
          allowedPaths: surface.allowedPaths.length > 0 ? surface.allowedPaths : defaults.allowedPaths,
          verifyCommands:
            surface.verifyCommands.length > 0 ? surface.verifyCommands : defaults.verifyCommands,
          responsibilities:
            surface.responsibilities.length > 0 ? surface.responsibilities : defaults.responsibilities,
          contractRole: surface.contractRole === "none" ? defaults.contractRole : surface.contractRole
        };
      })
    }));
  };

  const addSurface = (kind: BusinessSurfaceKind = "client") => {
    setDraft((d) => ({
      ...d,
      surfaces: [
        ...d.surfaces,
        {
          ...emptySurface(d.surfaces.length),
          id: surfaceIdFor(kind, d.surfaces.length),
          kind,
          ...defaultsForKind(kind)
        }
      ]
    }));
  };

  const applyTemplate = (template: WorkspaceTemplate) => {
    setDraft((d) => ({
      ...d,
      surfaces: template.surfaces.map((surface, index) => ({
        id: surface.id,
        name: t(surface.nameKey),
        kind: surface.kind,
        repoPath: "",
        defaultAgentId: "",
        allowedPaths: surface.allowedPaths,
        verifyCommands: surface.verifyCommands,
        responsibilities: surface.responsibilities,
        contractRole: surface.contractRole,
        enabled: true
      }))
    }));
  };

  const applyTemplateWithConfirm = (template: WorkspaceTemplate) => {
    if (template.id === selectedTemplateId) return;
    if (draft.surfaces.length > 0 && !window.confirm(t("business.switchTemplateConfirm"))) return;
    applyTemplate(template);
  };

  const selectEditorTab = (tab: "general" | "repos" | "policies") => {
    if (tab !== "general" && !businessInfoReady) {
      setNameError(true);
      setEditorTab("general");
      return;
    }
    if (tab === "policies" && draft.surfaces.length === 0) return;
    setEditorTab(tab);
  };

  const goToNextTab = () => {
    if (editorTab === "general") {
      selectEditorTab("repos");
      return;
    }
    if (editorTab === "repos") selectEditorTab("policies");
  };

  const goToPreviousTab = () => {
    if (editorTab === "repos") setEditorTab("general");
    else if (editorTab === "policies") setEditorTab("repos");
  };

  const removeSurface = (index: number) => {
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.filter((_, i) => i !== index)
    }));
  };

  const pickRepoPath = async (index: number) => {
    try {
      const picked = await cliClient.selectDirectory();
      if (picked) setSurface(index, { repoPath: picked });
    } catch (e) {
      console.error("Error picking directory:", e);
    }
  };

  const handleSave = async () => {
    setErrors([]);
    if (!draft.name.trim()) {
      setNameError(true);
      setEditorTab("general");
      return;
    }
    const input = {
      id: draft.id,
      name: draft.name.trim(),
      description: draft.description?.trim() || undefined,
      surfaces: draft.surfaces,
      defaultTeamId: draft.defaultTeamId,
      policy: draft.policy
    };
    const ok = isNew ? await create(input) : await update(draft.id, input);
    if (!ok) {
      setErrors([t("business.saveFailed")]);
      return;
    }
    onSaved();
  };

  return (
    <div ref={editorTopRef} className="business-workspace-editor">
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
          <h4>{isNew ? t("business.newWorkspace") : draft.name || draft.id}</h4>
          <p>
            {t("business.workspaceDraftSummary", {
              template: selectedTemplate ? t(selectedTemplate.titleKey) : t("business.templateCustom"),
              configured: configuredSurfaceCount,
              total: draft.surfaces.length
            })}
          </p>
        </div>
        <div className="workflow-team-editor-actions">
          <button type="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="primary" onClick={() => void handleSave()}>
            {isNew ? t("business.createWorkspace") : t("common.save")}
          </button>
        </div>
      </div>

      <div className="business-editor-tabs">
        <button
          type="button"
          className={`business-editor-tab ${editorTab === "general" ? "active" : ""}`}
          onClick={() => selectEditorTab("general")}
        >
          <span className="business-editor-tab-num">1</span>
          {t("business.setupBusiness")}
          <span className={`business-editor-tab-state ${businessInfoReady ? "is-complete" : "is-required"}`}>
            {businessInfoReady ? t("business.stepReady") : t("business.stepRequired")}
          </span>
        </button>
        <button
          type="button"
          className={`business-editor-tab ${editorTab === "repos" ? "active" : ""}`}
          onClick={() => selectEditorTab("repos")}
        >
          <span className="business-editor-tab-num">2</span>
          {t("business.codeRepositories")}
          <span className={`business-editor-tab-state ${repositoriesReady ? "is-complete" : ""}`}>
            {t("business.repositoryProgress", {
              configured: configuredSurfaceCount,
              total: draft.surfaces.length
            })}
          </span>
        </button>
        <button
          type="button"
          className={`business-editor-tab ${editorTab === "policies" ? "active" : ""}`}
          onClick={() => selectEditorTab("policies")}
          disabled={draft.surfaces.length === 0}
        >
          <span className="business-editor-tab-num">3</span>
          {t("business.collaborationAndPolicy")}
          <span className="business-advanced-count">
            {t("business.advancedCountHint", { count: policyItemCount })}
          </span>
        </button>
      </div>

      {errors.length > 0 && (
        <ul className="workflow-team-editor-errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div key={editorTab} className="business-editor-tab-content">
        {editorTab === "general" && (
          <>
            <section className="workflow-team-editor-section business-template-hero">
              <div className="business-template-hero-copy">
                <h5>{t("business.structureTemplate")}</h5>
                <p className="muted small">{t("business.structureTemplateHint")}</p>
              </div>
              <div className="business-workspace-template-grid">
                {WORKSPACE_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`business-workspace-template${selectedTemplateId === template.id ? " is-selected" : ""}`}
                    onClick={() => applyTemplateWithConfirm(template)}
                  >
                    <strong>{t(template.titleKey)}</strong>
                    <span>{t(template.descKey)}</span>
                    <span className="business-workspace-template-count">
                      {t("business.templateRepoCount", { count: template.surfaces.length })}
                    </span>
                    {selectedTemplateId === template.id && (
                      <span className="business-template-selected">{t("business.selectedTemplate")}</span>
                    )}
                  </button>
                ))}
              </div>
            </section>

            <section className="workflow-team-editor-section business-basics-section">
              <h5>{t("business.setupBusiness")}</h5>
              <label className="workflow-team-editor-field">
                <span>
                  {t("business.workspaceName")} <span className="business-required">*</span>
                </span>
                <input
                  type="text"
                  value={draft.name}
                  required
                  aria-invalid={nameError}
                  aria-describedby={nameError ? "biz-name-error" : undefined}
                  className={nameError ? "business-input-error" : undefined}
                  onChange={(e) => {
                    setDraft({ ...draft, name: e.target.value });
                    setNameError(false);
                  }}
                  placeholder={t("business.workspaceName")}
                />
                {nameError && (
                  <span id="biz-name-error" role="alert" className="business-field-error">
                    {t("business.nameRequired")}
                  </span>
                )}
              </label>
              <label className="workflow-team-editor-field">
                <span>{t("workflow.teamDescription")}</span>
                <textarea
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={2}
                />
              </label>
            </section>
          </>
        )}

        {editorTab === "repos" && (
          <section className="workflow-team-editor-section business-repository-section">
            <div className="business-section-heading">
              <div>
                <h5>{t("business.codeRepositories")}</h5>
                <p className="muted small">{t("business.repositorySetupHint")}</p>
              </div>
              <button type="button" className="business-add-repository" onClick={() => addSurface()}>
                + {t("business.codeRepository")}
              </button>
            </div>
            {draft.surfaces.length === 0 ? (
              <div className="business-empty-repositories">
                <strong>{t("business.noRepositoriesTitle")}</strong>
                <p>{t("business.noRepositories")}</p>
                <button type="button" onClick={() => addSurface("custom")}>
                  + {t("business.addRepositoryManually")}
                </button>
              </div>
            ) : (
              <div className="business-workspace-surfaces">
                {draft.surfaces.map((surface, index) => {
                  const assignedAgent = members.find((member) => member.id === surface.defaultAgentId);
                  const repoReady = surface.repoPath.trim().length > 0;
                  const surfaceReady = surface.enabled && repoReady;

                  return (
                    <div key={index} className={`business-surface-row ${surfaceReady ? "is-ready" : "is-incomplete"}`}>
                      <div className="business-surface-row-header">
                        <div className="business-surface-title">
                          <span className="business-surface-index">{String(index + 1).padStart(2, "0")}</span>
                          <input
                            type="text"
                            aria-label={t("business.repositoryName")}
                            className="business-surface-name-input"
                            value={surface.name}
                            placeholder={t("business.codeRepository")}
                            onChange={(e) => setSurface(index, { name: e.target.value })}
                          />
                        </div>
                        <div className="business-surface-header-actions">
                          <span className={`workflow-team-badge business-kind-badge tone-${KIND_META[surface.kind].tone}`}>
                            {KIND_META[surface.kind].icon} {t(KIND_META[surface.kind].labelKey)}
                          </span>
                          <select
                            aria-label={t("business.repositoryType")}
                            className="business-surface-type-select"
                            value={surface.kind}
                            onChange={(e) =>
                              setSurfaceKind(index, e.target.value as BusinessSurfaceKind)
                            }
                          >
                            {SURFACE_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {KIND_META[kind].icon} {t(KIND_META[kind].labelKey)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="business-surface-delete-btn"
                            onClick={() => removeSurface(index)}
                            title={t("common.delete")}
                            aria-label={t("common.delete")}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="business-surface-meta-row">
                        <span className={`business-surface-status ${surfaceReady ? "is-ready" : "is-missing"}`}>
                          {surface.enabled
                            ? repoReady
                              ? t("business.repositoryReady")
                              : t("business.repoPathMissing")
                            : t("business.repositoryDisabled")}
                        </span>
                        <span>{assignedAgent ? assignedAgent.name : t("business.agentNotAssigned")}</span>
                      </div>
                      <div className="business-surface-quick-grid">
                        <label className="workflow-team-editor-field">
                          <span>{t("business.repoPath")}</span>
                          <div className="business-surface-repo">
                            <input
                              type="text"
                              value={surface.repoPath}
                              onChange={(e) => setSurface(index, { repoPath: e.target.value })}
                            />
                            <button
                              type="button"
                              onClick={() => void pickRepoPath(index)}
                            >
                              {t("business.chooseDirectory")}
                            </button>
                          </div>
                        </label>
                        <label className="workflow-team-editor-field">
                          <span>{t("business.defaultAgent")}</span>
                          <select
                            value={surface.defaultAgentId}
                            onChange={(e) =>
                              setSurface(index, { defaultAgentId: e.target.value })
                            }
                          >
                            <option value="">—</option>
                            {members.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <details className="business-repository-advanced">
                        <summary>
                          {t("business.repositoryAdvanced")}
                          <span>{t("business.repositoryAdvancedHint")}</span>
                        </summary>
                        <div className="business-surface-grid">
                          <label className="workflow-team-editor-toggle business-surface-enabled-toggle">
                            <input
                              type="checkbox"
                              checked={surface.enabled}
                              onChange={(e) =>
                                setSurface(index, { enabled: e.target.checked })
                              }
                            />
                            <span>{t("business.repositoryEnabled")}</span>
                          </label>
                          <label className="workflow-team-editor-field">
                            <span>
                              {t("business.verifyCommands")}
                              <span className="business-field-desc"> - {t("business.agentVerificationDefault")}</span>
                            </span>
                            <textarea
                              rows={2}
                              value={joinLines(surface.verifyCommands)}
                              placeholder={t("business.verifyCommandsHint")}
                              onChange={(e) =>
                                setSurface(index, { verifyCommands: splitLines(e.target.value) })
                              }
                            />
                          </label>
                          <label className="workflow-team-editor-field">
                            <span>{t("business.allowedPaths")}</span>
                            <textarea
                              rows={2}
                              value={joinLines(surface.allowedPaths)}
                              onChange={(e) =>
                                setSurface(index, { allowedPaths: splitLines(e.target.value) })
                              }
                            />
                          </label>
                          <label className="workflow-team-editor-field business-full-width">
                            <span>{t("business.responsibilities")}</span>
                            <textarea
                              rows={2}
                              value={joinLines(surface.responsibilities)}
                              onChange={(e) =>
                                setSurface(index, { responsibilities: splitLines(e.target.value) })
                              }
                            />
                          </label>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {editorTab === "policies" && draft.surfaces.length > 0 && (
          <section className="workflow-team-editor-section business-workspace-advanced-standalone business-workspace-collab-policy">
            <div className="business-policy-standalone-header">
              <div>
                <h5>{t("business.collaborationAndPolicy")}</h5>
                <p className="muted small business-policy-intro">
                  {t("business.collaborationAndPolicyHint")}
                </p>
              </div>
              <span className="business-advanced-count">
                {t("business.advancedCountHint", { count: policyItemCount })}
              </span>
            </div>

            <div className="business-collaboration-section">
              <h5>{t("business.collaboration")}</h5>
              <p className="muted small">{t("business.collaborationHint")}</p>
              <div className="business-collaboration-list">
                {draft.surfaces.map((surface, index) => (
                  <label key={surface.id || index} className="workflow-team-editor-field">
                    <span>{surface.name || surface.id}</span>
                    <select
                      value={surface.contractRole}
                      onChange={(e) =>
                        setSurface(index, {
                          contractRole: e.target.value as ContractRole
                        })
                      }
                    >
                      {CONTRACT_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {t(`business.contractRole_${role}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            <div className="business-policy-section">
              <h5>{t("business.advancedSettings")}</h5>
              <div className="business-policy-grid">
                <label className="workflow-team-editor-toggle">
                  <input
                    type="checkbox"
                    checked={draft.policy.requireCleanRepoBeforeRun}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        policy: {
                          ...draft.policy,
                          requireCleanRepoBeforeRun: e.target.checked
                        }
                      })
                    }
                  />
                  <span>{t("business.requireCleanRepoBeforeRun")}</span>
                </label>
                <label className="workflow-team-editor-toggle">
                  <input
                    type="checkbox"
                    checked={draft.policy.blockCommitOnVerificationFailure}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        policy: {
                          ...draft.policy,
                          blockCommitOnVerificationFailure: e.target.checked
                        }
                      })
                    }
                  />
                  <span>{t("business.blockCommitOnVerificationFailure")}</span>
                </label>
                <label className="workflow-team-editor-field">
                  <span>{t("business.branchNameTemplate")}</span>
                  <input
                    type="text"
                    value={draft.policy.branchNameTemplate}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        policy: {
                          ...draft.policy,
                          branchNameTemplate: e.target.value
                        }
                      })
                    }
                  />
                </label>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="business-editor-footer">
        <div className="business-editor-footer-left">
          {editorTab !== "general" && (
            <button
              type="button"
              className="business-nav-prev-btn"
              onClick={goToPreviousTab}
            >
              ← {t("common.prev")}
            </button>
          )}
        </div>
        <div className="business-editor-footer-right">
          {editorTab !== "policies" ? (
            <button
              type="button"
              className="primary business-nav-next-btn"
              onClick={goToNextTab}
              disabled={editorTab === "repos" && draft.surfaces.length === 0}
            >
              {t("common.next")} →
            </button>
          ) : (
            <button
              type="button"
              className="primary business-save-btn"
              onClick={() => void handleSave()}
            >
              {isNew ? t("business.createWorkspace") : t("common.save")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
