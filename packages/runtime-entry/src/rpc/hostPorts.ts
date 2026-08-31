import { randomUUID } from "node:crypto";
import type { WorkflowRunRow, WorkflowStepRow } from "@freebuddy/protocol/workflow";
import type {
  DelegationEvent,
  DelegationRunRow,
  DelegationTeam
} from "@freebuddy/protocol/delegation";
import type { WorkflowRuntimePorts } from "@freebuddy/workflow-runtime";
import { createMemoryWorkflowRepository } from "@freebuddy/workflow-runtime";
import type { DelegationRuntimePorts } from "@freebuddy/delegation-runtime";
import { createMemoryDelegationRepository } from "@freebuddy/delegation-runtime";
import type { RuntimeRpcPeer } from "./peer.js";

export type CachedAgent = {
  id: string;
  adapter: string;
  agentName: string;
  skillIds?: string[];
};

export interface HostPortController {
  prepare(): Promise<void>;
  hydrateWorkflow(runId: string): Promise<void>;
  hydrateDelegation(runId: string): Promise<void>;
  flush(): Promise<void>;
  cacheOwned(conversationId: string, value: boolean): void;
  cacheAgent(agent: CachedAgent): void;
  cacheTeam(team: DelegationTeam): void;
}

export function createHostBackedPorts(peer: RuntimeRpcPeer): {
  workflow: WorkflowRuntimePorts;
  delegation: DelegationRuntimePorts;
  controller: HostPortController;
} {
  const memory = createMemoryWorkflowRepository();
  const delegationMemory = createMemoryDelegationRepository();
  const pending = new Set<Promise<void>>();
  let lastWriteError: Error | undefined;
  const agents = new Map<string, CachedAgent>();
  const owned = new Map<string, boolean>();
  const messages = new Map<string, Array<Record<string, unknown>>>();
  const toolSessions = new Map<string, string>();
  const teams = new Map<string, DelegationTeam>();
  let language = "en";
  let prepared = false;

  function enqueue(op: () => Promise<unknown>): void {
    const task = Promise.resolve()
      .then(op)
      .then(
        () => undefined,
        (error) => {
          lastWriteError = error instanceof Error ? error : new Error(String(error));
        }
      )
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  }

  async function invoke<T>(
    method: string,
    args: unknown,
    options?: { timeoutMs?: number; idempotencyKey?: string }
  ): Promise<T> {
    return (await peer.request("host.invoke", { method, args }, options)) as T;
  }

  function insertKey(scope: string, entityId: string): string {
    return `${scope}:${entityId}`;
  }

  function operationKey(scope: string): string {
    return `${scope}:${randomUUID()}`;
  }

  function resolveCachedAgent(agentId: string) {
    const agent = agents.get(agentId);
    if (!agent) return undefined;
    return {
      adapter: agent.adapter,
      agentName: agent.agentName,
      skillIds: agent.skillIds
    };
  }

  const controller: HostPortController = {
    async prepare() {
      if (prepared) return;
      const listed = await invoke<CachedAgent[]>("agent.list.v1", []).catch(() => []);
      for (const agent of listed ?? []) {
        if (agent?.id) agents.set(agent.id, agent);
      }
      language = (await invoke<string>("language.get.v1", []).catch(() => "en")) ?? "en";
      prepared = true;
    },
    async hydrateWorkflow(runId: string) {
      await controller.prepare();
      if (memory.getRun(runId)) return;
      const run = await invoke<WorkflowRunRow | null>("workflow.repository.v1.getRun", [runId]);
      if (!run) return;
      memory.hydrateRun(run);
      memory.hydrateSteps(
        runId,
        (await invoke<WorkflowStepRow[]>("workflow.repository.v1.getSteps", [runId])) ?? []
      );
      if (run.conversationId) {
        owned.set(
          run.conversationId,
          Boolean(
            await invoke("workflow.conversations.v1.requireOwned", [run.conversationId]).catch(
              () => false
            )
          )
        );
        messages.set(
          run.conversationId,
          ((await invoke("workflow.conversations.v1.listMessages", [run.conversationId]).catch(
            () => []
          )) as Array<Record<string, unknown>>) ?? []
        );
      }
    },
    async hydrateDelegation(runId: string) {
      await controller.prepare();
      if (delegationMemory.getRun(runId)) return;
      const run = await invoke<DelegationRunRow | null>("delegation.repository.v1.getRun", [runId]);
      if (!run) return;
      delegationMemory.hydrateRun(run);
      for (const event of (await invoke<DelegationEvent[]>(
        "delegation.repository.v1.listEvents",
        [runId]
      )) ?? []) {
        delegationMemory.hydrateEvent(event);
      }
    },
    async flush() {
      await Promise.all([...pending]);
      if (lastWriteError) {
        const error = lastWriteError;
        lastWriteError = undefined;
        throw error;
      }
    },
    cacheOwned(conversationId, value) {
      owned.set(conversationId, value);
    },
    cacheAgent(agent) {
      agents.set(agent.id, agent);
    },
    cacheTeam(team) {
      teams.set(team.id, team);
    }
  };

  const workflow: WorkflowRuntimePorts = {
    repository: {
      createRun(input) {
        const stamped = {
          ...input,
          runtimeVersion: input.runtimeVersion ?? process.env.FB_RUNTIME_VERSION ?? "bundled",
          runtimeApiVersion: input.runtimeApiVersion ?? "1.0.0"
        };
        const run = memory.createRun(stamped);
        enqueue(() =>
          invoke("workflow.repository.v1.createRun", [{ ...stamped, id: run.id }], {
            idempotencyKey: insertKey("workflow.createRun", run.id)
          })
        );
        return run;
      },
      getRun: (id) => memory.getRun(id),
      updateRun(id, patch) {
        memory.updateRun(id, patch);
        enqueue(() => invoke("workflow.repository.v1.updateRun", [id, patch], {
          idempotencyKey: operationKey(`workflow.updateRun:${id}`)
        }));
      },
      createStep(input) {
        memory.createStep(input);
        enqueue(() =>
          invoke("workflow.repository.v1.createStep", [input], {
            idempotencyKey: insertKey("workflow.createStep", input.id)
          })
        );
      },
      getSteps: (runId) => memory.getSteps(runId),
      updateStep(id, patch) {
        memory.updateStep(id, patch);
        enqueue(() => invoke("workflow.repository.v1.updateStep", [id, patch], {
          idempotencyKey: operationKey(`workflow.updateStep:${id}`)
        }));
      },
      resetStepsForLoop(runId, phaseIds) {
        memory.resetStepsForLoop(runId, phaseIds);
        enqueue(() =>
          invoke("workflow.repository.v1.resetStepsForLoop", [runId, phaseIds], {
            idempotencyKey: operationKey(`workflow.resetStepsForLoop:${runId}`)
          })
        );
      }
    },
    conversations: {
      requireOwned(conversationId) {
        return owned.get(conversationId) ?? true;
      },
      listMessages(conversationId) {
        return (messages.get(conversationId) ?? []) as never;
      },
      appendMessage(input) {
        const payload = { id: randomUUID(), ...(input as Record<string, unknown>) } as Record<
          string,
          unknown
        >;
        const conversationId = String(payload.conversationId ?? "");
        if (conversationId) {
          const list = messages.get(conversationId) ?? [];
          list.push(payload);
          messages.set(conversationId, list);
        }
        enqueue(() => invoke("workflow.conversations.v1.appendMessage", [payload], {
          idempotencyKey: insertKey("workflow.appendMessage", String(payload.id ?? ""))
        }));
        return payload;
      },
      updateMessage(input) {
        enqueue(() => invoke("workflow.conversations.v1.updateMessage", [input]));
      }
    },
    executor: {
      async run(args) {
        const requestId = args.sessionId;
        const off = peer.onEvent("agent.event", (payload) => {
          const body = payload as { requestId?: string; event?: Parameters<typeof args.onEvent>[0] };
          if (body?.requestId === requestId && body.event) args.onEvent(body.event);
        });
        try {
          const result = await invoke<{ ok?: boolean; error?: string; toolSessionId?: string }>(
            "agent.execute.v1",
            [
              {
                requestId,
                sessionId: args.sessionId,
                conversationId: args.conversationId,
                agentId: args.agentId,
                agentName: args.agentName,
                adapter: args.adapter,
                configOptionOverrides: args.configOptionOverrides,
                skillIds: args.skillIds,
                prompt: args.prompt,
                promptAttachments: args.promptAttachments,
                toolSessionScope: args.toolSessionScope,
                toolSessionId: args.toolSessionId,
                resumeToolSession: args.resumeToolSession,
                cwd: args.cwd,
                workspaceAccess: args.workspaceAccess
              }
            ],
            { timeoutMs: 0, idempotencyKey: `agent.execute:${requestId}` }
          );
          if (result?.toolSessionId && args.toolSessionScope) {
            toolSessions.set(`${args.agentId}:${args.toolSessionScope}`, result.toolSessionId);
          }
          if (result?.ok === false) throw new Error(result.error ?? "agent execute failed");
        } finally {
          off();
        }
      }
    },
    resolveAgent: resolveCachedAgent,
    events: {
      publish(channel, payload) {
        enqueue(() => invoke("events.publish.v1", [{ channel, payload }]));
      }
    },
    telemetry: {
      track(event, properties) {
        enqueue(() => invoke("telemetry.track.v1", [{ event, properties }]));
      }
    },
    language: {
      getLanguage: () => language,
      applyPreference: (prompt) => prompt
    },
    toolSessions: {
      get(agentId, scope) {
        const sessionId = toolSessions.get(`${agentId}:${scope}`);
        return sessionId ? { sessionId } : undefined;
      }
    },
    killSession(sessionId) {
      enqueue(() => invoke("agent.kill.v1", [{ sessionId }]));
    }
  };

  const delegation: DelegationRuntimePorts = {
    repository: {
      createRun(input) {
        const stamped = {
          ...input,
          runtimeVersion: input.runtimeVersion ?? process.env.FB_RUNTIME_VERSION ?? "bundled",
          runtimeApiVersion: input.runtimeApiVersion ?? "1.0.0"
        };
        const run = delegationMemory.createRun(stamped);
        enqueue(() =>
          invoke("delegation.repository.v1.createRun", [{ ...stamped, id: run.id }], {
            idempotencyKey: insertKey("delegation.createRun", run.id)
          })
        );
        return run;
      },
      getRun: (id) => delegationMemory.getRun(id),
      setStatus(id, status, options) {
        const ok = delegationMemory.setStatus(id, status, options);
        enqueue(() => invoke("delegation.repository.v1.setStatus", [id, status, options], {
          idempotencyKey: operationKey(`delegation.setStatus:${id}`)
        }));
        return ok;
      },
      insertEvent(input) {
        const id = delegationMemory.insertEvent(input);
        enqueue(() =>
          invoke("delegation.repository.v1.insertEvent", [{ ...input, id }], {
            idempotencyKey: insertKey("delegation.insertEvent", id)
          })
        );
        return id;
      },
      updateEvent(id, patch) {
        delegationMemory.updateEvent(id, patch);
        enqueue(() => invoke("delegation.repository.v1.updateEvent", [id, patch], {
          idempotencyKey: operationKey(`delegation.updateEvent:${id}`)
        }));
      },
      transitionEvent(id, to, resultSummary, options) {
        const ok = delegationMemory.transitionEvent(id, to, resultSummary, options);
        enqueue(() =>
          invoke("delegation.repository.v1.transitionEvent", [id, to, resultSummary, options], {
            idempotencyKey: operationKey(`delegation.transitionEvent:${id}`)
          })
        );
        return ok;
      },
      getEvent: (id) => delegationMemory.getEvent(id),
      listEvents: (runId) => delegationMemory.listEvents(runId),
      listPendingChildEvents: (runId, parentEventId) =>
        delegationMemory.listPendingChildEvents(runId, parentEventId),
      countActiveDelegateLeaves: (runId) => delegationMemory.countActiveDelegateLeaves(runId),
      cancelActiveEvents(runId, reason) {
        const ids = delegationMemory.cancelActiveEvents(runId, reason);
        enqueue(() =>
          invoke("delegation.repository.v1.cancelActiveEvents", [runId, reason], {
            idempotencyKey: operationKey(`delegation.cancelActiveEvents:${runId}`)
          })
        );
        return ids;
      },
      getOwnerId: (runId) => delegationMemory.getOwnerId?.(runId)
    },
    executor: {
      async run(request, onEvent) {
        const requestId = request.sessionId;
        const off = peer.onEvent("agent.event", (payload) => {
          const body = payload as { requestId?: string; event?: Parameters<typeof onEvent>[0] };
          if (body?.requestId === requestId && body.event) onEvent(body.event);
        });
        try {
          await invoke(
            "agent.execute.v1",
            [
              {
                requestId,
                sessionId: request.sessionId,
                conversationId: request.conversationId,
                agentId: request.agentId,
                agentName: request.agentName,
                adapter: request.adapter,
                skillIds: request.skillIds,
                prompt: request.prompt,
                cwd: request.cwd,
                workspaceAccess: request.workspaceAccess
              }
            ],
            { timeoutMs: 0, idempotencyKey: `agent.execute:${requestId}` }
          );
        } finally {
          off();
        }
      },
      kill(sessionId) {
        enqueue(() => invoke("agent.kill.v1", [{ sessionId }]));
      }
    },
    events: {
      publish(channel, payload) {
        enqueue(() => invoke("events.publish.v1", [{ channel, payload }]));
      }
    },
    approval: {
      async request(input) {
        return Boolean(
          await invoke<boolean>("delegation.approval.v1.request", [input]).catch(() => true)
        );
      }
    },
    clock: {
      now: () => new Date(),
      nowIso: () => new Date().toISOString()
    },
    ids: { id: () => randomUUID() },
    skills: {
      resolve(skillIds) {
        return (skillIds ?? []).map((id) => ({ id }));
      }
    },
    resolveAgent: resolveCachedAgent,
    getTeam(id) {
      return teams.get(id);
    },
    killSession(sessionId) {
      enqueue(() => invoke("agent.kill.v1", [{ sessionId }]));
    }
  };

  return { workflow, delegation, controller };
}
