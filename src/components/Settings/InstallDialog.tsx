import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";

interface InstallDialogProps {
  command: string;
  label: string;
  onClose: (result: { success: boolean; output: string }) => void;
}

export function InstallDialog({ command, label, onClose }: InstallDialogProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef("");

  useEffect(() => {
    const off = cliClient.installStream(command, (event) => {
      if (event.type === "stdout" || event.type === "stderr") {
        outputRef.current += event.content;
        setLines((prev) => {
          const merged = prev.join("\n") + event.content;
          return merged.split("\n");
        });
      } else if (event.type === "done") {
        setExitCode(event.exitCode);
        setDone(true);
      }
    });
    return () => off();
  }, [command]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const success = done && exitCode === 0;

  return (
    <div className="modal-backdrop" onClick={() => onClose({ success, output: outputRef.current })}>
      <div className="modal install-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("settings.cli.installTitle", { label })}</h2>
          <button
            className="icon-btn"
            onClick={() => onClose({ success, output: outputRef.current })}
            aria-label={t("common.close")}
            disabled={!done}
          >
            ✕
          </button>
        </header>

        <div className="install-output" ref={scrollRef}>
          {lines.length === 0 && !done && (
            <span className="muted">{t("settings.cli.installStarting")}</span>
          )}
          {lines.map((line, i) => (
            <div key={i} className="install-output-line">{line}</div>
          ))}
          {!done && (
            <span className="install-cursor">▌</span>
          )}
        </div>

        {done && (
          <div className={`install-result ${success ? "ok" : "warn"}`}>
            {success
              ? t("settings.cli.installSuccess")
              : t("settings.cli.installFailed", { code: exitCode ?? t("settings.cli.unknownExit"), output: "" })}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={() => onClose({ success, output: outputRef.current })} disabled={!done}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
