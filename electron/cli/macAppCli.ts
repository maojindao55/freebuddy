import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAC_APP_BUNDLED_CLIS: Record<string, string[]> = {
  codex: ["Codex.app", "ChatGPT.app"]
};

interface MacAppCliLookupOptions {
  platform?: NodeJS.Platform;
  home?: string;
  isFile?: (candidate: string) => boolean;
}

export function macAppCliCandidates(binary: string, home = os.homedir()): string[] {
  const appNames = MAC_APP_BUNDLED_CLIS[binary] || [];
  const applicationRoots = ["/Applications", path.posix.join(home, "Applications")];
  return applicationRoots.flatMap((root) =>
    appNames.map((appName) =>
      path.posix.join(root, appName, "Contents", "Resources", binary)
    )
  );
}

export function findMacAppCliBinary(
  binary: string,
  options: MacAppCliLookupOptions = {}
): string | undefined {
  if ((options.platform || process.platform) !== "darwin") return undefined;
  const isFile = options.isFile || ((candidate: string) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return macAppCliCandidates(binary, options.home).find(isFile);
}
