import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Conversation } from "@/services/cli/types";
import type { ConversationReferenceDraft } from "@/utils/conversationReferences";
import { hasConversationDrag, resolveConversationDrag } from "@/utils/conversationDrag";

export function useConversationReferenceDrop({ conversations, targetId, scopeKey, disabled, onAdd, onReject }: {
  conversations: Conversation[];
  targetId?: string;
  scopeKey: string;
  disabled: boolean;
  onAdd: (reference: ConversationReferenceDraft) => void;
  onReject: (reason: "self" | "unavailable") => void;
}) {
  const depth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const reset = () => { depth.current = 0; setDragActive(false); };

  useEffect(() => { reset(); }, [scopeKey, disabled]);
  useEffect(() => {
    // Escape and dropping outside the composer must also clear the highlight.
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const claim = (event: DragEvent) => {
    if (!hasConversationDrag(event.dataTransfer)) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return {
    dragActive,
    handleDragEnter(event: DragEvent) {
      if (!claim(event)) return false;
      if (!disabled) { depth.current += 1; setDragActive(true); }
      return true;
    },
    handleDragLeave(event: DragEvent) {
      if (!claim(event)) return false;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragActive(false);
      return true;
    },
    handleDragOver(event: DragEvent) {
      if (!claim(event)) return false;
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      return true;
    },
    handleDrop(event: DragEvent) {
      if (!claim(event)) return false;
      reset();
      if (disabled) return true;
      const result = resolveConversationDrag(event.dataTransfer, conversations, targetId);
      if (result.reference) {
        onAdd(result.reference);
        event.currentTarget.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      } else onReject(result.error);
      return true;
    }
  };
}
