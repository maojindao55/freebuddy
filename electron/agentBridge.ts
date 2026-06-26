export interface BridgeActionParam {
  name: string;
  description: string;
  required?: boolean;
}

export interface BridgeAction {
  name: string;
  summary: string;
  description: string;
  params?: BridgeActionParam[];
}

/**
 * The catalog of actions FreeBuddy exposes to agents over the local HTTP
 * bridge. This single source of truth drives:
 *  - HTTP routing (previewServer.ts -> parseBridgeRequest)
 *  - the capability list injected into workspace guide files (agentGuides.ts)
 */
export const BRIDGE_PORT = 17878;

export const BRIDGE_ACTIONS: BridgeAction[] = [
  {
    name: "preview",
    summary: "Open the web preview panel.",
    description:
      "Switch the side panel to the Draft web preview for this workspace."
  },
  {
    name: "navigate",
    summary: "Point the preview at a workspace-relative path.",
    description:
      "Re-target the preview iframe to a different entry file (e.g. another page).",
    params: [
      {
        name: "to",
        description: "Workspace-relative path, e.g. about.html",
        required: true
      }
    ]
  },
  {
    name: "notify",
    summary: "Show a short toast message to the user.",
    description: "Surface a brief, non-blocking message in the FreeBuddy UI.",
    params: [
      { name: "text", description: "The message to display", required: true }
    ]
  }
];

export interface ParsedBridgeRequest {
  action: string;
  params: Record<string, string>;
}

export function parseBridgeRequest(
  requestUrl: string
): ParsedBridgeRequest | null {
  let url: URL;
  try {
    url = new URL(requestUrl, "http://localhost");
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);

  // Canonical: /freebuddy/<action>?<params>
  if (parts.length >= 2 && parts[0] === "freebuddy") {
    const action = parts[1];
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return { action, params };
  }

  // Legacy: /preview
  if (parts.length === 1 && parts[0] === "preview") {
    return { action: "preview", params: {} };
  }

  return null;
}

export function isKnownBridgeAction(action: string): boolean {
  return BRIDGE_ACTIONS.some((a) => a.name === action);
}

export function buildBridgeSection(port: number): string {
  const lines: string[] = [
    "## FreeBuddy bridge",
    "",
    "You can talk back to FreeBuddy over a local HTTP bridge while it is running.",
    "Run any of these from the project root:",
    ""
  ];
  for (const action of BRIDGE_ACTIONS) {
    const params = action.params ?? [];
    const query = params.length
      ? "?" + params.map((p) => `${p.name}=<value>`).join("&")
      : "";
    lines.push(`### ${action.name}`);
    lines.push(`${action.summary} ${action.description}`);
    lines.push("```sh");
    lines.push(
      `curl -s "http://127.0.0.1:${port}/freebuddy/${action.name}${query}"`
    );
    lines.push("```");
    if (params.length) {
      lines.push("Parameters:");
      for (const p of params) {
        lines.push(
          `- \`${p.name}\`${p.required ? " (required)" : ""}: ${p.description}`
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
