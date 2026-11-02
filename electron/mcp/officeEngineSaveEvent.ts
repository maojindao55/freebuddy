import path from "node:path";

import { isOfficeEngineFile } from "../officeEngineCore.js";

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function sameFile(a: string, b: string): boolean {
  const actual = path.normalize(a);
  const expected = path.normalize(b);
  return process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

/** Only a successful save to a separate, openable path should create a tab. */
export function savedAsOfficeFilePath(
  request: RpcMessage,
  responses: RpcMessage[],
  currentOfficeFile: string
): string | null {
  if (request.method !== "tools/call" || request.id == null) return null;
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const call = params as Record<string, unknown>;
  if (call.name !== "save_file") return null;
  const args = call.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const filePath = (args as Record<string, unknown>).file_path;
  if (typeof filePath !== "string" || filePath.length > 4096 ||
      !path.isAbsolute(filePath) || !isOfficeEngineFile(filePath) ||
      (currentOfficeFile && sameFile(filePath, currentOfficeFile))) return null;

  const reply = responses.find((response) => response.id != null && String(response.id) === String(request.id));
  if (!reply || reply.error != null || !reply.result || typeof reply.result !== "object") return null;
  const result = reply.result as Record<string, unknown>;
  if (result.isError === true || result.success === false) return null;
  return path.normalize(filePath);
}
