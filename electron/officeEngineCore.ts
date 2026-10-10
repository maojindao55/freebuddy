import crypto from "node:crypto";
import path from "node:path";

/**
 * Experimental personal-learning integration with the locally installed
 * WorkBuddy "Tencent Docs AI engine" (`editor_sdk.exe`).
 *
 * FreeBuddy ships NOTHING and downloads NOTHING: it only spawns a binary that
 * already exists on this machine (a local WorkBuddy installation). Keep this
 * module Electron-free so plain `node --test` can import it.
 */

export interface OfficeEngineFileType {
  engineType: "doc" | "sheet" | "slide" | "pdf";
  extensions: readonly string[];
}

// The engine also handles .csv, but DocStudio keeps its lightweight built-in
// editor for .csv/.tsv; the binary Excel family goes to the engine instead.
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
    title: path.basename(filePath),
    localFilePath: filePath,
    globalPadId,
    ...OFFICE_ENGINE_PREVIEW_PARAMS[engineType],
    ...(engineType === "doc" ? { editorSdkUrl: `http://127.0.0.1:${port}` } : {})
  });
  return `http://127.0.0.1:${port}/static/${engineType}/pc.html?${params.toString()}`;
}

export interface OfficeEnginePathInputs {
  envOverride?: string | undefined;
  userDataDir: string;
  localProgramsDir: string;
}

/**
 * Candidate engine binary locations, in priority order:
 * 1. `FB_OFFICE_ENGINE` env override;
 * 2. a copy the user dropped into `<userData>/office-engine/`;
 * 3. a locally installed WorkBuddy / WorkBuddyAI (unpacked engine directory).
 */
export function buildOfficeEngineEditorStatusUrl(port: number, filePath: string): string {
  const params = new URLSearchParams({ file_path: filePath });
  return `http://127.0.0.1:${port}/localapi/editor/status?${params.toString()}`;
}

export function buildOfficeEngineCandidatePaths(inputs: OfficeEnginePathInputs): string[] {
  const binaryName = process.platform === "win32" ? "editor_sdk.exe" : "editor_sdk";
  const candidates: string[] = [];
  if (inputs.envOverride) candidates.push(inputs.envOverride);
  candidates.push(path.join(inputs.userDataDir, "office-engine", binaryName));
  const engineSubpath = path.join(
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@tencent",
    "tencent-docs-ai-engine",
    "bin",
    "win32-x64",
    binaryName
  );
  for (const productName of ["WorkBuddy", "WorkBuddyAI"]) {
    candidates.push(path.join(inputs.localProgramsDir, productName, engineSubpath));
  }
  return candidates;
}

export function findOfficeEngineBinary(
  candidates: readonly string[],
  exists: (candidate: string) => boolean
): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
