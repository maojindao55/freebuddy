import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./i18n";
import "../styles.css";
import { installDebugLogClient } from "./services/debugLog";

installDebugLogClient();

const surface = new URLSearchParams(window.location.search).get("surface");
if (surface) document.documentElement.dataset.surface = surface;

async function renderSurface() {
  const content = await (async () => {
    if (surface === "butler-pet") {
      const { ButlerBuddyPet } = await import(
        "./components/ButlerBuddy/ButlerBuddyPet"
      );
      return <ButlerBuddyPet />;
    }
    if (surface === "butler-screen-ball") {
      const { ButlerBuddyScreenBall } = await import(
        "./components/ButlerBuddy/ButlerBuddyScreenBall"
      );
      return <ButlerBuddyScreenBall />;
    }
    if (surface === "butler-chat") {
      const { ButlerBuddyChat } = await import(
        "./components/ButlerBuddy/ButlerBuddyChat"
      );
      return <ButlerBuddyChat />;
    }
    const { default: App } = await import("./App");
    return <App />;
  })();

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary>{content}</ErrorBoundary>
    </StrictMode>
  );
}

void renderSurface();
