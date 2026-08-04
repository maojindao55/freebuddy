/**
 * Access policy for IPC channels reached over the remote WebUI bridge.
 *
 * This is an allow-list: a channel that is not named here is refused. The
 * previous deny-list let newly added channels become remotely callable by
 * default, which is how `cli:check` (spawns a caller-supplied binary) and
 * `settings:set` (writes any global key) ended up exposed.
 *
 * - `allow`     any authenticated remote user may call it. Several of these
 *               still have their arguments rewritten, see remoteInvokeGuard.
 * - `adminOnly` host-level configuration. Remote sessions never carry the
 *               admin flag today, so in practice this behaves like `deny`
 *               while documenting that a desktop caller is legitimate.
 * - `deny`      never reachable from the network (native dialogs, installers,
 *               updater, remote account administration).
 */
export type RemoteChannelAccess = "allow" | "adminOnly" | "deny";

const ALLOW = [
  "app:getVersion",

  // Conversations and messages. Ownership is enforced inside the handlers
  // through requireOwnedConversation / callerCanAccessMessage.
  "cli:appendMessage",
  "cli:archiveConversation",
  "cli:attachConversationShares",
  "cli:createConversation",
  "cli:createConversationShare",
  "cli:deleteConversation",
  "cli:getConversation",
  "cli:listConversationContextReferences",
  "cli:listConversations",
  "cli:listMessage",
  "cli:listMessages",
  "cli:removeConversationContextReference",
  "cli:renameConversation",
  "cli:setConversationApprovalMode",
  "cli:setConversationConfigOptionOverrides",
  "cli:setConversationSkills",
  "cli:transferConversation",
  "cli:updateConversationAgentName",
  "cli:updateMessage",

  // Agent execution. Executable, argv, environment and cwd are all replaced or
  // validated by the guard before these run.
  "cli:check",
  "cli:getCachedSessionConfigOptions",
  "cli:inspectSessionConfigOptions",
  "cli:kill",
  "cli:run",

  // Interactive prompts belonging to an in-flight session.
  "cli:authenticationDecision",
  "cli:authenticationTerminalCancel",
  "cli:authenticationTerminalInput",
  "cli:permissionDecision",

  // Read-only catalogues.
  "cli:listAdapters",
  "cli:listOverrides",
  "cli:listProjects",
  "cli:getProject",
  "cli:listRuntimes",

  // Attachments and drafts.
  "cli:discardManagedAttachment",
  "cli:discardManagedAttachmentIfUnreferenced",
  "cli:ensureAgentGuides",
  "cli:readDraftMarkdown",
  "cli:resolveDraftEntry",
  "cli:searchWorkspaceFiles",
  "draft-tool:resolve",

  // Usage reporting.
  "cli:codexUsage",
  "cli:cursorUsageStatus",
  "cli:refreshUsage",
  "cli:usageSummary",

  // Tool sessions and handoffs.
  "cli:getTask",
  "cli:getToolSession",
  "cli:listTasks",
  "cli:previewHandoffBrief",
  "cli:readTaskLog",
  "cli:saveToolSession",

  // Feeds and info cards (shared host resources, no per-user scoping yet).
  "feed:addSource",
  "feed:deleteSource",
  "feed:listItems",
  "feed:listSources",
  "feed:markInterpreted",
  "feed:refreshAll",
  "feed:refreshSource",
  "feed:updateSource",
  "infoCards:create",
  "infoCards:delete",
  "infoCards:list",
  "infoCards:marketProvider",
  "infoCards:refresh",
  "infoCards:reorder",
  "infoCards:searchMarketSymbols",
  "infoCards:snapshot",
  "infoCards:update",

  "plugins:list",

  // Own identity plus the banner data the web shell renders.
  "remote:getStatus",
  "remote:whoami",

  // Scheduled tasks are scoped by owner_id inside the handlers.
  "scheduledTasks:create",
  "scheduledTasks:delete",
  "scheduledTasks:list",
  "scheduledTasks:listAgents",
  "scheduledTasks:listRuns",
  "scheduledTasks:run",
  "scheduledTasks:update",

  // Key-restricted, see REMOTE_READABLE_SETTING_KEYS below.
  "settings:get",
  "settings:set",

  // Read-only skill browsing.
  "skills:getMarketProvider",
  "skills:list",
  "skills:marketProviders",
  "skills:read",
  "skills:resolveMarketHomepage",
  "skills:searchMarket",

  // Workflows are scoped to the owning conversation inside the handlers.
  "workflow:approveGate",
  "workflow:continueImplementReview",
  "workflow:coordinatorPrompt",
  "workflow:createRun",
  "workflow:createTeamRun",
  "workflow:getRun",
  "workflow:getSteps",
  "workflow:listActiveRuns",
  "workflow:listRuns",
  "workflow:pause",
  "workflow:previewReviewLoop",
  "workflow:previewTeamRun",
  "workflow:requestGateChanges",
  "workflow:resume",
  "workflow:retryStep",
  "workflow:start",
  "workflow:stop",
  "workflow:validate",
  "workflowTeams:create",
  "workflowTeams:delete",
  "workflowTeams:get",
  "workflowTeams:list",
  "workflowTeams:seedBuiltins",
  "workflowTeams:update"
] as const;

const ADMIN_ONLY = [
  // Editing an override rewrites the executable and environment used by every
  // later run, so it must not be reachable from a member's browser.
  "cli:upsertOverride",
  "cli:resetOverride",

  // Host workspace project mounts affect agent cwd/roots; no remote path guard yet.
  "cli:createProject",
  "cli:updateProject",
  "cli:deleteProject",

  // Host-level credentials for the coding CLIs.
  "cli:logout",
  "cli:probeAuthentication",
  "cli:connectCursorUsage",
  "cli:disconnectCursorUsage",

  // Skills are a shared host resource; mutating them affects every user.
  "skills:delete",
  "skills:setEnabled",
  "skills:setMarketProvider",
  "skills:setTrusted"
] as const;

const DENY = [
  // Debug log export is desktop-only (privacy).
  "debugLog:write",
  "debugLogs:preview",
  "debugLogs:export",

  // Native dialogs and shell integration have no meaning off-device.
  "cli:selectAttachments",
  "cli:selectDirectory",
  "cli:openDraftExternal",
  "cli:openCursorUsageSettings",
  "cli:prepareAttachmentFiles",
  // Importing a Codex rollout reads the host's ~/.codex filesystem.
  "cli:importCodexSession",
  "shell:showItemInFolder",
  "skills:selectArchive",
  "skills:selectDirectory",
  "skills:reveal",
  "skills:openMarketUrl",

  // Anything that installs or updates code on the host.
  "cli:install",
  "cli:installStream",
  "skills:import",
  "skills:installFromMarket",
  "plugins:install",
  "plugins:uninstall",
  "plugins:update",
  "plugins:addMarketplace",
  "plugins:updateMarketplace",
  "plugins:removeMarketplace",
  "updater:check",
  "updater:download",
  "updater:quitAndInstall",

  // Remote account administration stays on the desktop.
  "remote:setEnabled",
  "remote:createUser",
  "remote:deleteUser",
  "remote:renameUser",
  "remote:setUserDisabled",
  "remote:setUserStrictIsolation",
  "remote:listUsers",
  "remote:listUserRoots",
  "remote:setUserRoots",
  "remote:checkRootsExist",
  "remote:resetUserPassword",
  "remote:setUserPassword",
  "remote:getUserDataFootprint",
  "remote:listSessions",
  "remote:revokeSession",
  "remote:revokeUserSessions",
  "remote:revokeAllSessions",
  "remote:listAuditLog",
  "remote:getServerConfig",
  "remote:setServerConfig",
  "remote:deleteUserData"
] as const;

const POLICY = new Map<string, RemoteChannelAccess>([
  ...ALLOW.map((channel) => [channel, "allow"] as const),
  ...ADMIN_ONLY.map((channel) => [channel, "adminOnly"] as const),
  ...DENY.map((channel) => [channel, "deny"] as const)
]);

export function classifyRemoteChannel(channel: string): RemoteChannelAccess {
  return POLICY.get(channel) ?? "deny";
}

/**
 * Whether the channel appears in the policy at all. The contract test uses
 * this to fail when a newly registered handler has not been classified, so
 * new channels cannot silently inherit a default.
 */
export function isRemoteChannelClassified(channel: string): boolean {
  return POLICY.has(channel);
}

export function isRemoteChannelCallable(channel: string, isAdmin: boolean): boolean {
  const access = classifyRemoteChannel(channel);
  return access === "allow" || (access === "adminOnly" && isAdmin);
}

export function listRemoteChannels(access: RemoteChannelAccess): string[] {
  return [...POLICY.entries()]
    .filter(([, value]) => value === access)
    .map(([channel]) => channel)
    .sort();
}

/**
 * `settings:get` would otherwise hand out the scrypt hash stored under
 * `remote.password`, which is enough to attack offline.
 */
export const REMOTE_READABLE_SETTING_KEYS: readonly string[] = [
  "language",
  "theme",
  "telemetry.enabled"
];

/** Telemetry is a host-level privacy decision, so it is read-only remotely. */
export const REMOTE_WRITABLE_SETTING_KEYS: readonly string[] = ["language", "theme"];
