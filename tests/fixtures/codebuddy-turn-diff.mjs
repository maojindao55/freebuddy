export const codebuddyTurnChanges = [
  { type: "diff", path: "README.md", oldText: "Original description.", newText: "Updated description." },
  { type: "diff", path: "README.md", oldText: "- Fire: hold space", newText: "- Fire: keep pressing space" },
  { type: "diff", path: "README.md", oldText: "Store high scores locally.", newText: "Save high scores in browser storage." }
];
const lines = Array.from({ length: 50 }, (_, index) => `Unchanged line ${index + 1}`);
lines[0] = "# Game";
for (const [index, line] of [3, 24, 43].entries()) lines[line - 1] = codebuddyTurnChanges[index].oldText;
export const codebuddyTurnBefore = lines.join("\n") + "\n";
export const codebuddyTurnAfter = codebuddyTurnChanges.reduce((text, change) => text.replace(change.oldText, change.newText), codebuddyTurnBefore);

export function codebuddyTurnUpdate(index, status = "pending", file = "README.md") {
  const change = { ...codebuddyTurnChanges[index], path: file };
  return status === "pending" ? {
    sessionUpdate: "tool_call", toolCallId: `snippet-${index}`, title: `Edit ${file}`, kind: "edit", status,
    rawInput: { file_path: file, old_string: change.oldText, new_string: change.newText, replace_all: false },
    content: [change], locations: [{ path: file }]
  } : {
    sessionUpdate: "tool_call_update", toolCallId: `snippet-${index}`, status,
    content: [{ type: "content", content: { type: "text", text: `Successfully edited file: ${file}` } }],
    rawOutput: { type: "text", text: `Successfully edited file: ${file}` }
  };
}
