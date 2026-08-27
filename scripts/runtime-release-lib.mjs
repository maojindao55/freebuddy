import { createHash } from "node:crypto";
import AdmZip from "adm-zip";

export const PRODUCTION_RUNTIME_TAG = /^runtime-v\d+\.\d+\.\d+$/;
export const PRODUCTION_RUNTIME_VERSION = /^\d+\.\d+\.\d+$/;
export const ZIP_ENTRY_TIME = new Date(1980, 0, 1, 0, 0, 0);

export function runtimeReleaseTag(version) {
  return `runtime-v${version}`;
}

export function isRuntimeTag(tag) {
  return PRODUCTION_RUNTIME_TAG.test(String(tag));
}

export function versionFromRuntimeTag(tag) {
  const match = String(tag ?? "").match(/^runtime-v(\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

function providedReleaseRefs(env) {
  return [env.RUNTIME_PACK_VERSION, env.GITHUB_REF_NAME, env.RUNTIME_RELEASE_TAG]
    .filter(Boolean)
    .map(String);
}

export function resolveRuntimePackVersion(env = process.env) {
  if (env.RUNTIME_PACK_VERSION && PRODUCTION_RUNTIME_VERSION.test(env.RUNTIME_PACK_VERSION)) {
    return env.RUNTIME_PACK_VERSION;
  }
  const version =
    versionFromRuntimeTag(env.RUNTIME_PACK_VERSION) ||
    versionFromRuntimeTag(env.GITHUB_REF_NAME) ||
    versionFromRuntimeTag(env.RUNTIME_RELEASE_TAG);
  if (version) return version;

  const provided = providedReleaseRefs(env);
  const invalidTag = provided.find((value) => value.startsWith("runtime-v"));
  // Desktop tags (vMAJOR.MINOR.PATCH) bundle a local 0.0.0-dev runtime pack.
  // Fail closed only for runtime-v* refs or an explicit production requirement.
  if (invalidTag || env.RUNTIME_REQUIRE_PRODUCTION_VERSION === "1") {
    throw new Error(
      `invalid runtime release tag ${invalidTag || provided[0] || "(empty)"}; expected runtime-vMAJOR.MINOR.PATCH`
    );
  }
  return "0.0.0-dev";
}

export function createDeterministicZipBuffer(files) {
  const zip = new AdmZip();
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const data = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name]);
    const entry = zip.addFile(name, data);
    if (entry?.header) {
      entry.header.time = ZIP_ENTRY_TIME;
      entry.header.made = 0x0314;
    }
  }
  return zip.toBuffer();
}

export function sha256Buffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function runtimeReleaseRepo(env = process.env) {
  return env.RUNTIME_RELEASE_REPO || "maojindao55/freebuddy-runtime";
}

export function runtimeChannelBaseUrl(env = process.env) {
  const repo = runtimeReleaseRepo(env);
  const branch = env.RUNTIME_CHANNEL_BRANCH || "main";
  return `https://raw.githubusercontent.com/${repo}/${branch}/channels`;
}

export function normalizeSha256(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

export function assetSha256(asset) {
  if (!asset) return null;
  return normalizeSha256(asset.digest) || normalizeSha256(asset.sha256) || null;
}

export function runtimeAssetDownloadUrl(asset) {
  if (!asset) return null;
  // The browser URL of an asset attached to a draft release returns 404 even
  // with authentication. The API asset URL supports authenticated downloads
  // for both draft and published releases.
  return asset.url || asset.browser_download_url || null;
}

/**
 * Immutable release assets: reuse when the digest matches, fail when it differs,
 * upload only when the named asset is absent.
 */
export function decideImmutableAsset({ existingAsset, localSha256 }) {
  const local = normalizeSha256(localSha256);
  if (!local) {
    return { action: "fail", error: "local zip sha256 missing" };
  }
  if (!existingAsset) {
    return { action: "upload", localSha256: local };
  }
  const remote = assetSha256(existingAsset);
  if (remote && remote === local) {
    return { action: "reuse", localSha256: local, assetId: existingAsset.id };
  }
  if (!remote) {
    return {
      action: "compare-bytes",
      localSha256: local,
      assetId: existingAsset.id,
      url: runtimeAssetDownloadUrl(existingAsset)
    };
  }
  return {
    action: "fail",
    error: `refusing to overwrite ${existingAsset.name}: existing sha256 ${remote} != ${local}`
  };
}

export function decideReleaseMutation({ release, zipName, localSha256 }) {
  if (!release) {
    return { action: "create-draft" };
  }
  const zipAsset = (release.assets ?? []).find((asset) => asset.name === zipName);
  const assetDecision = decideImmutableAsset({ existingAsset: zipAsset, localSha256 });
  if (assetDecision.action === "fail") {
    return { action: "fail", error: assetDecision.error };
  }
  if (release.draft) {
    return {
      action: "continue-draft",
      releaseId: release.id,
      zip: assetDecision
    };
  }
  if (assetDecision.action === "upload") {
    return {
      action: "fail",
      error: `published ${release.tag_name} is missing ${zipName}; refusing to mutate a published release`
    };
  }
  return {
    action: "idempotent",
    releaseId: release.id,
    zip: assetDecision
  };
}
