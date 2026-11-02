import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const temp = mkdtempSync(path.join(tmpdir(), "fb-provider-icons-"));
const require = createRequire(import.meta.url);
test.after(() => rmSync(temp, { recursive: true, force: true }));
const outfile = path.join(temp, "icons.cjs");
await build({
  entryPoints: ["src/components/Settings/ProviderBrandIcon.tsx"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  loader: { ".png": "dataurl", ".webp": "dataurl", ".css": "empty" },
  plugins: [{
    name: "shared-react",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path: specifier }) => ({
        path: require.resolve(specifier),
        external: true,
      }));
    },
  }],
});
const { ProviderBrandIcon } = require(outfile);
const render = props => renderToStaticMarkup(createElement(ProviderBrandIcon, props));
const presets = JSON.parse(readFileSync(new URL("../src/services/freebie/providers.json", import.meta.url), "utf8")).providers;

test("every bundled provider renders an icon without a remote image dependency", () => {
  for (const preset of presets) {
    const html = render({ nameOrId: preset.id, lobeIconId: preset.icon });
    assert.match(html, /<(svg|img)\b/, preset.id);
    assert.doesNotMatch(html, /<(?:img|image)\b[^>]*(?:src|href)="https?:/i, preset.id);
    if (preset.icon) assert.doesNotMatch(html, /lucide-cable/, `${preset.id} should retain its brand logo`);
  }
});

test("color-suffixed catalog IDs resolve to the same local brand as avatar IDs", () => {
  for (const preset of presets.filter(item => item.icon?.endsWith("-color"))) {
    const props = { nameOrId: preset.name };
    assert.equal(
      render({ ...props, lobeIconId: preset.icon }),
      render({ ...props, lobeIconId: preset.icon.replace(/-color$/, "") }),
      preset.id,
    );
  }
});

test("unknown and malformed IDs always produce a visible generic icon", () => {
  for (const name of ["custom-gateway", "constructor", "__proto__", "toString", ""]) {
    assert.match(render({ nameOrId: name, lobeIconId: name }), /lucide-cable/);
  }
  assert.doesNotMatch(render({ nameOrId: "DeepSeek", lobeIconId: "missing-icon" }), /lucide-cable/);
});

test("FreeBuddy uses the bundled app identity and labels are escaped", () => {
  assert.match(render({ nameOrId: "FreeBuddy 体验通道" }), /src="data:image\/png;base64,/);
  const html = render({ nameOrId: '<script>alert("x")</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /role="img"/);
});
