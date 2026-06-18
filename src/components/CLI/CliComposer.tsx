import { useEffect, useMemo, useState } from "react";

import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useCliTaskStore } from "@/store/cliTaskStore";
import { cliClient } from "@/services/cli/client";
import type { CLIMember } from "@/config/aiMembers";

export function CliComposer({
  defaultCwd
}: {
  defaultCwd?: string;
}) {
  const members = useCliTaskStore((s) => s.members);
  const start = useCliTaskStore((s) => s.start);
  const resolve = useCliExecutorStore((s) => s.resolve);
  const check = useCliExecutorStore((s) => s.check);
  const loaded = useCliExecutorStore((s) => s.loaded);
  const load = useCliExecutorStore((s) => s.load);

  const [memberId, setMemberId] = useState<string>(members[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [sending, setSending] = useState(false);
  const [preflightMsg, setPreflightMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const member: CLIMember | undefined = useMemo(
    () => members.find((m) => m.id === memberId),
    [members, memberId]
  );
  const resolved = member ? resolve(member.cli.adapter) : undefined;
  const installed = resolved?.runtime?.installed === true;

  const onSend = async () => {
    if (!member || !prompt.trim()) return;
    setSending(true);
    setPreflightMsg(null);
    try {
      // Preflight: ensure the adapter binary is installed.
      const r = await cliClient.check(member.cli.adapter, member.cli.binary);
      await check(member.cli.adapter);
      if (!r.installed) {
        setPreflightMsg(
          `${resolved?.label ?? member.cli.adapter} is not installed. Open Settings → CLI Adapters to install.`
        );
        return;
      }
      await start({ member, prompt: prompt.trim(), cwd: cwd.trim() || undefined });
      setPrompt("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="cli-composer">
      <div className="cli-composer-toolbar">
        <label>
          Agent
          <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Workdir
          <input
            placeholder="/absolute/path (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>
        <span className={`runtime-pill ${installed ? "ok" : "warn"}`}>
          {installed ? `✓ ${resolved?.runtime?.version ?? "ready"}` : "not installed"}
        </span>
      </div>

      <textarea
        rows={3}
        value={prompt}
        placeholder={`Ask ${member?.name ?? "CLI agent"} to build, inspect, refactor…`}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void onSend();
          }
        }}
      />

      {preflightMsg && <div className="preflight-warn">{preflightMsg}</div>}

      <div className="cli-composer-actions">
        <span className="muted">⌘/Ctrl + Enter to send</span>
        <button
          className="primary"
          disabled={sending || !prompt.trim() || !member}
          onClick={onSend}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
