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

const splitLines = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const joinLines = (value: string[]): string => value.join("\n");

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
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    setDraft(workspace ? structuredClone(workspace) : emptyWorkspace());
    setErrors([]);
  }, [workspace]);

  const setSurface = (index: number, patch: Partial<BusinessSurface>) => {
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.map((s, i) => (i === index ? { ...s, ...patch } : s))
    }));
  };

  const addSurface = () => {
    setDraft((d) => ({
      ...d,
      surfaces: [...d.surfaces, emptySurface(d.surfaces.length)]
    }));
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
      setErrors([t("business.workspaceName")]);
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
      setErrors(["save failed"]);
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
            {t("common.save")}
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
        <label className="workflow-team-editor-field">
          <span>{t("business.workspaceName")}</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t("business.workspaceName")}
          />
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

      <section className="workflow-team-editor-section">
        <h5>{t("business.surfaces")}</h5>
        {draft.surfaces.length === 0 ? (
          <p className="muted small">{t("business.noWorkspaces")}</p>
        ) : (
          <div className="business-workspace-surfaces">
            {draft.surfaces.map((surface, index) => (
              <div key={index} className="business-surface-row">
                <div className="business-surface-grid">
                  <label className="workflow-team-editor-field">
                    <span>{t("workflow.teamName")}</span>
                    <input
                      type="text"
                      value={surface.name}
                      onChange={(e) => setSurface(index, { name: e.target.value })}
                    />
                  </label>
                  <label className="workflow-team-editor-field">
                    <span>{t("workflow.teamRoles")}</span>
                    <select
                      value={surface.kind}
                      onChange={(e) =>
                        setSurface(index, {
                          kind: e.target.value as BusinessSurfaceKind
                        })
                      }
                    >
                      {SURFACE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
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
                        …
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
                    <span>{t("business.contractRole")}</span>
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
                          {role}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="workflow-team-editor-toggle">
                    <input
                      type="checkbox"
                      checked={surface.enabled}
                      onChange={(e) =>
                        setSurface(index, { enabled: e.target.checked })
                      }
                    />
                    <span>{t("business.surface")}</span>
                  </label>
                </div>
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
                  <span>{t("business.verifyCommands")}</span>
                  <textarea
                    rows={2}
                    value={joinLines(surface.verifyCommands)}
                    onChange={(e) =>
                      setSurface(index, { verifyCommands: splitLines(e.target.value) })
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
        <button type="button" onClick={addSurface}>
          + {t("business.surface")}
        </button>
      </section>
    </div>
  );
}
