import { useTranslation } from "react-i18next";
import { CLIAdaptersTab } from "./CLIAdaptersTab";
import { GeneralTab } from "./GeneralTab";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("common.settings")}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </header>
        <div className="settings-body">
          <GeneralTab />
          <CLIAdaptersTab />
        </div>
      </div>
    </div>
  );
}
