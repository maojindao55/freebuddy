import { CLIAdaptersTab } from "./CLIAdaptersTab";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="settings-body">
          <CLIAdaptersTab />
        </div>
      </div>
    </div>
  );
}
