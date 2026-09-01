import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ButlerToolResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

function bridgeEnvironment(): { endpoint: string; token: string } {
  const endpoint = process.env.FREEBUDDY_BUTLER_ENDPOINT?.trim();
  const token = process.env.FREEBUDDY_BUTLER_TOKEN?.trim();
  if (!endpoint || !token) {
    throw new Error("FreeBuddy Butler tool environment is incomplete.");
  }
  return { endpoint, token };
}

async function invokeButlerBridge(
  action: string,
  params: Record<string, unknown> = {}
): Promise<ButlerToolResponse> {
  const { endpoint, token } = bridgeEnvironment();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(20_000)
  });
  const result = (await response.json().catch(() => ({
    ok: false,
    error: `Butler bridge returned HTTP ${response.status}`
  }))) as ButlerToolResponse;
  if (!response.ok) {
    throw new Error(result.error || `Butler bridge returned HTTP ${response.status}`);
  }
  return result;
}

function toolResult(result: ButlerToolResponse) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ],
    ...(result.ok === false ? { isError: true } : {})
  };
}

function toolError(error: unknown) {
  return toolResult({
    ok: false,
    error: (error as Error)?.message || String(error)
  });
}

const scheduleTypeSchema = z
  .enum(["once", "manual", "hourly", "daily", "weekdays", "weekly", "monthly"])
  .describe(
    "once = run a single time; manual = no schedule (run only via Run now); hourly/daily/weekdays/weekly/monthly recur."
  );

const executionModeSchema = z
  .enum(["new_conversation", "continuous"])
  .describe(
    "new_conversation = each run starts a fresh task; continuous = resume the previous run's context."
  );

const delegationRoleSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Stable role id, unique within this team."),
  label: z.string().trim().min(1).max(80).describe("User-facing role name."),
  agentId: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Enabled Agent id from freebuddy_status_get. Use cli-butlerbuddy when ButlerBuddy should execute this role."
    ),
  model: z.string().trim().optional().describe("Optional model override."),
  modelOptionId: z
    .string()
    .trim()
    .optional()
    .describe("Optional configured model-option id."),
  capability: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Routing description: what work should be delegated to this role. This is not an execution instruction."
    ),
  instructions: z
    .string()
    .trim()
    .optional()
    .describe(
      "Role execution instructions: rules this role must follow on every turn."
    ),
  canWrite: z
    .boolean()
    .describe("Whether this role may perform write operations when team policy permits."),
  skillIds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Optional installed skill ids assigned to this role.")
});

const delegationPolicySchema = z.object({
  allowWrites: z.boolean().optional(),
  requireApprovalBeforeDelegateWrite: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(6).optional(),
  delegateTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
  maxConcurrentDelegates: z.number().int().min(1).max(8).optional(),
  stopOnDelegateFailure: z.boolean().optional()
});

const completeDelegationPolicySchema = z.object({
  allowWrites: z.boolean(),
  requireApprovalBeforeDelegateWrite: z.boolean(),
  maxDepth: z.number().int().min(1).max(6),
  delegateTimeoutMinutes: z.number().int().min(1).max(1440),
  maxConcurrentDelegates: z.number().int().min(1).max(8),
  stopOnDelegateFailure: z.boolean()
});

export function createButlerMcpServer(): McpServer {
  const server = new McpServer({
    name: "freebuddy-butler",
    version: process.env.FB_APP_VERSION || "0.1.0"
  });

  server.registerTool(
    "freebuddy_status_get",
    {
      title: "Get FreeBuddy Status",
      description:
        "List installed agents (id/name/adapter/enabled), skills (id/name/source/enabled/trusted), adapter runtimes, scheduled-task/team counts, and mainWindow (current FreeBuddy UI presence: workspace view, settings tab, active conversation metadata, streaming). Read-only. Use to understand the current setup and what the user is looking at before recommending changes.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult(await invokeButlerBridge("status_get"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_list",
    {
      title: "List Scheduled Tasks",
      description:
        "List scheduled tasks in this FreeBuddy app with their schedule, agent, enabled state, and last run status. Read-only.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_list"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_create",
    {
      title: "Create Scheduled Task",
      description:
        "Create a scheduled task that runs an agent prompt on a schedule. Confirm the exact task with the user before creating. Restate title, prompt, agent, and schedule before calling.",
      inputSchema: {
        input: z
          .object({
            title: z.string().trim().min(1).max(120),
            prompt: z.string().trim().min(1),
            agentId: z
              .string()
              .trim()
              .min(1)
              .describe("Agent id, e.g. cli-codex-acp. Use freebuddy_status_get to list agents."),
            scheduleType: scheduleTypeSchema,
            timeLocal: z
              .string()
              .describe("Local time in HH:MM (24h), e.g. 09:30. Required even for once/monthly."),
            scheduleDate: z
              .string()
              .optional()
              .describe("YYYY-MM-DD, used by once and monthly."),
            weekdays: z
              .array(z.number().int().min(0).max(6))
              .optional()
              .describe("Days of week (0=Sun..6=Sat), used by weekly."),
            monthDay: z
              .number()
              .int()
              .min(1)
              .max(31)
              .optional()
              .describe("Day of month, used by monthly."),
            cwd: z
              .string()
              .optional()
              .describe("Absolute working directory for the task."),
            executionMode: executionModeSchema,
            enabled: z.boolean().default(true)
          })
          .describe("The scheduled task definition.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_create", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_delete",
    {
      title: "Delete Scheduled Task",
      description:
        "Delete a scheduled task by id. Destructive. Confirm with the user and restate the task title before deleting.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Scheduled task id.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_update",
    {
      title: "Update Scheduled Task",
      description:
        "Update an existing scheduled task by id. Confirm the changes with the user before calling. Provide the full task input (same shape as create).",
      inputSchema: {
        id: z.string().trim().min(1).describe("Scheduled task id."),
        input: z
          .object({
            title: z.string().trim().min(1).max(120),
            prompt: z.string().trim().min(1),
            agentId: z.string().trim().min(1),
            scheduleType: scheduleTypeSchema,
            timeLocal: z.string(),
            scheduleDate: z.string().optional(),
            weekdays: z.array(z.number().int().min(0).max(6)).optional(),
            monthDay: z.number().int().min(1).max(31).optional(),
            cwd: z.string().optional(),
            executionMode: executionModeSchema,
            enabled: z.boolean().default(true)
          })
          .describe("The updated scheduled task definition.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_update", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_run",
    {
      title: "Run Scheduled Task Now",
      description:
        "Manually trigger a scheduled task to run immediately, regardless of its schedule. Confirm with the user before triggering.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Scheduled task id.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_run", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_scheduled_task_list_runs",
    {
      title: "List Scheduled Task Runs",
      description:
        "List recent run history (up to 50) for a scheduled task: status, started/ended times, conversation and workflow run ids, errors. Read-only. Use to diagnose why a task did or did not run.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Scheduled task id.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("scheduled_task_list_runs", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_skill_set_enabled",
    {
      title: "Enable or Disable a Skill",
      description:
        "Enable or disable an installed skill by id. Use freebuddy_status_get to list skill ids. Confirm the change with the user before calling. The butlerbuddy skill cannot be disabled.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Skill id."),
        enabled: z.boolean().describe("true to enable, false to disable.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("skill_set_enabled", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_skill_trust",
    {
      title: "Trust or Untrust a Skill",
      description:
        "Mark an imported skill as trusted (or untrusted). Imported skills must be trusted before they take effect. Confirm with the user before calling.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Skill id."),
        trusted: z.boolean().describe("true to trust, false to untrust.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("skill_trust", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_skill_import",
    {
      title: "Import a Skill",
      description:
        "Import a skill from a local directory or archive path. Confirm the path with the user before calling.",
      inputSchema: {
        sourcePath: z
          .string()
          .trim()
          .min(1)
          .describe("Absolute path to a skill directory or archive.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("skill_import", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_list",
    {
      title: "List Conversations",
      description:
        "List conversations with their last message status (running/done/failed/killed/sent). Pass archived=true for archived, archived=false for active, or omit for active. Read-only. Use lastMessageStatus='failed' to find failed conversations to diagnose with conversation_self_check.",
      inputSchema: {
        archived: z
          .boolean()
          .optional()
          .describe("Filter: true=archived, false=active, omit=active.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_list", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_messages",
    {
      title: "Read Conversation Messages",
      description:
        "Read a page of plain-text messages from a conversation the user owns. Defaults to the latest messages (tail). Use for summarizing or inspecting the main-window / listed conversation content. Does not include raw stream JSON or binary attachments.",
      inputSchema: {
        conversationId: z
          .string()
          .trim()
          .min(1)
          .describe("Conversation id to read."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .default(20)
          .describe("Max messages to return (1-40)."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Start index from the beginning. When set, disables default tail mode."),
        tail: z
          .boolean()
          .optional()
          .describe("If true (default when offset omitted), return the latest messages."),
        role: z
          .enum(["user", "assistant", "system"])
          .optional()
          .describe("Optional role filter.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_messages", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_archive",
    {
      title: "Archive or Unarchive a Conversation",
      description:
        "Archive or unarchive a conversation by id. Confirm with the user before calling.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Conversation id."),
        archived: z.boolean().describe("true to archive, false to unarchive.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_archive", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_delete",
    {
      title: "Delete a Conversation",
      description:
        "Permanently delete a conversation by id. Destructive. Confirm with the user and restate the title before deleting.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Conversation id.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_self_check",
    {
      title: "Prepare Conversation Logs for Self-Check",
      description:
        "Collect a failed conversation's full diagnostic logs (app logs + session transcripts + environment) into a temporary directory and return its path. Then use your file-reading tools to read README.txt, environment.json, dsh-acp-runtime.json, logs/, and sessions/ under that directory and produce a structured self-check report (problem summary, evidence with timestamps, confirmed facts vs possible causes, remediation steps). Do not modify files in that directory.",
      inputSchema: {
        conversationId: z.string().trim().min(1).describe("Conversation id to diagnose.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_self_check", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_agent_check",
    {
      title: "Check Agent Runtime",
      description:
        "Probe whether a CLI adapter runtime is installed (e.g. codex-acp, claude-agent-acp). Returns installed status. Read-only probe.",
      inputSchema: {
        adapter: z
          .string()
          .trim()
          .min(1)
          .describe("Adapter id, e.g. codex-acp.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("agent_check", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_settings_open",
    {
      title: "Open a Settings Page",
      description:
        "Open a FreeBuddy settings tab for the user. Use when a change must be done manually in Settings (e.g. remote access, authentication). Tab is one of: general, cli, skills, plugins, feed, remote, about.",
      inputSchema: {
        tab: z
          .enum(["general", "cli", "skills", "plugins", "feed", "remote", "about"])
          .optional()
          .default("cli")
          .describe("Settings tab to open.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("settings_open", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_conversation_open",
    {
      title: "Open a Conversation in Main Window",
      description:
        "Focus the main FreeBuddy window and open a conversation in the chat view. Pass id for an exact open, or titleQuery / lastMessageStatus to find one (e.g. lastMessageStatus=failed). If multiple match, returns matches for disambiguation instead of opening.",
      inputSchema: {
        id: z.string().optional().describe("Exact conversation id to open."),
        titleQuery: z
          .string()
          .optional()
          .describe("Case-insensitive substring match against conversation title."),
        lastMessageStatus: z
          .string()
          .optional()
          .describe("Match latest message status, e.g. failed, done, running."),
        archived: z
          .boolean()
          .optional()
          .describe("Search archived conversations when using titleQuery/status filters.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("conversation_open", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_view_open",
    {
      title: "Open a Main Workspace View",
      description:
        "Focus the main FreeBuddy window and switch to a workspace page. Views: chat, scheduledTasks, workflowTeams, usage. For workflowTeams, optional teamId selects a team and create=true opens the create flow.",
      inputSchema: {
        view: z
          .enum(["chat", "scheduledTasks", "workflowTeams", "usage"])
          .describe("Main workspace view to open."),
        teamId: z
          .string()
          .optional()
          .describe("Optional workflow team id when view=workflowTeams."),
        create: z
          .boolean()
          .optional()
          .describe("When view=workflowTeams, open the create-team flow.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("view_open", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_set_appearance",
    {
      title: "Set Theme Appearance",
      description:
        "Switch the FreeBuddy UI theme. Applies immediately (live). Use system to follow the OS, or light/dark to force a mode. Confirm with the user before changing.",
      inputSchema: {
        theme: z
          .enum(["system", "light", "dark"])
          .describe("system = follow OS, light = light mode, dark = dark mode.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("set_appearance", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_list",
    {
      title: "List Self-Organizing Teams",
      description:
        "List self-organizing delegation teams with their entry role, roster, shared instructions, role instructions, and policy. Read-only. These teams dynamically delegate work and are distinct from fixed workflow teams.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult(await invokeButlerBridge("delegation_team_list"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_get",
    {
      title: "Get Self-Organizing Team",
      description:
        "Get one self-organizing delegation team's complete configuration. Read-only. Use this before recommending changes or creating a similar team.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Self-organizing team id.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("delegation_team_get", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_create",
    {
      title: "Create a Self-Organizing Team",
      description:
        "Create a complete self-organizing delegation team. First use freebuddy_status_get for enabled Agent ids, then restate the name, entry role, full roster, shared instructions, per-role execution instructions, write permissions, and policy and get explicit user confirmation. Capability is used for routing only; put mandatory behavior in instructions.",
      inputSchema: {
        name: z.string().trim().min(1).max(80).describe("Team name."),
        description: z.string().trim().optional().describe("Optional summary."),
        sharedInstructions: z
          .string()
          .trim()
          .optional()
          .describe("Instructions applied to every role on every turn."),
        enabled: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether the team is enabled immediately."),
        entryRoleId: z
          .string()
          .trim()
          .min(1)
          .describe("Role id that receives the user's initial task."),
        roster: z
          .array(delegationRoleSchema)
          .min(1)
          .max(16)
          .describe("Complete team roster."),
        policy: delegationPolicySchema
          .optional()
          .describe("Optional overrides for the default delegation policy.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("delegation_team_create", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_update",
    {
      title: "Update a Self-Organizing Team",
      description:
        "Replace a user-created self-organizing team's complete configuration. First call freebuddy_delegation_team_get, preserve its updatedAt value, show the user the complete proposed configuration and changes, and get explicit confirmation. Then send the entire roster and policy; omitted description or sharedInstructions are cleared. Built-in teams cannot be fully updated by this tool.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Self-organizing team id."),
        expectedUpdatedAt: z
          .string()
          .trim()
          .min(1)
          .describe("Exact updatedAt value returned by the preceding get call."),
        name: z.string().trim().min(1).max(80).describe("Complete team name."),
        description: z
          .string()
          .trim()
          .optional()
          .describe("Complete description. Omit to clear it."),
        sharedInstructions: z
          .string()
          .trim()
          .optional()
          .describe("Complete shared instructions. Omit to clear them."),
        enabled: z.boolean().describe("Whether the team is enabled."),
        entryRoleId: z
          .string()
          .trim()
          .min(1)
          .describe("Role id that receives the user's initial task."),
        roster: z
          .array(delegationRoleSchema)
          .min(1)
          .max(16)
          .describe("Complete replacement team roster."),
        policy: completeDelegationPolicySchema.describe(
          "Complete replacement delegation policy."
        )
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("delegation_team_update", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_set_enabled",
    {
      title: "Enable or Disable a Self-Organizing Team",
      description:
        "Enable or disable a self-organizing team by id. This works for built-in and user-created teams. Confirm the change with the user before calling.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Self-organizing team id."),
        enabled: z.boolean().describe("true to enable, false to disable.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(
          await invokeButlerBridge("delegation_team_set_enabled", args)
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_delegation_team_delete",
    {
      title: "Delete a Self-Organizing Team",
      description:
        "Permanently delete a user-created self-organizing team. Destructive. First get the current team, restate its name, obtain explicit user confirmation, and pass that exact name as confirmName. Built-in teams cannot be deleted.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Self-organizing team id."),
        confirmName: z
          .string()
          .trim()
          .min(1)
          .describe("Exact current team name confirmed by the user.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("delegation_team_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_list",
    {
      title: "List Workflow Teams",
      description:
        "List workflow teams (id/name/description/enabled/source/roles). Read-only. Use to inspect the team setup before recommending changes.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult(await invokeButlerBridge("team_list"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_get",
    {
      title: "Get Workflow Team",
      description:
        "Get a single workflow team's full details by id: roles (with skillIds), policy, and the complete node/edge template flow. Read-only. Prefer this over database access.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Team id.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_get", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_create",
    {
      title: "Create a Workflow Team",
      description:
        "Create a new user workflow team with a name and optional description. Starts with an empty structure (no roles/nodes yet) and default policy; the user can add roles and nodes in Settings later, or ask you to describe what the team should do. Confirm the name with the user before creating.",
      inputSchema: {
        name: z.string().trim().min(1).max(80).describe("Team name."),
        description: z
          .string()
          .optional()
          .describe("Optional team description."),
        enabled: z
          .boolean()
          .optional()
          .default(true)
          .describe("Whether the team is enabled immediately.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_create", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_template_list",
    {
      title: "List Team Templates",
      description:
        "List built-in workflow team templates that can be used as a starting point via team_create_from_template. Each template has predefined roles and a node flow. Read-only.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult(await invokeButlerBridge("team_template_list"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_create_from_template",
    {
      title: "Create Team From Template",
      description:
        "Create a new user team by copying a built-in template (keeps the template's roles and node flow). Use team_template_list to see template ids. Confirm the template and team name with the user before creating.",
      inputSchema: {
        templateId: z
          .string()
          .trim()
          .min(1)
          .describe("Template id from team_template_list, e.g. team-delivery-example."),
        name: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .describe("Name for the new team."),
        description: z
          .string()
          .optional()
          .describe("Optional description; defaults to the template's description.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_create_from_template", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_role_set_agent",
    {
      title: "Set a Team Role's Agent",
      description:
        "Change which agent runs a specific role in a workflow team. Use freebuddy_status_get to find valid agent ids, and team_get to find role ids. Confirm the change with the user before calling.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        roleId: z.string().trim().min(1).describe("Role id within the team."),
        agentId: z
          .string()
          .trim()
          .min(1)
          .describe("New agent id, e.g. cli-codex-acp.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_role_set_agent", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_role_set_skills",
    {
      title: "Set a Team Role's Skills",
      description:
        "Set the skill ids for a specific role in a workflow team (replaces the existing list). Use freebuddy_status_get to find skill ids. Confirm the change with the user before calling.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        roleId: z.string().trim().min(1).describe("Role id within the team."),
        skillIds: z
          .array(z.string())
          .describe("Skill ids to assign to this role. Replaces the current list.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_role_set_skills", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_update_policy",
    {
      title: "Update a Team's Policy",
      description:
        "Update workflow policy fields for a team. Only provided fields are changed. maxParallelWriteSteps is fixed at 1 and cannot be changed. Confirm with the user before calling.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        allowWrites: z.boolean().optional().describe("Whether write steps are allowed."),
        requireApprovalBeforeWrite: z.boolean().optional().describe("Require approval before a write step runs."),
        requireApprovalAfterReview: z.boolean().optional().describe("Require approval after a review step."),
        maxParallelReadSteps: z.number().int().min(1).optional().describe("Max parallel read steps."),
        maxLoops: z.number().int().min(0).optional().describe("Max loops on verify failure."),
        stopOnVerifyFailure: z.boolean().optional().describe("Stop the run when verification fails.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_update_policy", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_node_list",
    {
      title: "List Team Nodes",
      description:
        "List the node flow (steps) of a workflow team: nodes, edges, start and final node ids. Read-only. Use to understand the flow before editing.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_node_list", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_node_add",
    {
      title: "Add a Team Node",
      description:
        "Add a new step (node) to a team's flow, connected after the given fromNodeIds (or after the current final nodes by default). The new node becomes the final node. Confirm the step with the user before calling.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        title: z.string().trim().min(1).describe("Node title."),
        mode: z
          .enum(["research", "review", "write", "verify", "summarize", "approval"])
          .describe("Node mode."),
        roleId: z.string().optional().describe("Role id that runs this node."),
        contract: z
          .enum(["plan", "approval", "implement", "review", "verify", "summarize", "research", "report", "custom"])
          .optional()
          .describe("Node contract."),
        promptTemplate: z.string().optional().describe("Prompt template; {{goal}} is replaced at run time."),
        fromNodeIds: z
          .array(z.string())
          .optional()
          .describe("Node ids to connect from. Defaults to current final nodes.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_node_add", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_node_update",
    {
      title: "Update a Team Node",
      description:
        "Update fields of a single node (title/mode/contract/roleId/promptTemplate). Only provided fields change. Confirm with the user before calling.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        nodeId: z.string().trim().min(1).describe("Node id."),
        title: z.string().optional(),
        mode: z
          .enum(["research", "review", "write", "verify", "summarize", "approval"])
          .optional(),
        contract: z
          .enum(["plan", "approval", "implement", "review", "verify", "summarize", "research", "report", "custom"])
          .optional(),
        roleId: z.string().optional(),
        promptTemplate: z.string().optional()
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_node_update", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_node_delete",
    {
      title: "Delete a Team Node",
      description:
        "Delete a node and its connected edges. Start/final node ids are adjusted automatically. Destructive: confirm with the user and restate the node title before deleting.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        nodeId: z.string().trim().min(1).describe("Node id to delete.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_node_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_edge_add",
    {
      title: "Add a Team Edge",
      description: "Add a connection between two nodes in a team's flow.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        from: z.string().trim().min(1).describe("Source node id."),
        to: z.string().trim().min(1).describe("Target node id.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_edge_add", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_edge_delete",
    {
      title: "Delete a Team Edge",
      description: "Delete a connection between two nodes by edge id.",
      inputSchema: {
        teamId: z.string().trim().min(1).describe("Team id."),
        edgeId: z.string().trim().min(1).describe("Edge id to delete.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_edge_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_set_enabled",
    {
      title: "Enable or Disable a Workflow Team",
      description:
        "Enable or disable a workflow team by id. Confirm the change with the user before calling.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Team id."),
        enabled: z.boolean().describe("true to enable, false to disable.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_set_enabled", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_update",
    {
      title: "Rename or Describe a Workflow Team",
      description:
        "Update a workflow team's name, description, and/or icon. Confirm with the user first.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Team id."),
        name: z.string().trim().min(1).max(80).optional().describe("New team name."),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("New description, or null to clear."),
        icon: z
          .string()
          .nullable()
          .optional()
          .describe("New icon id, or null to clear.")
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_update", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "freebuddy_team_delete",
    {
      title: "Delete a Workflow Team",
      description:
        "Delete a workflow team by id. Destructive. Built-in teams cannot be deleted. Confirm with the user and restate the team name before deleting.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Team id.")
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      try {
        return toolResult(await invokeButlerBridge("team_delete", args));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}

export async function runButlerMcpServer(): Promise<void> {
  const server = createButlerMcpServer();
  await server.connect(new StdioServerTransport());
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runButlerMcpServer().catch((error) => {
    console.error("[FreeBuddy Butler MCP]", error);
    process.exitCode = 1;
  });
}
