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
import {
  findMainModelConfigOption,
  findProviderConfigOption
} from "@/utils/sessionConfigOptions";
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
    (agentId: string, provider?: string): SessionConfigProbeInput | undefined => {
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
        env: { ...(resolved?.env ?? {}), ...(member.cli.env ?? {}) },
        configOptionOverrides: provider ? { provider } : undefined
      };
    },
    [members]
  );

  const getAgentOptionsKey = (agentId: string, provider?: string) =>
    provider ? `${agentId}:${provider}` : agentId;

  const rosterConfigKey = useMemo(
    () =>
      Array.from(
        new Set(
          roster
            .map((r) =>
              r.agentId ? `${r.agentId}|${r.provider ?? ""}` : ""
            )
            .filter(Boolean)
        )
      )
        .sort()
        .join("\u0000"),
    [roster]
  );

  useEffect(() => {
    if (!rosterConfigKey || !cliClient.isAvailable()) return;
    let cancelled = false;
    const items = rosterConfigKey.split("\u0000").map((pair) => {
      const [agentId, provider] = pair.split("|");
      return { agentId, provider: provider || undefined };
    });
    void Promise.all(
      items.map(async ({ agentId, provider }) => {
        const input = sessionProbeInputForAgent(agentId, provider);
        const key = getAgentOptionsKey(agentId, provider);
        if (!input) return [key, [] as SessionConfigOption[]] as const;
        try {
          return [
            key,
            await cliClient.getCachedSessionConfigOptions(input)
          ] as const;
        } catch {
          return [key, [] as SessionConfigOption[]] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setModelOptionsByAgent((current) => {
        const next = { ...current };
        for (const [key, options] of entries) {
          if (options.length > 0) next[key] = options;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rosterConfigKey, sessionProbeInputForAgent]);

  const refreshEntryModels = async (agentId: string, provider?: string) => {
    const key = getAgentOptionsKey(agentId, provider);
    if (
      !cliClient.isAvailable() ||
      modelRefreshedRef.current.has(key) ||
      modelProbeInFlightRef.current.has(key)
    ) {
      return;
    }
    const input = sessionProbeInputForAgent(agentId, provider);
    if (!input) return;
    modelProbeInFlightRef.current.add(key);
    setModelLoadingByAgent((current) => ({ ...current, [key]: true }));
    try {
      const options = await cliClient.inspectSessionConfigOptions(input);
      if (options.length > 0) {
        modelRefreshedRef.current.add(key);
        setModelOptionsByAgent((current) => ({
          ...current,
          [key]: options
        }));
      }
    } catch {
      // Keep any persisted options and allow another refresh attempt.
    } finally {
      modelProbeInFlightRef.current.delete(key);
      setModelLoadingByAgent((current) => ({ ...current, [key]: false }));
    }
  };

  const setEntry = (patch: Partial<DelegationRosterEntry>, id: string) =>
    setRoster((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const setEntryAgent = (id: string, agentId: string) =>
    setRoster((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              agentId,
              provider: undefined,
              providerOptionId: undefined,
              model: undefined,
              modelOptionId: undefined,
              thoughtLevel: undefined,
              thoughtLevelOptionId: undefined
            }
          : r
      )
    );

  const setEntryProvider = async (
    id: string,
    agentId: string,
    provider: string,
    providerOptionId: string
  ) => {
    const nextProvider = provider.trim() || undefined;
    setRoster((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              provider: nextProvider,
              providerOptionId: nextProvider ? providerOptionId : undefined,
              model: undefined,
              modelOptionId: undefined
            }
          : r
      )
    );
    if (nextProvider) {
      const key = getAgentOptionsKey(agentId, nextProvider);
      if (!modelOptionsByAgent[key]) {
        const input = sessionProbeInputForAgent(agentId, nextProvider);
        if (input) {
          try {
            const cached = await cliClient.getCachedSessionConfigOptions(input);
            if (cached.length > 0) {
              setModelOptionsByAgent((curr) => ({ ...curr, [key]: cached }));
            } else {
              const fresh = await cliClient.inspectSessionConfigOptions(input);
              if (fresh.length > 0) {
                setModelOptionsByAgent((curr) => ({ ...curr, [key]: fresh }));
              }
            }
          } catch {
            /* best-effort */
          }
        }
      }
    }
  };

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

  const setEntryThoughtLevel = (
    id: string,
    thoughtLevel: string,
    thoughtLevelOptionId: string
  ) =>
    setRoster((rs) =>
      rs.map((r) =>
        r.id === id
          ? {
              ...r,
              thoughtLevel: thoughtLevel.trim() || undefined,
              thoughtLevelOptionId: thoughtLevel.trim()
                ? thoughtLevelOptionId
                : undefined
            }
          : r
      )
    );

  const providerOptionForAgent = (
    agentId: string
  ): SessionConfigOption | undefined =>
    findProviderConfigOption(modelOptionsByAgent[agentId] ?? []);

  const modelOptionForAgent = (
    agentId: string,
    provider?: string
  ): SessionConfigOption | undefined => {
    const key = getAgentOptionsKey(agentId, provider);
    const options =
      modelOptionsByAgent[key] ?? modelOptionsByAgent[agentId] ?? [];
    return findMainModelConfigOption(options);
  };

  const thoughtOptionForAgent = (
    agentId: string,
    provider?: string
  ): SessionConfigOption | undefined => {
    const key = getAgentOptionsKey(agentId, provider);
    const options =
      modelOptionsByAgent[key] ?? modelOptionsByAgent[agentId] ?? [];
    return (
      options.find((entry) => entry.category === "thought_level") ??
      options.find((entry) => entry.id === "thought_level")
    );
  };

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
            {(() => {
              const providerOpt = providerOptionForAgent(r.agentId);
              if (!providerOpt?.values?.length) return null;
              return (
                <Select
                  value={r.provider || undefined}
                  options={[
                    {
                      value: "",
                      label: t("chat.providerDefault", {
                        defaultValue: "Default provider"
                      })
                    },
                    ...providerOpt.values.map((v) => ({
                      value: v.id,
                      label: v.name || v.id
                    }))
                  ]}
                  onChange={(v: string) =>
                    void setEntryProvider(
                      r.id,
                      r.agentId,
                      v,
                      providerOpt.id
                    )
                  }
                  placeholder={t("chat.provider", { defaultValue: "Provider" })}
                  style={{ width: "100%" }}
                  showSearch
                  optionFilterProp="label"
                />
              );
            })()}
            <Select
              value={r.model || undefined}
              options={(() => {
                const option = modelOptionForAgent(r.agentId, r.provider);
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
                  modelOptionForAgent(r.agentId, r.provider)?.id ??
                    r.modelOptionId ??
                    "model"
                )
              }
              onFocus={() => void refreshEntryModels(r.agentId, r.provider)}
              placeholder={t("workflow.currentModel")}
              style={{ width: "100%" }}
              showSearch
              optionFilterProp="label"
              loading={
                modelLoadingByAgent[
                  getAgentOptionsKey(r.agentId, r.provider)
                ] &&
                !(
                  modelOptionForAgent(r.agentId, r.provider)?.values?.length ??
                  0
                )
              }
            />
            <Select
              value={r.thoughtLevel || undefined}
              options={(() => {
                const option = thoughtOptionForAgent(r.agentId, r.provider);
                const values = [...(option?.values ?? [])];
                if (
                  r.thoughtLevel &&
                  !values.some((v) => v.id === r.thoughtLevel)
                ) {
                  values.unshift({ id: r.thoughtLevel, name: r.thoughtLevel });
                }
                return [
                  { value: "", label: t("workflow.defaultThoughtLevel") },
                  ...values.map((v) => ({
                    value: v.id,
                    label: v.name || v.id
                  }))
                ];
              })()}
              onChange={(v: string) =>
                setEntryThoughtLevel(
                  r.id,
                  v,
                  thoughtOptionForAgent(r.agentId, r.provider)?.id ??
                    r.thoughtLevelOptionId ??
                    "thought_level"
                )
              }
              onFocus={() => void refreshEntryModels(r.agentId, r.provider)}
              placeholder={t("workflow.currentThoughtLevel")}
              style={{ width: "100%" }}
              disabled={
                !thoughtOptionForAgent(r.agentId) &&
                !r.thoughtLevel
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
