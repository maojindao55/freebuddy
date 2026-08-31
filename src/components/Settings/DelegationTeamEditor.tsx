import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Typography
} from "antd";
import { useTranslation } from "react-i18next";
import { validateDelegationTeam } from "@freebuddy/protocol/delegation";

import { cliClient } from "@/services/cli/client";
import type {
  SessionConfigOption,
  SessionConfigProbeInput
} from "@/services/cli/types";
import type {
  DelegationPolicy,
  DelegationRosterEntry
} from "@/services/workflowTeams/types";
import { useDelegationTeamStore } from "@/store/delegationStore";
import { useConversationStore } from "@/store/conversationStore";
import { useCliExecutorStore } from "@/store/cliExecutorStore";

const { TextArea } = Input;

function defaultPolicy(): DelegationPolicy {
  return {
    allowWrites: true,
    requireApprovalBeforeDelegateWrite: true,
    maxDepth: 3,
    delegateTimeoutMs: 600000,
    maxConcurrentDelegates: 1,
    stopOnDelegateFailure: false
  };
}

function newEntry(id: string): DelegationRosterEntry {
  return { id, label: "", agentId: "", capability: "", canWrite: false };
}

export function DelegationTeamEditor({
  teamId,
  onDone
}: {
  teamId?: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useDelegationTeamStore((s) => s.create);
  const update = useDelegationTeamStore((s) => s.update);
  const existing = useDelegationTeamStore((s) =>
    teamId ? s.getById(teamId) : undefined
  );
  const members = useConversationStore((s) => s.members);

  const agentOptions = useMemo(
    () => members.map((m) => ({ value: m.id, label: m.name })),
    [members]
  );

  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [sharedInstructions, setSharedInstructions] = useState(
    existing?.sharedInstructions ?? ""
  );
  const [roster, setRoster] = useState<DelegationRosterEntry[]>(
    existing?.roster && existing.roster.length > 0
      ? existing.roster
      : [newEntry("r-1")]
  );
  const [entryRoleId, setEntryRoleId] = useState(existing?.entryRoleId ?? "r-1");
  const [policy, setPolicy] = useState<DelegationPolicy>(
    existing?.policy ?? defaultPolicy()
  );
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (existing) {
      setName(existing.name);
      setDescription(existing.description ?? "");
      setSharedInstructions(existing.sharedInstructions ?? "");
      setRoster(
        existing.roster.length > 0 ? existing.roster : [newEntry("r-1")]
      );
      setEntryRoleId(existing.entryRoleId);
      setPolicy(existing.policy);
    } else {
      setName("");
      setDescription("");
      setSharedInstructions("");
      setRoster([newEntry("r-1")]);
      setEntryRoleId("r-1");
      setPolicy(defaultPolicy());
    }
    setErrors([]);
  }, [existing]);

  const [modelOptionsByAgent, setModelOptionsByAgent] = useState<
    Record<string, SessionConfigOption[]>
  >({});
  const [modelLoadingByAgent, setModelLoadingByAgent] = useState<
    Record<string, boolean>
  >({});
  const modelProbeInFlightRef = useRef(new Set<string>());
  const modelRefreshedRef = useRef(new Set<string>());

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

  const rosterAgentIdsKey = useMemo(
    () =>
      Array.from(new Set(roster.map((r) => r.agentId).filter(Boolean)))
        .sort()
        .join("\u0000"),
    [roster]
  );

  useEffect(() => {
    if (!rosterAgentIdsKey || !cliClient.isAvailable()) return;
    let cancelled = false;
    const agentIds = rosterAgentIdsKey.split("\u0000");
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
  }, [rosterAgentIdsKey, sessionProbeInputForAgent]);

  const refreshEntryModels = async (agentId: string) => {
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

  const setEntry = (patch: Partial<DelegationRosterEntry>, id: string) =>
    setRoster((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const setEntryAgent = (id: string, agentId: string) =>
    setRoster((rs) =>
      rs.map((r) =>
        r.id === id
          ? { ...r, agentId, model: undefined, modelOptionId: undefined }
          : r
      )
    );

  const setEntryModel = (
    id: string,
    model: string,
    modelOptionId: string
  ) =>
    setRoster((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              model: model.trim() || undefined,
              modelOptionId: model.trim() ? modelOptionId : undefined
            }
          : r
      )
    );

  const modelOptionForAgent = (agentId: string): SessionConfigOption | undefined =>
    (modelOptionsByAgent[agentId] ?? []).find(
      (entry) => entry.category === "model"
    ) ??
    (modelOptionsByAgent[agentId] ?? []).find((entry) => entry.id === "model");

  const addEntry = () =>
    setRoster((rs) => [...rs, newEntry(`r-${Date.now().toString(36)}`)]);

  const removeEntry = (id: string) =>
    setRoster((rs) => rs.filter((r) => r.id !== id));

  const save = async () => {
    if (!name.trim()) {
      setErrors([t("workflow.teamNameRequired")]);
      return;
    }
    const invalidRoster =
      roster.length === 0 ||
      roster.some((r) => !r.label.trim() || !r.agentId.trim() || !r.capability.trim());
    if (invalidRoster) {
      setErrors([t("workflow.delegation.errors.invalidRoster")]);
      return;
    }
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedSharedInstructions = sharedInstructions.trim();
    const finalRoster = roster.map((role) => ({
      ...role,
      capability: role.capability.trim(),
      instructions: role.instructions?.trim() || undefined
    }));
    const finalEntryRoleId = roster.some((r) => r.id === entryRoleId)
      ? entryRoleId
      : (roster[0]?.id ?? entryRoleId);
    const validation = validateDelegationTeam({
      name: trimmedName,
      entryRoleId: finalEntryRoleId,
      roster: finalRoster,
      policy
    });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors([]);
    try {
      if (existing) {
        await update(existing.id, {
          name: trimmedName,
          description: trimmedDescription || null,
          sharedInstructions: trimmedSharedInstructions || null,
          enabled: existing.enabled,
          entryRoleId: finalEntryRoleId,
          roster: finalRoster,
          policy
        });
      } else {
        await create({
          id: `team-delegation-${Date.now().toString(36)}`,
          name: trimmedName,
          description: trimmedDescription || undefined,
          sharedInstructions: trimmedSharedInstructions || undefined,
          enabled: true,
          source: "user",
          entryRoleId: finalEntryRoleId,
          roster: finalRoster,
          policy
        });
      }
      onDone();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : t("errors.unknown")]);
    }
  };

  return (
    <Card
      title={t("workflow.delegation.editorTitle")}
      extra={
        <Space>
          <Button onClick={onDone}>{t("common.cancel")}</Button>
          <Button type="primary" onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </Space>
      }
    >
      {errors.length > 0 && (
        <Space direction="vertical" style={{ width: "100%", marginBottom: 12 }}>
          {errors.map((e, i) => (
            <Typography.Text key={i} type="danger">
              {e}
            </Typography.Text>
          ))}
        </Space>
      )}

      <Typography.Text strong>
        {t("workflow.delegation.overview")}
      </Typography.Text>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("workflow.delegation.namePlaceholder")}
        style={{ marginTop: 8 }}
      />
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("workflow.delegation.descriptionPlaceholder")}
        style={{ marginTop: 8 }}
      />
      <TextArea
        value={sharedInstructions}
        onChange={(e) => setSharedInstructions(e.target.value)}
        placeholder={t("workflow.delegation.sharedInstructionsPlaceholder")}
        autoSize={{ minRows: 2 }}
        style={{ marginTop: 8 }}
      />
      <Typography.Text type="secondary">
        {t("workflow.delegation.sharedInstructionsHelp")}
      </Typography.Text>

      <Typography.Text strong style={{ display: "block", marginTop: 16 }}>
        {t("workflow.delegation.roster")}
      </Typography.Text>
      {roster.map((r) => (
        <Card key={r.id} size="small" style={{ marginTop: 8 }}>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Input
              value={r.label}
              onChange={(e) => setEntry({ label: e.target.value }, r.id)}
              placeholder={t("workflow.delegation.labelPlaceholder")}
            />
            <Select
              value={r.agentId || undefined}
              options={agentOptions}
              onChange={(v: string) => setEntryAgent(r.id, v)}
              placeholder={t("workflow.delegation.agentPlaceholder")}
              style={{ width: "100%" }}
              showSearch
              optionFilterProp="label"
            />
            <Select
              value={r.model || undefined}
              options={(() => {
                const option = modelOptionForAgent(r.agentId);
                const values = [...(option?.values ?? [])];
                if (r.model && !values.some((v) => v.id === r.model)) {
                  values.unshift({ id: r.model, name: r.model });
                }
                return [
                  { value: "", label: t("workflow.defaultModel") },
                  ...values.map((v) => ({
                    value: v.id,
                    label: v.name || v.id
                  }))
                ];
              })()}
              onChange={(v: string) =>
                setEntryModel(
                  r.id,
                  v,
                  modelOptionForAgent(r.agentId)?.id ?? r.modelOptionId ?? "model"
                )
              }
              onFocus={() => void refreshEntryModels(r.agentId)}
              placeholder={t("workflow.currentModel")}
              style={{ width: "100%" }}
              showSearch
              optionFilterProp="label"
              loading={
                modelLoadingByAgent[r.agentId] &&
                !(modelOptionForAgent(r.agentId)?.values?.length ?? 0)
              }
            />
            <TextArea
              value={r.capability}
              onChange={(e) => setEntry({ capability: e.target.value }, r.id)}
              placeholder={t("workflow.delegation.capabilityPlaceholder")}
              autoSize={{ minRows: 2 }}
            />
            <Typography.Text type="secondary">
              {t("workflow.delegation.capabilityHelp")}
            </Typography.Text>
            <TextArea
              value={r.instructions ?? ""}
              onChange={(e) => setEntry({ instructions: e.target.value }, r.id)}
              placeholder={t("workflow.delegation.roleInstructionsPlaceholder")}
              autoSize={{ minRows: 2 }}
            />
            <Typography.Text type="secondary">
              {t("workflow.delegation.roleInstructionsHelp")}
            </Typography.Text>
            <Space>
              <Switch
                checked={r.canWrite}
                onChange={(v) => setEntry({ canWrite: v }, r.id)}
              />
              <Typography.Text>
                {t("workflow.delegation.canWrite")}
              </Typography.Text>
              <Button size="small" danger onClick={() => removeEntry(r.id)}>
                {t("common.remove")}
              </Button>
            </Space>
          </Space>
        </Card>
      ))}
      <Button style={{ marginTop: 8 }} onClick={addEntry}>
        {t("workflow.delegation.addRosterEntry")}
      </Button>

      <Typography.Text strong style={{ display: "block", marginTop: 16 }}>
        {t("workflow.delegation.entryAgent")}
      </Typography.Text>
      <Radio.Group
        value={entryRoleId}
        onChange={(e) => setEntryRoleId(e.target.value as string)}
        style={{ marginTop: 8 }}
      >
        <Space direction="vertical">
          {roster.map((r) => (
            <Radio key={r.id} value={r.id}>
              {r.label || r.id}
            </Radio>
          ))}
        </Space>
      </Radio.Group>

      <Typography.Text strong style={{ display: "block", marginTop: 16 }}>
        {t("workflow.delegation.policy")}
      </Typography.Text>
      <Space wrap style={{ marginTop: 8 }}>
        <InputNumber
          addonAfter={t("workflow.delegation.maxDepth")}
          min={1}
          max={6}
          value={policy.maxDepth}
          onChange={(v) => setPolicy({ ...policy, maxDepth: Number(v) || 3 })}
        />
        <InputNumber
          addonAfter={t("workflow.delegation.timeoutMin")}
          min={1}
          value={Math.round(policy.delegateTimeoutMs / 60000)}
          onChange={(v) =>
            setPolicy({
              ...policy,
              delegateTimeoutMs: (Number(v) || 10) * 60000
            })
          }
        />
        <Space>
          <Switch
            checked={policy.allowWrites}
            onChange={(v) => setPolicy({ ...policy, allowWrites: v })}
          />
          <Typography.Text>
            {t("workflow.delegation.allowWrites")}
          </Typography.Text>
        </Space>
        <Space>
          <Switch
            checked={policy.requireApprovalBeforeDelegateWrite}
            onChange={(v) =>
              setPolicy({ ...policy, requireApprovalBeforeDelegateWrite: v })
            }
          />
          <Typography.Text>
            {t("workflow.delegation.requireApprovalBeforeDelegateWrite")}
          </Typography.Text>
        </Space>
        <Space>
          <Switch
            checked={policy.stopOnDelegateFailure}
            onChange={(v) => setPolicy({ ...policy, stopOnDelegateFailure: v })}
          />
          <Typography.Text>
            {t("workflow.delegation.stopOnDelegateFailure")}
          </Typography.Text>
        </Space>
      </Space>
    </Card>
  );
}
