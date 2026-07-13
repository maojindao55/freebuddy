import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuthenticationStore } from "@/store/authenticationStore";

export function AuthenticationDialog() {
  const queue = useAuthenticationStore((state) => state.queue);
  const terminalQueue = useAuthenticationStore((state) => state.terminalQueue);
  const decide = useAuthenticationStore((state) => state.decide);
  const writeTerminal = useAuthenticationStore((state) => state.writeTerminal);
  const cancelTerminal = useAuthenticationStore((state) => state.cancelTerminal);
  const current = queue[0];
  const terminal = terminalQueue[0];
  const [terminalInput, setTerminalInput] = useState("");
  const outputRef = useRef<HTMLPreElement>(null);
  const { t } = useTranslation();

  useEffect(() => {
    if (!current) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void decide(current.requestId, { outcome: "cancelled" });
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [current, decide]);

  useEffect(() => {
    if (!terminal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void cancelTerminal(terminal.requestId);
      }
    };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [cancelTerminal, terminal]);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [terminal?.output]);

  if (terminal) {
    const readableOutput = terminal.output.replace(
      // Strip terminal control sequences while keeping the PTY text readable.
      // eslint-disable-next-line no-control-regex
      /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g,
      ""
    );
    return (
      <div className="permission-backdrop" role="dialog" aria-modal="true">
        <div className="permission-dialog authentication-dialog">
          <header className="permission-header">
            <span className="permission-eyebrow">
              {t("authentication.terminalEyebrow")}
            </span>
            <h2 className="permission-title">
              {t("authentication.terminalTitle", {
                agent: terminal.agentName
              })}
            </h2>
            <p className="authentication-description">
              {t("authentication.terminalDescription", {
                method: terminal.methodName
              })}
            </p>
          </header>

          <pre ref={outputRef} className="authentication-terminal-output">
            {readableOutput || t("authentication.terminalStarting")}
          </pre>

          <form
            className="authentication-terminal-input-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!terminalInput || !terminal.running) return;
              void writeTerminal(terminal.requestId, `${terminalInput}\r`);
              setTerminalInput("");
            }}
          >
            <input
              type="text"
              value={terminalInput}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              disabled={!terminal.running}
              aria-label={t("authentication.terminalInput")}
              placeholder={t("authentication.terminalInput")}
              onChange={(event) => setTerminalInput(event.target.value)}
              onKeyDown={(event) => {
                const sequences: Partial<Record<string, string>> = {
                  ArrowUp: "\u001b[A",
                  ArrowDown: "\u001b[B",
                  ArrowRight: "\u001b[C",
                  ArrowLeft: "\u001b[D",
                  Tab: "\t"
                };
                const sequence = sequences[event.key];
                if (!sequence || !terminal.running) return;
                event.preventDefault();
                void writeTerminal(terminal.requestId, sequence);
              }}
            />
            <button
              type="submit"
              className="permission-btn permission-btn-primary"
              disabled={!terminal.running || terminalInput.length === 0}
            >
              {t("authentication.sendInput")}
            </button>
          </form>

          <div className="permission-actions">
            <button
              type="button"
              className="permission-btn permission-btn-ghost"
              disabled={!terminal.running}
              onClick={() => void cancelTerminal(terminal.requestId)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className="permission-backdrop" role="dialog" aria-modal="true">
      <div className="permission-dialog authentication-dialog">
        <header className="permission-header">
          <span className="permission-eyebrow">
            {t("authentication.eyebrow")}
          </span>
          <h2 className="permission-title">
            {t("authentication.title", { agent: current.agentName })}
          </h2>
          <p className="authentication-description">
            {t("authentication.description")}
          </p>
        </header>

        <div className="authentication-methods">
          {current.methods.map((method) => (
            <button
              key={method.methodId}
              type="button"
              className="authentication-method"
              disabled={current.resolving}
              aria-label={t("authentication.continueWith", {
                name: method.name
              })}
              onClick={() =>
                void decide(current.requestId, {
                  outcome: "selected",
                  methodId: method.methodId
                })
              }
            >
              <span className="authentication-method-name">{method.name}</span>
              {method.description ? (
                <span className="authentication-method-description">
                  {method.description}
                </span>
              ) : null}
              <span className="authentication-method-action">
                {t("authentication.continueWith", { name: method.name })}
              </span>
            </button>
          ))}
        </div>

        <div className="permission-actions">
          <button
            type="button"
            className="permission-btn permission-btn-ghost"
            disabled={current.resolving}
            onClick={() =>
              void decide(current.requestId, { outcome: "cancelled" })
            }
          >
            {t("common.cancel")}
          </button>
        </div>

        {queue.length > 1 ? (
          <div className="permission-queue">
            {t("authentication.morePending", { count: queue.length - 1 })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
