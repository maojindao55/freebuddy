import { useState } from "react";

import { useConversationStore } from "@/store/conversationStore";

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const members = useConversationStore((s) => s.members);
  const create = useConversationStore((s) => s.newConversation);

  const [memberId, setMemberId] = useState(members[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [title, setTitle] = useState("");

  const onCreate = async () => {
    const member = members.find((m) => m.id === memberId);
    if (!member) return;
    await create({
      member,
      cwd: cwd.trim() || undefined,
      title: title.trim() || undefined
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New Conversation</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>Agent</span>
            <select
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.cli.adapter})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Workdir</span>
            <input
              placeholder="/absolute/path (optional)"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Title</span>
            <input
              placeholder="Auto from agent + workdir"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        </div>
        <footer className="modal-footer">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={onCreate}>
            Create
          </button>
        </footer>
      </div>
    </div>
  );
}
