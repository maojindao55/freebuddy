import { useEffect, useState } from "react";
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
        verifyCommands: ["npm run build"],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer"
      },
      {
        id: "server",
        nameKey: "business.repoServer",
        kind: "server",
        allowedPaths: ["src", "app", "routes", "database"],
        verifyCommands: ["npm test"],
        responsibilities: ["API", "business rules", "persistence"],
        contractRole: "provider"
      },
      {
        id: "admin",
        nameKey: "business.repoAdmin",
        kind: "admin",
        allowedPaths: ["src", "app", "pages"],
        verifyCommands: ["npm run build"],
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
        verifyCommands: ["npm run build"],
        responsibilities: ["UI", "API consumption"],
        contractRole: "consumer"
      },
      {
        id: "server",
        nameKey: "business.repoServer",
        kind: "server",
        allowedPaths: ["src", "app", "routes", "database"],
        verifyCommands: ["npm test"],
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
        verifyCommands: ["npm test"],
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
      verifyCommands: ["npm run build"],
      responsibilities: kind === "client" ? ["UI", "API consumption"] : ["Admin UI", "API consumption"],
      contractRole: "consumer" as ContractRole
    };
  }
  if (kind === "server") {
    return {
      allowedPaths: ["src", "app", "routes", "database"],
      verifyCommands: ["npm test"],
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
  const [draft, setDraft] = useState<BusinessWorkspace>(() =>
    workspace ? structuredClone(workspace) : emptyWorkspace()
  );
  const selectedTemplateId = matchTemplate(draft.surfaces);
  const [errors, setErrors] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);

  useEffect(() => {
    setDraft(workspace ? structuredClone(workspace) : emptyWorkspace());
    setErrors([]);
    setNameError(false);
  }, [workspace]);

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
    <div className="business-workspace-editor">
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

      {errors.length > 0 && (
        <ul className="workflow-team-editor-errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <section className="workflow-team-editor-section">
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
        <div className="business-workspace-template-picker">
          <span className="muted small">{t("business.structureTemplate")}</span>
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
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="workflow-team-editor-section">
        <h5>{t("business.codeRepositories")}</h5>
        {draft.surfaces.length === 0 ? (
          <p className="muted small">{t("business.noRepositories")}</p>
        ) : (
          <div className="business-workspace-surfaces">
            {draft.surfaces.map((surface, index) => (
              <div key={index} className="business-surface-row">
                <div className="business-surface-row-header">
                  <strong>{surface.name || t("business.codeRepository")}</strong>
                  <span className={`workflow-team-badge business-kind-badge tone-${KIND_META[surface.kind].tone}`}>
                    {KIND_META[surface.kind].icon} {t(KIND_META[surface.kind].labelKey)}
                  </span>
                </div>
                <div className="business-surface-grid">
                  <label className="workflow-team-editor-field">
                    <span>{t("business.repositoryName")}</span>
                    <input
                      type="text"
                      value={surface.name}
                      onChange={(e) => setSurface(index, { name: e.target.value })}
                    />
                  </label>
                  <label className="workflow-team-editor-field">
                    <span>{t("business.repositoryType")}</span>
                    <select
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
                  </label>
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
                  <label className="workflow-team-editor-field">
                    <span>{t("business.verifyCommands")}</span>
                    <textarea
                      rows={2}
                      value={joinLines(surface.verifyCommands)}
                      placeholder={t("business.verifyCommandsHint")}
                      onChange={(e) =>
                        setSurface(index, { verifyCommands: splitLines(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <details className="business-repository-advanced">
                  <summary>{t("business.repositoryAdvanced")}</summary>
                  <div className="business-surface-grid">
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
                    <label className="workflow-team-editor-field">
                      <span>{t("business.responsibilities")}</span>
                      <textarea
                        rows={2}
                        value={joinLines(surface.responsibilities)}
                        onChange={(e) =>
                          setSurface(index, { responsibilities: splitLines(e.target.value) })
                        }
                      />
                    </label>
                    <label className="workflow-team-editor-toggle">
                      <input
                        type="checkbox"
                        checked={surface.enabled}
                        onChange={(e) =>
                          setSurface(index, { enabled: e.target.checked })
                        }
                      />
                      <span>{t("business.repositoryEnabled")}</span>
                    </label>
                  </div>
                </details>
                <div className="business-surface-row-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => removeSurface(index)}
                  >
                    {t("common.delete")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <button type="button" onClick={() => addSurface()}>
          + {t("business.codeRepository")}
        </button>
      </section>

      {draft.surfaces.length > 0 && (
        <section className="workflow-team-editor-section">
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
        </section>
      )}

      <details className="workflow-team-editor-section business-workspace-advanced">
        <summary>{t("business.advancedSettings")}</summary>
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
      </details>
    </div>
  );
}
