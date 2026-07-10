import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-electron", "telemetry-config.json");
const apiKey = process.env.FREEBUDDY_POSTHOG_KEY?.trim() ?? "";
const host =
  process.env.FREEBUDDY_POSTHOG_HOST?.trim() || "https://us.i.posthog.com";

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ apiKey, host }, null, 2)}\n`);

if (!apiKey) {
  console.log(
    "PostHog telemetry config generated without a key; analytics will be disabled."
  );
}
