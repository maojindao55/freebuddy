/**
 * Typed read-only RPC surface.
 *
 * Pages only ever call these wrappers. There is deliberately **no** `call(method, params)`
 * escape hatch, and no write wrapper exists in this substage (no conversation.send, no
 * run.stop, no permission/authentication response, no terminal anything): the read-only surface
 * is a compile-time boundary, not a UI convention. `services/rpcClient.ts` enforces the same
 * rule at runtime.
 *
 * Every method name and shape below comes from `RemoteMethodParamsMap` /
 * `RemoteMethodResultMap` in the generated binding, i.e. from `protocol/remote/v1`.
 */

import type {
  HostStatus,
  RemoteId,
  RemotePageParams,
  RemoteMethodResultMap,
  SnapshotPayload
} from "../protocol/remote.generated";
import type { RpcClient, RpcResult } from "./rpcClient";

export interface ReadRpcApi {
  hostStatus(): Promise<RpcResult<HostStatus>>;
  syncSnapshot(conversationLimit?: number): Promise<RpcResult<SnapshotPayload>>;
  listProjects(page?: RemotePageParams): Promise<RpcResult<RemoteMethodResultMap["project.list"]>>;
  listAgents(
    page?: RemotePageParams & { projectId?: RemoteId }
  ): Promise<RpcResult<RemoteMethodResultMap["agent.list"]>>;
  listConversations(
    page?: RemotePageParams & { projectId?: RemoteId }
  ): Promise<RpcResult<RemoteMethodResultMap["conversation.list"]>>;
  getConversation(
    conversationId: RemoteId
  ): Promise<RpcResult<RemoteMethodResultMap["conversation.get"]>>;
  listMessages(
    conversationId: RemoteId,
    page?: RemotePageParams
  ): Promise<RpcResult<RemoteMethodResultMap["message.list"]>>;
  listTasks(
    page?: RemotePageParams & { projectId?: RemoteId; conversationId?: RemoteId }
  ): Promise<RpcResult<RemoteMethodResultMap["task.list"]>>;
  readTaskLog(
    taskId: RemoteId,
    page?: RemotePageParams
  ): Promise<RpcResult<RemoteMethodResultMap["task.readLog"]>>;
  listWorkflows(page?: RemotePageParams): Promise<RpcResult<RemoteMethodResultMap["workflow.list"]>>;
  getWorkflow(workflowId: RemoteId): Promise<RpcResult<RemoteMethodResultMap["workflow.get"]>>;
  listDelegations(page?: RemotePageParams): Promise<RpcResult<RemoteMethodResultMap["delegation.list"]>>;
  getDelegation(
    delegationId: RemoteId
  ): Promise<RpcResult<RemoteMethodResultMap["delegation.get"]>>;
}

const NO_HOST_FAILURE = {
  ok: false as const,
  error: {
    code: "invalid_request" as const,
    message: "尚未显式配置 hostId：服务端没有主机发现接口",
    retryable: false
  }
};

export function createReadRpcApi(client: RpcClient, getHostId: () => string | null): ReadRpcApi {
  return {
    async hostStatus() {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("host.status", hostId, {});
    },

    async syncSnapshot(conversationLimit) {
      const hostId = getHostId();
      return hostId === null
        ? NO_HOST_FAILURE
        : client.request("sync.snapshot", hostId, conversationLimit === undefined ? {} : { conversationLimit });
    },

    async listProjects(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("project.list", hostId, page);
    },

    async listAgents(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("agent.list", hostId, page);
    },

    async listConversations(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("conversation.list", hostId, page);
    },

    async getConversation(conversationId) {
      const hostId = getHostId();
      return hostId === null
        ? NO_HOST_FAILURE
        : client.request("conversation.get", hostId, { conversationId });
    },

    async listMessages(conversationId, page = {}) {
      const hostId = getHostId();
      return hostId === null
        ? NO_HOST_FAILURE
        : client.request("message.list", hostId, { conversationId, ...page });
    },

    async listTasks(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("task.list", hostId, page);
    },

    async readTaskLog(taskId, page = {}) {
      const hostId = getHostId();
      return hostId === null
        ? NO_HOST_FAILURE
        : client.request("task.readLog", hostId, { taskId, ...page });
    },

    async listWorkflows(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("workflow.list", hostId, page);
    },

    async getWorkflow(workflowId) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("workflow.get", hostId, { workflowId });
    },

    async listDelegations(page = {}) {
      const hostId = getHostId();
      return hostId === null ? NO_HOST_FAILURE : client.request("delegation.list", hostId, page);
    },

    async getDelegation(delegationId) {
      const hostId = getHostId();
      return hostId === null
        ? NO_HOST_FAILURE
        : client.request("delegation.get", hostId, { delegationId });
    }
  };
}
