// Test-only helper: registers an ESM resolve hook that redirects imports of
// the `electron` package to a minimal stub. The real `electron` package is
// CJS and exports only the binary path as its default export, so any
// `import { app } from "electron"` (e.g. from electron/cli/db.ts) throws a
// SyntaxError under Node's test runner. DB-layer tests inject an in-memory
// database via `setDbForTest`, so `getDb()` is never actually called and the
// stub's `app` only needs to exist, not to function.
//
// Usage (must be the first import in the test file):
//   import "./fixtures/electron-stub.mjs";
//
// Import order matters: ESM evaluates imports in source order, so this
// module's top-level register() call runs before any later dynamic
// import() of code that transitively imports `electron`.

import { register } from "node:module";

const electronStubUrl =
  "data:text/javascript," +
  encodeURIComponent(
    `export const app = {
       getPath: () => "/tmp/freebuddy-test",
       getLocale: () => "en-US"
     };`
  );

const hookModuleUrl =
  "data:text/javascript," +
  encodeURIComponent(
    `export function resolve(specifier, context, nextResolve) {
       if (specifier === "electron") {
         return { url: ${JSON.stringify(electronStubUrl)}, shortCircuit: true };
       }
       return nextResolve(specifier, context);
     }`
  );

register(hookModuleUrl, import.meta.url);
