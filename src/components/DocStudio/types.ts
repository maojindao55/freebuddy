export type DocKind = "office";

export interface DocTab {
  id: string;
  filePath: string;
  fileName: string;
  ext: string;
  kind: DocKind;
  previewUrl: string;
}
