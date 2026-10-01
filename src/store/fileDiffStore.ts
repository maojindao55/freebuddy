import { create } from "zustand";
import { getFileDiff, type FileEdit } from "@/utils/fileDiff";
import { useDetailLayoutStore } from "./detailLayoutStore";
import { cliClient } from "@/services/cli/client";
import { createFileEditContentLoader } from "@/services/cli/fileEditContent";

const loadContent = createFileEditContentLoader((conversationId, blobKey, offset) => cliClient.readFileEditBlob(conversationId, blobKey, offset));
let loadRevision = 0;

interface DiffSelection { conversationId: string; messageId?: string; edits: FileEdit[]; index: number }
interface FileDiffState {
  selection?: DiffSelection;
  counts: Record<string, { added: number; removed: number }>;
  content?: { key: string; status: "loading" | "ready" | "missing" | "large" | "error"; edit?: FileEdit };
  loadSelected(retry?: boolean): Promise<void>;
  open(selection: DiffSelection): void;
  select(index: number): void;
  refresh(conversationId: string, messageId: string, edits: FileEdit[]): void;
}

export const useFileDiffStore = create<FileDiffState>((set, get) => ({
  counts: {},
  open(selection) {
    set({ selection });
    const layout = useDetailLayoutStore.getState();
    layout.setActiveTab("diff");
    layout.setDetailCollapsed(false);
    void get().loadSelected();
  },
  select(index) {
    const selection = get().selection;
    if (selection && index >= 0 && index < selection.edits.length) {
      set({ selection: { ...selection, index } });
      void get().loadSelected();
    }
  },
  refresh(conversationId, messageId, edits) {
    const selection = get().selection;
    if (selection?.conversationId === conversationId && selection.messageId === messageId) {
      if (selection.edits.length === edits.length && edits.every((edit, index) => edit === selection.edits[index])) return;
      const selected = selection.edits[selection.index];
      const matchingIndex = edits.findIndex(edit => selected?.blobKey ? edit.blobKey === selected.blobKey : edit === selected);
      set({ selection: { ...selection, edits, index: matchingIndex >= 0 ? matchingIndex : Math.min(selection.index, Math.max(0, edits.length - 1)) } });
      void get().loadSelected();
    }
  },
  async loadSelected(retry = false) {
    const selection = get().selection;
    const edit = selection?.edits[selection.index];
    if (!selection || !edit?.blobKey) {
      loadRevision++;
      if (get().content) set({ content: undefined });
      return;
    }
    const key = JSON.stringify([selection.conversationId, edit.blobKey]);
    if (!retry && get().content?.key === key) return;
    const revision = ++loadRevision;
    set({ content: { key, status: "loading" } });
    try {
      const result = await loadContent(selection.conversationId, edit.blobKey);
      if (revision !== loadRevision) return;
      if (result.status === "ready") {
        const hydrated: FileEdit = { ...edit, ...result.content, truncated: false };
        const diff = getFileDiff(hydrated);
        const counts = diff.notice ? get().counts : Object.fromEntries(Object.entries({
          ...get().counts, [edit.blobKey]: { added: diff.added, removed: diff.removed }
        }).slice(-256));
        set({ content: { key, status: "ready", edit: hydrated }, counts });
      } else {
        set({ content: { key, status: result.status } });
      }
    } catch {
      if (revision === loadRevision) set({ content: { key, status: "error" } });
    }
  }
}));
