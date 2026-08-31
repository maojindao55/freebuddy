import type { ParseContext } from "@freebuddy/protocol/cli";

export interface PromptAttachment {
  path: string;
  kind?: string;
  mimeType?: string;
  name?: string;
}

export interface AgentRunRequest {
  sessionId: string;
  conversationId?: string;
  agentId: string;
  agentName: string;
  adapter: string;
  binary?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  configOptionOverrides?: Record<string, string>;
  skillIds?: string[];
  prompt: string;
  promptAttachments?: PromptAttachment[];
  toolSessionScope?: string;
  toolSessionId?: string;
  resumeToolSession?: boolean;
  cwd?: string;
  workspaceRoots?: string[];
  workspaceAccess?: "read-only" | "read-write";
  signal?: AbortSignal;
}

export type AgentStreamEvent =
  | { type: "started"; pid?: number }
  | { type: "stdout"; content: string }
  | { type: "stderr"; content: string }
  | { type: "items"; items: unknown[] }
  | { type: "done"; exitCode?: number }
  | { type: "error"; message: string }
  | { type: "yielded" };

export interface AgentCapabilities {
  toolSession: boolean;
  skills?: boolean;
}

export interface AgentExecutor {
  run(
    request: AgentRunRequest,
    onEvent: (event: AgentStreamEvent) => void
  ): Promise<void>;
  resume?(
    request: AgentRunRequest,
    onEvent: (event: AgentStreamEvent) => void
  ): Promise<void>;
  yield?(sessionId: string): Promise<void> | void;
  kill(sessionId: string): Promise<void> | void;
  capabilities?(agentId: string): AgentCapabilities | undefined;
}

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export interface IdGenerator {
  id(): string;
}

export interface EventPublisher {
  publish(channel: string, payload?: unknown): void;
}

export interface TelemetryPort {
  track(event: string, properties?: Record<string, unknown>): void;
}

export interface SkillSnapshot {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface SkillResolver {
  resolve(skillIds: string[] | undefined): SkillSnapshot[];
}

export type { ParseContext };
