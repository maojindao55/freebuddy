import crypto from "node:crypto";
import path from "node:path";

/**
 * Experimental personal-learning integration with the Tencent Docs AI engine
 * (`editor_sdk.exe`).
 *
 * FreeBuddy installs the separately downloaded binary in its application data
 * directory. Keep this module Electron-free so plain `node --test` can import it.
 */

export interface OfficeEngineFileType {
  engineType: "doc" | "sheet" | "slide" | "pdf";
  extensions: readonly string[];
}

// DocStudio exposes only the document formats supported by this integration.
// The engine can also handle .csv, but the integration does not expose it.
export const OFFICE_ENGINE_FILE_TYPES: readonly OfficeEngineFileType[] = [
  {
    engineType: "doc",
    extensions: [".doc", ".docx", ".dot", ".dotx", ".wps", ".wpt", ".docm", ".dotm"]
  },
  {
    engineType: "sheet",
    extensions: [".xls", ".xlsx", ".xlt", ".xltx", ".xlsm", ".xltm"]
  },
  {
    engineType: "slide",
    extensions: [".pptx", ".ppt", ".pps", ".pot", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm"]
  },
  {
    engineType: "pdf",
    extensions: [".pdf"]
  }
];

const extensionToType = new Map<string, OfficeEngineFileType>();
for (const fileType of OFFICE_ENGINE_FILE_TYPES) {
  for (const ext of fileType.extensions) {
    extensionToType.set(ext, fileType);
  }
}

export function fileExtensionOf(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return `.${base.slice(dot + 1).toLowerCase()}`;
}

export function getOfficeEngineDocType(filePath: string): "doc" | "sheet" | "slide" | "pdf" | null {
  return extensionToType.get(fileExtensionOf(filePath))?.engineType ?? null;
}

export function isOfficeEngineFile(filePath: string): boolean {
  return getOfficeEngineDocType(filePath) !== null;
}

export function isAbsoluteExistingPath(candidate: string): boolean {
  return path.isAbsolute(candidate);
}

// Per-type preview parameters mirrored from the engine's URL_CONFIG_MAP
// (doc: full chrome; slide: embedded client without title bar; pdf: none).
export const OFFICE_ENGINE_PREVIEW_PARAMS: Record<"doc" | "sheet" | "slide" | "pdf", Record<string, string>> = {
  doc: {
    local_edit: "1",
    client: "sdk_local",
    mode: "edit",
    toolbar: "show",
    outline: "show",
    statusbar: "show"
  },
  sheet: {
    local_edit: "1",
    client: "sdk_local_pure",
    mode: "edit"
  },
  slide: {
    local_edit: "1",
    client: "sdk_local_wb",
    hideTitlebar: "1"
  },
  pdf: {}
};

export function buildOfficeEnginePreviewUrl(port: number, filePath: string): string {
  const engineType = getOfficeEngineDocType(filePath);
  if (!engineType) {
    throw new Error(`Unsupported office engine file: ${fileExtensionOf(filePath)}`);
  }
  // The engine identifies one local document by the md5 of its absolute path.
  const globalPadId = crypto.createHash("md5").update(filePath).digest("hex");
  const params = new URLSearchParams({
    title: path.win32.basename(filePath),
    localFilePath: filePath,
    globalPadId,
    ...OFFICE_ENGINE_PREVIEW_PARAMS[engineType],
    ...(engineType === "doc" ? { editorSdkUrl: `http://127.0.0.1:${port}` } : {})
  });
  return `http://127.0.0.1:${port}/static/${engineType}/pc.html?${params.toString()}`;
}

// The SDK does not decode file_path in this endpoint's query string. Fetch the
// whole pool and match file_path on the host instead (including Unicode paths).
export function buildOfficeEngineEditorStatusUrl(port: number): string {
  return `http://127.0.0.1:${port}/localapi/editor/status`;
}

export interface OfficeEnginePoolEditor {
  file_path: string;
  is_dirty?: boolean;
  last_saved_ms?: number;
}

export function findOfficeEngineEditorStatus(editors: unknown, filePath: string): OfficeEnginePoolEditor | null {
  if (!Array.isArray(editors)) return null;
  const target = path.normalize(filePath);
  for (const candidate of editors) {
    if (!candidate || typeof candidate !== "object") continue;
    const editor = candidate as Record<string, unknown>;
    if (typeof editor.file_path !== "string") continue;
    const current = path.normalize(editor.file_path);
    const matches = process.platform === "win32"
      ? current.toLowerCase() === target.toLowerCase()
      : current === target;
    if (matches) return editor as unknown as OfficeEnginePoolEditor;
  }
  return null;
}
