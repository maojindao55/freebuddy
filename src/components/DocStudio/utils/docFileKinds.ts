const DOC_EXTS = new Set([".csv", ".tsv", ".md", ".txt", ".json"]);
const ENGINE_EXTS = new Set([
  ".doc", ".docx", ".dot", ".dotx", ".wps", ".wpt", ".docm", ".dotm",
  ".xls", ".xlsx", ".xlt", ".xltx", ".xlsm", ".xltm",
  ".pptx", ".ppt", ".pps", ".pot", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm",
  ".pdf"
]);

export function isOfficeOrDocFile(filePath?: string): boolean {
  if (!filePath) return false;
  const match = filePath.match(/\.([a-zA-Z0-9]+)$/);
  if (!match) return false;
  const ext = `.${match[1].toLowerCase()}`;
  return DOC_EXTS.has(ext) || ENGINE_EXTS.has(ext);
}
