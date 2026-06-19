import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CliPermissionOption } from "@/services/cli/types";
import { usePermissionStore } from "@/store/permissionStore";

function describeRawInput(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  try {
    const text = JSON.stringify(raw, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  } catch {
    return String(raw);
  }
}

function optionVariant(option: CliPermissionOption): string {
  const k = (option.kind ?? "").toLowerCase();
  if (k.startsWith("allow")) return "primary";
  if (k.startsWith("reject")) return "danger";
  if (/allow/i.test(option.optionId)) return "primary";
  if (/reject|deny|cancel/i.test(option.optionId)) return "danger";
  return "ghost";
}

export function PermissionDialog() {
  const queue = usePermissionStore((s) => s.queue);
  const decide = usePermissionStore((s) => s.decide);
  const current = queue[0];
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

  const inputText = useMemo(
    () => describeRawInput(current?.toolCall?.rawInput),
    [current]
  );

  if (!current) return null;

  const title =
    current.toolCall?.title ||
    current.toolCall?.kind ||
    t("permission.fallbackTitle");
  const subtitle =
    current.toolCall?.title && current.toolCall?.kind
      ? current.toolCall.kind
      : null;

  return (
    <div className="permission-backdrop" role="dialog" aria-modal="true">
      <div
        className="permission-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="permission-header">
          <span className="permission-eyebrow">{t("permission.title")}</span>
          <h2 className="permission-title">{title}</h2>
          {subtitle ? (
            <span className="permission-subtitle">{subtitle}</span>
          ) : null}
        </header>

        {inputText ? (
          <div className="permission-section">
            <span className="permission-label">{t("permission.input")}</span>
            <pre className="permission-input">{inputText}</pre>
          </div>
        ) : null}

        <p className="permission-help">{t("permission.help")}</p>

        <div className="permission-actions">
          {current.options.map((option) => {
            const variant = optionVariant(option);
            return (
              <button
                key={option.optionId}
                type="button"
                className={`permission-btn permission-btn-${variant}`}
                disabled={current.resolving}
                onClick={() =>
                  void decide(current.requestId, {
                    outcome: "selected",
                    optionId: option.optionId
                  })
                }
              >
                {option.name || option.optionId}
              </button>
            );
          })}
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
            {t("permission.morePending", { count: queue.length - 1 })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
