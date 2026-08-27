import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.join(rootDir, "packages");

const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|export\s+\*\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;

const FORBIDDEN_HOST = [
  /^electron$/,
  /^electron\//,
  /better-sqlite3/,
  /^react$/,
  /^react-dom$/,
  /^react-i18next$/,
  /^i18next$/,
  /^zustand$/,
  /ipcSend/,
  /WebContents/,
  /BrowserWindow/,
  /getDb/
];

const RULES = {
  protocol: {
    allowPackages: [],
    forbid: [
      ...FORBIDDEN_HOST,
      /^node:fs/,
      /^node:child_process/,
      /^node:process/,
      /^fs$/,
      /^child_process$/
    ]
  },
  "workflow-core": {
    allowPackages: ["@freebuddy/protocol"],
    forbid: FORBIDDEN_HOST
  },
  "delegation-core": {
    allowPackages: ["@freebuddy/protocol"],
    forbid: FORBIDDEN_HOST
  },
  "cli-stream": {
    allowPackages: ["@freebuddy/protocol"],
    forbid: FORBIDDEN_HOST
  },
  "agent-runtime": {
    allowPackages: ["@freebuddy/protocol"],
    forbid: FORBIDDEN_HOST
  },
  "workflow-runtime": {
    allowPackages: [
      "@freebuddy/protocol",
      "@freebuddy/workflow-core",
      "@freebuddy/agent-runtime"
    ],
    forbid: FORBIDDEN_HOST
  },
  "delegation-runtime": {
    allowPackages: [
      "@freebuddy/protocol",
      "@freebuddy/delegation-core",
      "@freebuddy/agent-runtime"
    ],
    forbid: FORBIDDEN_HOST
  },
  "storage-sqlite": {
    allowPackages: [
      "@freebuddy/protocol",
      "@freebuddy/workflow-runtime",
      "@freebuddy/delegation-runtime"
    ],
    forbid: [/^electron$/, /^electron\//, /^react$/, /^react-dom$/, /^zustand$/]
  },
  "runtime-entry": {
    allowPackages: [
      "@freebuddy/protocol",
      "@freebuddy/workflow-runtime",
      "@freebuddy/delegation-runtime",
      "@freebuddy/agent-runtime",
      "@freebuddy/cli-stream"
    ],
    forbid: FORBIDDEN_HOST
  },
  "runtime-host": {
    allowPackages: ["@freebuddy/protocol"],
    forbid: [
      /^electron$/,
      /^electron\//,
      /^react$/,
      /^react-dom$/,
      /^zustand$/,
      /electron-updater/
    ]
  }
};

function walkTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      out.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

function extractImports(source) {
  const specs = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    specs.push(match[1]);
  }
  return specs;
}

function packageList() {
  if (!fs.existsSync(packagesDir)) return [];
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, "package.json")));
}

function collectGraph() {
  const graph = new Map();
  for (const name of packageList()) {
    const files = walkTsFiles(path.join(packagesDir, name, "src"));
    const deps = new Set();
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of extractImports(source)) {
        if (spec.startsWith("@freebuddy/")) {
          deps.add(spec.split("/").slice(0, 2).join("/"));
        }
      }
    }
    graph.set(`@freebuddy/${name}`, [...deps]);
  }
  return graph;
}

function collectSourceViolations(name, file, source) {
  const rule = RULES[name];
  assert.ok(rule, `missing boundary rule for package ${name}`);
  const violations = [];
  const rel = path.relative(rootDir, file);
  const packageRoot = path.join(packagesDir, name);

  for (const spec of extractImports(source)) {
    if (spec.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), spec);
      if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`)) {
        violations.push(`${rel} escapes its package with ${spec}`);
      }
    }
    if (spec.includes("/src/") && spec.startsWith("@freebuddy/")) {
      violations.push(`${rel} deep-imports ${spec}`);
    }
    if (spec.startsWith("@freebuddy/")) {
      const pkg = spec.split("/").slice(0, 2).join("/");
      if (pkg !== `@freebuddy/${name}` && !rule.allowPackages.includes(pkg)) {
        violations.push(`${rel} imports forbidden package ${pkg}`);
      }
    }
    for (const forbid of rule.forbid) {
      if (forbid.test(spec)) {
        violations.push(`${rel} imports forbidden specifier ${spec}`);
      }
    }
    if (/from\s+['"]electron['"]/.test(source) && name !== "storage-sqlite") {
      violations.push(`${rel} imports electron`);
    }
  }
  if (name !== "storage-sqlite") {
    if (/\bbetter-sqlite3\b/.test(source)) {
      violations.push(`${rel} references better-sqlite3`);
    }
    if (/\bgetDb\s*\(/.test(source)) {
      violations.push(`${rel} calls getDb(`);
    }
    if (/\bWebContents\b/.test(source) || /\bipcSend\b/.test(source)) {
      violations.push(`${rel} references Electron transport types`);
    }
  }
  if (name === "protocol" || name === "workflow-core" || name === "delegation-core") {
    if (/\bfrom\s+['"]node:fs['"]/.test(source) || /\bfrom\s+['"]fs['"]/.test(source)) {
      violations.push(`${rel} uses filesystem APIs`);
    }
  }
  return violations;
}

test("workspace packages obey dependency boundaries", () => {
  const names = packageList();
  const violations = [];

  for (const name of names) {
    const rule = RULES[name];
    assert.ok(rule, `missing boundary rule for package ${name}`);
    const files = walkTsFiles(path.join(packagesDir, name, "src"));
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      violations.push(...collectSourceViolations(name, file, source));
    }
  }

  assert.deepEqual(violations, []);
});

test("workspace packages have no dependency cycles", () => {
  const graph = collectGraph();
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function visit(node, stack) {
    if (visiting.has(node)) {
      cycles.push([...stack, node].join(" -> "));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dep of graph.get(node) ?? []) {
      visit(dep, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node, []);
  assert.deepEqual(cycles, []);
});

test("boundary fixture rejects electron import into a runtime package", () => {
  const file = path.join(packagesDir, "workflow-runtime", "src", "fixture.ts");
  const fixture = `import { app } from "electron";\nexport const leaked = app;\n`;
  assert.match(
    collectSourceViolations("workflow-runtime", file, fixture).join("\n"),
    /imports forbidden specifier electron/
  );
});

test("boundary fixture rejects a relative import that escapes a runtime package", () => {
  const file = path.join(packagesDir, "workflow-runtime", "src", "fixture.ts");
  const fixture = `import { app } from "../../../electron/main.js";\nexport const leaked = app;\n`;
  assert.match(
    collectSourceViolations("workflow-runtime", file, fixture).join("\n"),
    /escapes its package/
  );
});
