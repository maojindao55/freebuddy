import fs from "node:fs";
import path from "node:path";

const filesToPatch = [
  path.join(process.cwd(), "node_modules", "node-pty", "binding.gyp"),
  path.join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "deps",
    "winpty",
    "src",
    "winpty.gyp"
  )
];

for (const filePath of filesToPatch) {
  if (!fs.existsSync(filePath)) continue;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("'SpectreMitigation': 'Spectre'")) {
      const patched = content.replaceAll(
        "'SpectreMitigation': 'Spectre'",
        "'SpectreMitigation': 'false'"
      );
      fs.writeFileSync(filePath, patched, "utf8");
      console.log(`[patch-node-pty-spectre] Successfully disabled SpectreMitigation in ${path.relative(process.cwd(), filePath)}`);
    }
  } catch (err) {
    console.warn(`[patch-node-pty-spectre] Failed to patch ${filePath}:`, err.message);
  }
}
