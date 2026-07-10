export type DraftToolAction = "show" | "inspect" | "report";

export type DraftLoadState = "idle" | "loading" | "ready" | "error";

export interface DraftCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftScreenshot {
  mimeType: "image/png";
  data: string;
  width: number;
  height: number;
}

export interface DraftConsoleEntry {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface DraftToolEvent {
  requestId: string;
  conversationId: string;
  cwd: string;
  action: DraftToolAction;
  params: Record<string, unknown>;
}

export interface DraftToolResult {
  ok: boolean;
  conversationId: string;
  cwd: string;
  target?: string;
  resolvedUrl?: string;
  loadState?: DraftLoadState;
  visible?: boolean;
  message?: string;
  error?: string;
  updatedAt?: string;
  diagnostics?: { console: DraftConsoleEntry[] };
  screenshot?: DraftScreenshot;
  screenshotError?: string;
  /** Renderer-only capture hint, stripped before the result reaches the agent. */
  captureRect?: DraftCaptureRect;
}

export interface DraftToolResolution {
  requestId: string;
  result: DraftToolResult;
}

export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}
