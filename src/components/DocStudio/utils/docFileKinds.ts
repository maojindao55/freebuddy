const DOC_EXTS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".md", ".txt", ".json"]);

export function isOfficeOrDocFile(filePath?: string): boolean {
  if (!filePath) return false;
  const match = filePath.match(/\.([a-zA-Z0-9]+)$/);
  if (!match) return false;
  return DOC_EXTS.has(`.${match[1].toLowerCase()}`);
}
