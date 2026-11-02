import { create } from "zustand";
import { aggregateFileEdits, fileEditContentKey, getFileDiff, type FileEdit } from "@/utils/fileDiff";
import { useDetailLayoutStore } from "./detailLayoutStore";
import { cliClient } from "@/services/cli/client";
import { createFileEditContentLoader } from "@/services/cli/fileEditContent";

const loadContent = createFileEditContentLoader((conversationId, key, offset, turn) => turn
  ? cliClient.readMessageFileEdit(turn.messageId, turn.path, key, offset)
  : cliClient.readFileEditBlob(conversationId, key, offset));
let loadRevision = 0;

interface DiffSelection { conversationId: string; messageId?: string; edits: FileEdit[]; index: number }
interface FileDiffState {
  selection?: DiffSelection;
  counts: Record<string, { added: number; removed: number; unchanged?: boolean } | null>;
  content?: { key: string; status: "loading" | "ready" | "missing" | "large" | "error"; edit?: FileEdit; sources?: FileEdit[] };
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
      if (!edits.length) {
        set({ selection: undefined });
        void get().loadSelected();
        return;
      }
      if (selection.edits.length === edits.length && edits.every((edit, index) => edit === selection.edits[index])) return;
      const selected = selection.edits[selection.index];
      const matchingIndex = edits.findIndex(edit => edit.path === selected?.path);
      set({ selection: { ...selection, edits, index: matchingIndex >= 0 ? matchingIndex : Math.min(selection.index, Math.max(0, edits.length - 1)) } });
      void get().loadSelected();
    }
  },
  async loadSelected(retry = false) {
    const selection = get().selection;
    const edit = selection?.edits[selection.index];
    if (!selection || !edit || (!edit.blobKey && !edit.turnKey && !edit.sources)) {
      loadRevision++;
      if (get().content) set({ content: undefined });
      return;
    }
    const key = fileEditContentKey(selection.conversationId, selection.messageId, edit);
    if (!retry && get().content?.key === key && get().content?.sources === edit.sources) return;
    const revision = ++loadRevision;
    set({ content: { key, status: "loading" } });
    try {
      const result = edit.sources ? await (async () => {
        const sources: FileEdit[] = [];
        let bytes = 0;
        for (const source of edit.sources!) {
          let captured = source;
          if (source.blobKey) {
            const loaded = await loadContent(selection.conversationId, source.blobKey);
            if (revision !== loadRevision) return { status: "missing" as const };
            if (loaded.status !== "ready") return loaded;
            captured = { ...source, ...loaded.content, truncated: false };
          }
          bytes += [captured.oldText, captured.newText, captured.patch].reduce((total, text) => total + (text?.length ?? 0) * 2, 0);
          if (bytes > 8 * 1024 * 1024) return { status: "large" as const };
          sources.push(captured);
        }
        const summary = aggregateFileEdits(sources)[0];
        return { status: "ready" as const, content: summary ?? { action: "update" as const, oldText: "", newText: "", unchanged: true } };
      })() : await loadContent(selection.conversationId, edit.turnKey ?? edit.blobKey!, edit.turnKey && selection.messageId
        ? { messageId: selection.messageId, path: edit.path } : undefined);
      if (revision !== loadRevision) return;
      if (result.status === "ready") {
        const hydrated: FileEdit = { ...edit, ...result.content, truncated: false };
        const diff = getFileDiff(hydrated);
        const counts = Object.fromEntries(Object.entries({
          ...get().counts, [edit.turnKey ?? edit.blobKey ?? key]: diff.notice ? null : { added: diff.added, removed: diff.removed, ...(hydrated.unchanged ? { unchanged: true } : {}) }
        }).slice(-256));
        set({ content: { key, status: "ready", edit: hydrated, sources: edit.sources }, counts });
      } else {
        set({ content: { key, status: result.status } });
      }
    } catch {
      if (revision === loadRevision) set({ content: { key, status: "error" } });
    }
  }
}));
