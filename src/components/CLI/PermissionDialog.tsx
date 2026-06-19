import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CliPermissionOption } from "@/services/cli/types";
import { usePermissionStore } from "@/store/permissionStore";
import {
  actionKeyFor,
  optionKeyFor,
  permissionTargets
} from "@/utils/permissionDisplay";

function optionVariant(option: CliPermissionOption): string {
  const k = (option.kind ?? "").toLowerCase();
  if (k.startsWith("allow")) return "primary";
  if (k.startsWith("reject")) return "danger";
  if (/allow/i.test(option.optionId)) return "primary";
  if (/reject|deny|cancel/i.test(option.optionId)) return "danger";
  return "ghost";
}

function shortPath(p: string): string {
  const segs = p.split(/[/\\]/).filter(Boolean);
  if (segs.length <= 2) return p;
  return `…/${segs.slice(-2).join("/")}`;
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

  const targets = useMemo(
    () => (current ? permissionTargets(current.toolCall) : []),
    [current]
  );

  if (!current) return null;

  const actionKey = actionKeyFor(current.toolCall?.title, current.toolCall?.kind);
  const heading = actionKey
    ? t(actionKey)
    : current.toolCall?.title || current.toolCall?.kind || t("permission.title");

  return (
    <div className="permission-backdrop" role="dialog" aria-modal="true">
      <div
        className="permission-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="permission-header">
          <span className="permission-eyebrow">{t("permission.title")}</span>
          <h2 className="permission-title">{heading}</h2>
        </header>

        {targets.length > 0 ? (
          <ul className="permission-targets">
            {targets.map((target) => (
              <li key={target} title={target}>
                <code>{shortPath(target)}</code>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="permission-actions">
          {current.options.map((option) => {
            const variant = optionVariant(option);
            const labelKey = optionKeyFor(option.kind);
            const label = labelKey ? t(labelKey) : option.name || option.optionId;
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
                {label}
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
