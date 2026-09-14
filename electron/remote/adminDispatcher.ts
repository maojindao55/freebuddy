import { randomBytes } from "node:crypto";
import { getOwnerUser } from "../cli/users.js";
import { runAsCaller } from "../cli/callerContext.js";
import { REMOTE_PROTOCOL_VERSION, READ_REMOTE_METHODS, isRemoteMethod, type RemoteFrame, type RpcRequestFrame, type RpcResponseFrame, type RemoteMethod, type RemoteMethodResultMap } from "@freebuddy/protocol/remote";
import { SnapshotService } from "./snapshotService.js";

type ErrorCode = "invalid_request" | "method_not_allowed" | "not_found" | "internal_error";
const allowed = new Set<string>(READ_REMOTE_METHODS);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const page = (value: unknown) => object(value) && (value.cursor === undefined || typeof value.cursor === "string") && (value.limit === undefined || typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 100);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);

/** D4 has no write descriptors. The protocol's terminal.snapshot is deliberately rejected as write. */
export class AdminDispatcher {
  constructor(private readonly hostId: string, private readonly snapshots: SnapshotService, private readonly now: () => number = Date.now) {}
  async dispatch(frame: RemoteFrame): Promise<RpcResponseFrame | undefined> {
    if (frame.type !== "rpc.request") return undefined;
    const request = frame as RpcRequestFrame;
    if (request.hostId !== this.hostId || !isRemoteMethod(request.payload.method) || !allowed.has(request.payload.method)) return this.fail(request, "method_not_allowed", "This host permits read methods only");
    if (!this.validParams(request.payload.method, request.payload.params)) return this.fail(request, "invalid_request", "Parameters do not match protocol/remote/v1");
    const owner = getOwnerUser();
    if (!owner || owner.disabled || !owner.isOwner) return this.fail(request, "internal_error", "Local owner administrator is unavailable");
    try {
      const result = await runAsCaller(owner.id, () => this.invoke(request.payload.method, request.payload.params as Record<string, unknown>), true);
      return this.ok(request, result);
    } catch (error) { return this.fail(request, error instanceof NotFound ? "not_found" : "internal_error", error instanceof NotFound ? "Resource was not found" : "Read request failed"); }
  }
  private validParams(method: RemoteMethod, params: unknown): boolean {
    if (!object(params)) return false;
    if (["host.status"].includes(method)) return only(params, []);
    if (method === "sync.snapshot") return only(params, ["conversationLimit"]) && (params.conversationLimit === undefined || typeof params.conversationLimit === "number" && Number.isInteger(params.conversationLimit) && params.conversationLimit >= 1 && params.conversationLimit <= 100);
    if (["project.list", "workflow.list", "delegation.list"].includes(method)) return page(params) && only(params, ["cursor", "limit"]);
    if (method === "agent.list" || method === "conversation.list" || method === "task.list") return page(params) && only(params, method === "task.list" ? ["cursor", "limit", "projectId", "conversationId"] : ["cursor", "limit", "projectId"]) && Object.values(params).every(v => v === undefined || typeof v === "string" || Number.isInteger(v));
    if (["conversation.get"].includes(method)) return only(params, ["conversationId"]) && id(params.conversationId);
    if (["message.list"].includes(method)) return page(params) && only(params, ["cursor", "limit", "conversationId"]) && id(params.conversationId);
    if (["task.readLog"].includes(method)) return page(params) && only(params, ["cursor", "limit", "taskId"]) && id(params.taskId);
    if (["workflow.get"].includes(method)) return only(params, ["workflowId"]) && id(params.workflowId);
    if (["delegation.get"].includes(method)) return only(params, ["delegationId"]) && id(params.delegationId);
    return false;
  }
  private async invoke(method: RemoteMethod, params: Record<string, unknown>): Promise<any> {
    switch (method) {
      case "host.status": return this.snapshots.snapshot(1).host;
      case "sync.snapshot": return this.snapshots.snapshot(params.conversationLimit as number | undefined);
      case "project.list": return this.snapshots.paged(this.snapshots.projects(), params.cursor as string | undefined, params.limit as number | undefined);
      case "agent.list":
        if (params.projectId && !this.snapshots.project(params.projectId as string)) throw new NotFound();
        return this.snapshots.paged(this.snapshots.agents(), params.cursor as string | undefined, params.limit as number | undefined);
      case "conversation.list":
        if (params.projectId && !this.snapshots.project(params.projectId as string)) throw new NotFound();
        return this.snapshots.paged(this.snapshots.conversations().filter(c => !params.projectId || c.projectId === params.projectId), params.cursor as string | undefined, params.limit as number | undefined);
      case "conversation.get": { const result = this.snapshots.conversation(params.conversationId as string); if (!result) throw new NotFound(); return result; }
      case "message.list": { if (!this.snapshots.conversation(params.conversationId as string)) throw new NotFound(); return this.snapshots.paged(this.snapshots.messages(params.conversationId as string), params.cursor as string | undefined, params.limit as number | undefined); }
      case "task.list": {
        if (params.projectId && !this.snapshots.project(params.projectId as string)) throw new NotFound();
        if (params.conversationId) {
          const conversation = this.snapshots.conversation(params.conversationId as string);
          if (!conversation || (params.projectId && conversation.projectId !== params.projectId)) throw new NotFound();
        }
        // Existing task rows do not carry a project/conversation foreign key.
        // Do not pretend that an arbitrary task belongs to a requested resource.
        return this.snapshots.paged(params.projectId || params.conversationId ? [] : this.snapshots.tasks(), params.cursor as string | undefined, params.limit as number | undefined);
      }
      case "task.readLog":
        if (!this.snapshots.task(params.taskId as string)) throw new NotFound();
        return this.snapshots.paged(await this.snapshots.taskLog(params.taskId as string), params.cursor as string | undefined, params.limit as number | undefined);
      case "workflow.list": return this.snapshots.paged(this.snapshots.workflows(), params.cursor as string | undefined, params.limit as number | undefined);
      case "workflow.get": { const result = this.snapshots.workflows().find(w => w.workflowId === params.workflowId); if (!result) throw new NotFound(); return result; }
      case "delegation.list": return this.snapshots.paged(this.snapshots.delegations(), params.cursor as string | undefined, params.limit as number | undefined);
      case "delegation.get": { const result = this.snapshots.delegation(params.delegationId as string); if (!result) throw new NotFound(); return result; }
      default: throw new NotFound();
    }
  }
  private ok(request: RpcRequestFrame, result: any): RpcResponseFrame { return { v: REMOTE_PROTOCOL_VERSION, type: "rpc.response", id: `msg_${randomBytes(12).toString("base64url")}`, hostId: this.hostId, sentAt: new Date(this.now()).toISOString(), payload: { requestId: request.id, ok: true, result } }; }
  private fail(request: RpcRequestFrame, code: ErrorCode, message: string): RpcResponseFrame { return { v: REMOTE_PROTOCOL_VERSION, type: "rpc.response", id: `msg_${randomBytes(12).toString("base64url")}`, hostId: this.hostId, sentAt: new Date(this.now()).toISOString(), payload: { requestId: request.id, ok: false, error: { code, message, retryable: false } } }; }
}
class NotFound extends Error {}
