// Sanitized reproduction: AGY provides replacement snippets and a patch whose
// trailing blank context line was trimmed from the structured diff entry.
export const agyTurnChanges = [
  {
    type: "diff", path: "README.md",
    oldText: "# Star Fighter", newText: "# Star Fighter (Canvas)",
    patch: "@@ -1,4 +1,4 @@\n-# Star Fighter\n+# Star Fighter (Canvas)\n \n A shooting game."
  },
  {
    type: "diff", path: "README.md",
    oldText: "A shooting game.", newText: "A lightweight shooting game.",
    patch: "@@ -1,6 +1,6 @@\n # Star Fighter (Canvas)\n \n-A shooting game.\n+A lightweight shooting game.\n \n ## Run"
  },
  {
    type: "diff", path: "README.md",
    oldText: "Open index.html in a browser.", newText: "Open index.html in a browser to start playing.",
    patch: "@@ -4,7 +4,7 @@\n \n ## Run\n \n-Open index.html in a browser.\n+Open index.html in a browser to start playing.\n \n Or start a local static server:"
  }
];

export function agyTurnUpdate(index) {
  const change = agyTurnChanges[index];
  return {
    sessionUpdate: "tool_call_update", toolCallId: `edit-${index}`, title: "replace_file_content", kind: "edit", status: "completed",
    locations: [{ path: change.path }], content: [change],
    rawOutput: `Changes made to ${change.path}.\n[diff_block_start]\n${change.patch}\n \n[diff_block_end]\n`
  };
}
