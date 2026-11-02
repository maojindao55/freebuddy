// Selection and reading are different: the task panel retains the last chat
// selection while showing summaries for many conversations.
let conversationReadingVisible = true;

export function setConversationReadingVisible(visible: boolean): void {
  conversationReadingVisible = visible;
}

export function isConversationReadingVisible(): boolean {
  return conversationReadingVisible;
}
