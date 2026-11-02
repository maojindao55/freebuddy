import { execSync } from "node:child_process";

// Mirrors how electron-builder picks a macOS signing identity: an explicit
// CSC_NAME wins, otherwise scan the keychain search list and prefer
// "Developer ID Application" over "Apple Development". Keeping this aligned
// matters because nested code (e.g. Contents/PlugIns) that electron-builder
// does not sign itself must be signed with the same identity as the outer
// bundle, or macOS rejects the pairing.
export function resolveMacSigningIdentity() {
  const fromEnv = process.env.CSC_NAME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  let output;
  try {
    output = execSync("security find-identity -v -p codesigning", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }

  const identities = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\)\s+[A-Fa-f0-9]+\s+"([^"]+)"/);
    if (match) identities.push(match[1]);
  }

  return (
    identities.find((name) => name.startsWith("Developer ID Application")) ??
    identities.find((name) => name.startsWith("Apple Development")) ??
    identities[0] ??
    null
  );
}
