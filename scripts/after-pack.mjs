export default async function afterPack(context) {
  if (context.electronPlatformName === "darwin") {
    const macos = (await import("./after-pack-macos.mjs")).default;
    return macos(context);
  }
  if (context.electronPlatformName === "win32") {
    const { packWindowsExplorerCommand } = await import("./pack-windows-explorer-command.mjs");
    return packWindowsExplorerCommand(context);
  }
}
