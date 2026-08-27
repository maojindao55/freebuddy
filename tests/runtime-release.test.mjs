import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isRuntimeTag,
  resolveRuntimePackVersion,
  runtimeChannelBaseUrl,
  runtimeAssetDownloadUrl,
  runtimeReleaseRepo,
  runtimeReleaseTag,
  versionFromRuntimeTag,
  decideImmutableAsset,
  decideReleaseMutation,
  createDeterministicZipBuffer,
  sha256Buffer
} from "../scripts/runtime-release-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("runtime pack version comes from env, then runtime-v tag", () => {
  assert.equal(resolveRuntimePackVersion({ RUNTIME_PACK_VERSION: "1.2.3" }), "1.2.3");
  assert.equal(resolveRuntimePackVersion({ RUNTIME_PACK_VERSION: "runtime-v9.8.7" }), "9.8.7");
  assert.equal(
    resolveRuntimePackVersion({
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "runtime-v2.0.1"
    }),
    "2.0.1"
  );
  assert.equal(resolveRuntimePackVersion({}), "0.0.0-dev");
  assert.equal(
    resolveRuntimePackVersion({
      CI: "true",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v0.9.0"
    }),
    "0.0.0-dev"
  );
  assert.equal(versionFromRuntimeTag("runtime-v1.0.1"), "1.0.1");
  assert.equal(versionFromRuntimeTag("v1.0.1"), null);
  assert.equal(isRuntimeTag("runtime-v1.0.1"), true);
  assert.equal(isRuntimeTag("runtime-vtest"), false);
  assert.equal(isRuntimeTag("v1.0.1"), false);
  assert.equal(runtimeReleaseTag("1.0.1"), "runtime-v1.0.1");
  assert.throws(
    () => resolveRuntimePackVersion({ RUNTIME_PACK_VERSION: "runtime-vtest" }),
    /invalid runtime release tag/
  );
  assert.throws(
    () =>
      resolveRuntimePackVersion({
        CI: "true",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "runtime-vtest"
      }),
    /invalid runtime release tag/
  );
  assert.throws(
    () =>
      resolveRuntimePackVersion({
        CI: "true",
        RUNTIME_REQUIRE_PRODUCTION_VERSION: "1",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.9.0"
      }),
    /invalid runtime release tag/
  );
});

test("runtime artifacts default to the dedicated freebuddy-runtime repository", () => {
  assert.equal(runtimeReleaseRepo({}), "maojindao55/freebuddy-runtime");
  assert.equal(runtimeReleaseRepo({ RUNTIME_RELEASE_REPO: "acme/runtime" }), "acme/runtime");
  assert.equal(
    runtimeChannelBaseUrl({}),
    "https://raw.githubusercontent.com/maojindao55/freebuddy-runtime/main/channels"
  );
});

test("published runtime assets are immutable", () => {
  const localSha256 = "a".repeat(64);
  assert.deepEqual(decideImmutableAsset({ existingAsset: null, localSha256 }), {
    action: "upload",
    localSha256
  });
  assert.equal(
    decideImmutableAsset({
      existingAsset: { name: "pack.zip", digest: `sha256:${localSha256}` },
      localSha256
    }).action,
    "reuse"
  );
  assert.equal(
    decideImmutableAsset({
      existingAsset: { name: "pack.zip", digest: `sha256:${"b".repeat(64)}` },
      localSha256
    }).action,
    "fail"
  );
  assert.equal(
    runtimeAssetDownloadUrl({
      url: "https://api.github.com/repos/acme/runtime/releases/assets/1",
      browser_download_url: "https://github.com/acme/runtime/releases/download/untagged/pack.zip"
    }),
    "https://api.github.com/repos/acme/runtime/releases/assets/1"
  );
  assert.equal(
    decideImmutableAsset({
      existingAsset: {
        id: 1,
        name: "pack.zip",
        url: "https://api.github.com/repos/acme/runtime/releases/assets/1",
        browser_download_url: "https://github.com/acme/runtime/releases/download/untagged/pack.zip"
      },
      localSha256
    }).url,
    "https://api.github.com/repos/acme/runtime/releases/assets/1"
  );
  assert.equal(
    decideReleaseMutation({ release: null, zipName: "pack.zip", localSha256 }).action,
    "create-draft"
  );
  assert.equal(
    decideReleaseMutation({
      release: { draft: false, tag_name: "runtime-v1.0.0", assets: [] },
      zipName: "pack.zip",
      localSha256
    }).action,
    "fail"
  );
  assert.equal(
    decideReleaseMutation({
      release: {
        id: 9,
        draft: true,
        assets: [{ name: "pack.zip", digest: `sha256:${localSha256}` }]
      },
      zipName: "pack.zip",
      localSha256
    }).action,
    "continue-draft"
  );
});

test("sign fails closed for tagged CI without a private key", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/sign-runtime-pack.mjs")], {
    env: {
      ...process.env,
      CI: "true",
      GITHUB_REF_NAME: "runtime-v1.0.1",
      RUNTIME_SIGNING_PRIVATE_KEY: ""
    },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /RUNTIME_SIGNING_PRIVATE_KEY/);
});

test("identical pack contents produce the same zip sha256 after a delay", async () => {
  const files = {
    "manifest.json": '{"version":"1.0.0"}',
    "runtime/index.mjs": "export {}\n"
  };
  const first = sha256Buffer(createDeterministicZipBuffer(files));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const second = sha256Buffer(createDeterministicZipBuffer(files));
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});
