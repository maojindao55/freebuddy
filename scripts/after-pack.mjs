import { verifyPackagedPiRuntime } from "./pi-runtime-pack-guard.mjs";
import { verifyPackagedNodeRuntime } from "./managed-node-package.mjs";

export default async function afterPack(context) {
  // Runs on every platform before the existing platform-specific steps:
  // a packaged app without the bundled pi runtime silently breaks Pi and the
  // onboarding GuideBuddy (see scripts/pi-runtime-pack-guard.mjs).
  const verified = verifyPackagedPiRuntime(context.appOutDir);
  console.log(`[pi-runtime] afterPack guard: bundled pi runtime verified in ${verified} app bundle(s)`);

  if (context.electronPlatformName === "darwin") {
    const macos = (await import("./after-pack-macos.mjs")).default;
    return macos(context);
  }
  if (context.electronPlatformName === "win32") {
    verifyPackagedNodeRuntime(context.appOutDir);
    const { packWindowsExplorerCommand } = await import("./pack-windows-explorer-command.mjs");
    return packWindowsExplorerCommand(context);
  }
}
