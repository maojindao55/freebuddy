// Screenshot driver for the doc-studio preview fixture via Chrome DevTools Protocol.
// Usage: node tests/fixtures/doc-studio-shoot.mjs [outdir]   (vite must run on :5199)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:5199/tests/fixtures/doc-studio-preview.html";
const OUT = process.argv[2] || "artifacts/product-design/doc-studio-audit/after";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });

const shots = [
  { name: "docstudio-sheet-light", query: "view=sheet&theme=light", w: 1568, h: 912 },
  { name: "docstudio-sheet-light-chat", query: "view=sheet&theme=light&chat=1", w: 1568, h: 912 },
  { name: "docstudio-sheet-dark-chat", query: "view=sheet&theme=dark&chat=1", w: 1568, h: 912 },
  { name: "docstudio-empty-light", query: "view=empty&theme=light", w: 1568, h: 912 },
  { name: "docstudio-markdown-light", query: "view=markdown&theme=light", w: 1568, h: 912 },
  { name: "butler-chat-light", query: "view=butler&theme=light&chat=1", w: 420, h: 640 },
  {
    name: "docstudio-panel-closed",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    actions: [
      `
      const btns = [...document.querySelectorAll('.ds-copilot-header .ds-icon-btn')];
      btns[btns.length - 1]?.click();
      `
    ]
  },
  {
    name: "docstudio-prechat-v3",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "docstudio-prechat-text",
    query: "view=markdown&theme=light",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "docstudio-header-picker-popover",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    wait: 1200,
    actions: [
      `
      document.querySelector('.ds-agent-title-picker .agent-picker-trigger')?.click();
      `
    ]
  },
  {
    name: "docstudio-header-chat-light",
    query: "view=sheet&theme=light&chat=1",
    w: 1568, h: 912,
    wait: 1200
  },
  {
    name: "docstudio-model-picker",
    query: "view=sheet&theme=light&chat=1",
    w: 1568, h: 912,
    wait: 1200,
    actions: [
      `
      document.querySelector('.chat-composer .session-config-picker-trigger')?.click();
      `
    ]
  },
  {
    name: "docstudio-header-chat-dark",
    query: "view=sheet&theme=dark&chat=1",
    w: 1568, h: 912,
    wait: 1200
  },
  {
    name: "v4-prechat-tall",
    query: "view=sheet&theme=light",
    w: 1568, h: 1500,
    wait: 1500
  },
  {
    name: "v4-prechat",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "v4-prechat-text",
    query: "view=markdown&theme=light",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "v4-prechat-dark",
    query: "view=sheet&theme=dark",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "v4-prechat-narrow",
    query: "view=sheet&theme=light&copilotWidth=320",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "v4-prechat-short",
    query: "view=sheet&theme=light",
    w: 1440, h: 640,
    wait: 1500
  },
  {
    name: "v4-updates-summary",
    query: "view=sheet&theme=light&live=1",
    w: 1568, h: 912,
    wait: 3400
  },
  {
    name: "v4-updates-summary-expanded",
    query: "view=sheet&theme=light&live=1",
    w: 1568, h: 912,
    wait: 3400,
    actions: [
      `document.querySelector('.ds-updates-summary-toggle')?.click()`
    ]
  },
  {
    name: "v4-updates-streaming",
    query: "view=sheet&theme=light&stream=1",
    w: 1568, h: 912,
    wait: 1800
  },
  {
    name: "docstudio-prechat-agent-picker",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    wait: 1500
  },
  {
    name: "docstudio-header-agent-light",
    query: "view=sheet&theme=light&chat=1",
    w: 1568, h: 912,
    wait: 1200
  },
  {
    name: "docstudio-header-agent-dark",
    query: "view=sheet&theme=dark&chat=1",
    w: 1568, h: 912,
    wait: 1200
  },
  {
    name: "docstudio-auto-applied",
    query: "view=sheet&theme=light&live=1",
    w: 1568, h: 912,
    wait: 3400
  },
  {
    name: "docstudio-formula-fixed",
    query: "view=sheet&theme=light&live=1",
    w: 1568, h: 912,
    wait: 3400
  },
  {
    name: "docstudio-external-reload",
    query: "view=sheet&theme=light&ext=1",
    w: 1568, h: 912,
    wait: 3400
  },
  {
    name: "docstudio-sheet-selection-chip",
    query: "view=sheet&theme=light",
    w: 1568, h: 912,
    // Drag-select starting at the "124530" cell, then click "AI 编辑" for the chip.
    actions: [
      `
      window.__dsCells = [...document.querySelectorAll('.ds-cell')];
      window.__dsA = window.__dsCells.find(c => c.textContent === '124530') || window.__dsCells[8];
      const ra = window.__dsA.getBoundingClientRect();
      window.__dsA.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: ra.x + 5, clientY: ra.y + 5 }));
      `,
      `
      const idx = window.__dsCells.indexOf(window.__dsA);
      const b = window.__dsCells[idx + 4 + 5 * 8] || window.__dsCells[40];
      const rb = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: rb.x + 5, clientY: rb.y + 5 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      `,
      `
      const aiBtn = [...document.querySelectorAll('.ds-toolbar .ds-btn')].pop();
      aiBtn && aiBtn.click();
      `
    ]
  },
  {
    name: "docstudio-copilot-model-picker",
    query: "view=sheet&theme=light&chat=1",
    w: 1568, h: 912,
    actions: [
      `
      const t = document.querySelector('.chat-composer .session-config-picker-trigger');
      t && t.click();
      `
    ]
  }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/ds-shoot-profile",
  "about:blank"
], { stdio: "ignore" });

async function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  // wait for devtools endpoint
  let version;
  for (let i = 0; i < 50; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("chrome devtools endpoint never came up");

  const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
  for (const shot of shots) {
    if (filter && !filter.test(shot.name)) continue;
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    await cdp(ws, ++id, "Page.enable");
    await cdp(ws, ++id, "Emulation.setDeviceMetricsOverride", {
      width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: false
    });
    await cdp(ws, ++id, "Page.navigate", { url: `${BASE}?${shot.query}` });
    // wait for the app shell
    for (let i = 0; i < 60; i++) {
      const res = await cdp(ws, ++id, "Runtime.evaluate", {
        expression: `!!document.querySelector('.ds-root, .butler-chat-window')`,
        returnByValue: true
      });
      if (res.result.value) break;
      await sleep(250);
    }
    await sleep(shot.wait ?? 1200);
    if (shot.actions) {
      for (const step of shot.actions) {
        await cdp(ws, ++id, "Runtime.evaluate", { expression: step });
        await sleep(350);
      }
      await sleep(500);
    }
    const res = await cdp(ws, ++id, "Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, `${shot.name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, "base64"));
    console.log(file);
    ws.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`).catch(() => {});
  }
} finally {
  chrome.kill();
}
