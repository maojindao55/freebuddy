import type { WebContents } from "electron";
import type { CliPromptAttachment, CliRunArgs } from "../../cli/runtimeShared.js";
import { cliRun } from "../../cli/runtime.js";
import {
  conversationContextPromptPrefix,
  listResolvedConversationContextPayloads
} from "../../cli/conversationContext.js";
import { applyAgentLanguagePreference } from "../../cli/agentLanguage.js";
import { getLanguage } from "../../cli/settings.js";
import { requireOwnedConversation } from "../../cli/conversations.js";
import { resolveWorkspaceRootsForConversation } from "../../cli/projects.js";
import { resolveSkillSnapshots } from "../../cli/skills.js";
import type { StepExecutor } from "@freebuddy/workflow-runtime";

export function createCliStepExecutor(webContents: WebContents | undefined): StepExecutor {
  return {
    async run(args) {
      if (!webContents) {
        throw new Error("workflow step execution requires an active window");
      }
      const runArgs: CliRunArgs = {
        sessionId: args.sessionId,
        conversationId: args.conversationId,
        agentId: args.agentId,
        agentName: args.agentName,
        adapter: args.adapter as never,
        binary: args.binary,
        extraArgs: args.extraArgs,
        env: args.env,
        configOptionOverrides: args.configOptionOverrides,
        prompt: args.prompt,
        promptAttachments: args.promptAttachments as CliPromptAttachment[] | undefined,
        toolSessionScope: args.toolSessionScope,
        toolSessionId: args.toolSessionId,
        cwd: args.cwd,
        workspaceAccess: args.workspaceAccess,
        workspaceRoots: args.conversationId
          ? resolveWorkspaceRootsForConversation(
              requireOwnedConversation(args.conversationId) ?? {
                cwd: args.cwd
              }
            )
          : resolveWorkspaceRootsForConversation({ cwd: args.cwd }),
        approvalMode: "auto",
        resumeToolSession: args.resumeToolSession,
        skills: resolveSkillSnapshots(args.skillIds ?? []),
        announceSkills: !args.resumeToolSession || !args.toolSessionId
      };
      const contextReferences = args.conversationId
        ? listResolvedConversationContextPayloads(args.conversationId)
        : [];
      if (contextReferences.length > 0) {
        runArgs.prompt = applyAgentLanguagePreference(
          `${conversationContextPromptPrefix(contextReferences)}` + runArgs.prompt,
          getLanguage()
        );
        runArgs.contextReferences = contextReferences;
      }
      await cliRun(webContents, runArgs, args.onEvent as never);
    }
  };
}
