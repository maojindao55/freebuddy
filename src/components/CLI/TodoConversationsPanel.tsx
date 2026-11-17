import { useTodoPanelUiStore } from "@/store/conversationPanelUiStore";
import { ConversationBoard } from "./ConversationTaskPanel";

export interface TodoConversationsPanelProps {
  fullscreen: boolean;
  onToggleFullscreen(): void;
  onOpenAllConversations(): void;
  onOpenConversation(id: string): void;
  onNewConversation(): void;
  onOpenFile?(conversationId: string, messageId: string, path: string): void;
}

export function TodoConversationsPanel({
  fullscreen,
  onToggleFullscreen,
  onOpenAllConversations,
  onOpenConversation,
  onNewConversation,
  onOpenFile
}: TodoConversationsPanelProps) {
  const ui = useTodoPanelUiStore();
  return (
    <ConversationBoard
      mode="todos"
      ui={ui}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
      onOpenAllConversations={onOpenAllConversations}
      onOpenConversation={onOpenConversation}
      onNewConversation={onNewConversation}
      onOpenFile={onOpenFile}
    />
  );
}
