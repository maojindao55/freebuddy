import { Component, type ErrorInfo, type ReactNode } from "react";
import i18next from "i18next";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SettingsTabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[SettingsTabErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="settings-tab">
          <p className="adapter-check-error" role="alert">
            {i18next.t("settings.cli.tabError", {
              err: this.state.error.message
            })}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}
