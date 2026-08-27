import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decideImmutableAsset,
  decideReleaseMutation,
  normalizeSha256,
  runtimeAssetDownloadUrl,
  resolveRuntimePackVersion,
  runtimeReleaseRepo,
  runtimeReleaseTag
} from "./runtime-release-lib.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, ".build", "runtime-release");
const version = resolveRuntimePackVersion();
const tag = runtimeReleaseTag(version);
const repo = runtimeReleaseRepo();
const channel = process.env.RUNTIME_RELEASE_CHANNEL || "stable";
const token = process.env.FREEBUDDY_RUNTIME_RELEASE_TOKEN || process.env.GH_TOKEN;

if (repo === "maojindao55/freebuddy" && process.env.RUNTIME_ALLOW_DESKTOP_REPO !== "1") {
  throw new Error(
    "refusing to publish Runtime artifacts to the desktop repository; set RUNTIME_RELEASE_REPO=maojindao55/freebuddy-runtime"
  );
}

if (!token) {
  throw new Error(
    "FREEBUDDY_RUNTIME_RELEASE_TOKEN is required to publish to " +
      repo +
      ". Create a PAT with contents:write on that repository and add it as a GitHub Actions secret on maojindao55/freebuddy."
  );
}

const zipName = `freebuddy-runtime-${version}.zip`;
const zipPath = path.join(outDir, zipName);
const channelPath = path.join(outDir, `${channel}.json`);
const sigPath = path.join(outDir, `${channel}.json.sig`);
for (const file of [zipPath, channelPath, sigPath]) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing ${file}; run npm run runtime:package first`);
  }
}

const zipBytes = fs.readFileSync(zipPath);
const localSha256 = createHash("sha256").update(zipBytes).digest("hex");
const channelBytes = fs.readFileSync(channelPath);
const sigBytes = fs.readFileSync(sigPath);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "freebuddy-runtime-release"
};

async function github(method, urlPath, body, extraHeaders = {}) {
  const response = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      ...headers,
      ...extraHeaders,
      ...(body && extraHeaders["Content-Type"] ? {} : body ? { "Content-Type": "application/json" } : {})
    },
    body: body == null ? undefined : extraHeaders["Content-Type"] ? body : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const message = parsed?.message || text || `HTTP ${response.status}`;
    throw new Error(`${method} ${urlPath} failed: ${message}`);
  }
  return parsed;
}

async function githubOptional(method, urlPath) {
  const response = await fetch(`https://api.github.com${urlPath}`, { method, headers });
  if (response.status === 404) return null;
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${urlPath} failed: ${parsed?.message || text || response.status}`);
  }
  return parsed;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function downloadFollow(url, maxRedirects = 3) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const response = await fetch(current, {
      headers: {
        ...headers,
        Accept: "application/octet-stream"
      },
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) throw new Error("redirect without location");
      if (!next.startsWith("https://") && !next.startsWith("http://127.0.0.1")) {
        throw new Error("redirect rejected");
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${await response.text()}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("too many redirects");
}

const repoInfo = await github("GET", `/repos/${repo}`);
const branch = process.env.RUNTIME_CHANNEL_BRANCH || repoInfo.default_branch || "main";

async function putFile(filePath, content, message, { createOnly = false } = {}) {
  const existing = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    { headers }
  );
  let sha;
  if (existing.ok) {
    if (createOnly) return false;
    const body = await existing.json();
    sha = body.sha;
  } else if (existing.status !== 404) {
    throw new Error(`GET ${filePath} failed: ${existing.status}`);
  }
  const payload = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch
  };
  if (sha) payload.sha = sha;
  await github("PUT", `/repos/${repo}/contents/${filePath}`, payload);
  return true;
}

const readme = `# freebuddy-runtime

Signed FreeBuddy Runtime Pack artifacts. Desktop installers stay in [maojindao55/freebuddy](https://github.com/maojindao55/freebuddy/releases).

- Releases in this repository are Runtime zips, not desktop installers.
- Channel descriptors live in \`channels/stable.json\` (plus \`.sig\`).
- Do not npm-install these packages onto user machines.
`;

await putFile("README.md", readme, "docs: initialize runtime artifact repository", { createOnly: true });

let release = await githubOptional("GET", `/repos/${repo}/releases/tags/${tag}`);
const plan = decideReleaseMutation({ release, zipName, localSha256 });
if (plan.action === "fail") {
  throw new Error(plan.error);
}

if (plan.action === "create-draft") {
  release = await github("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    name: `Runtime ${version}`,
    body: `FreeBuddy Runtime Pack ${version}.\n\nThis is not a desktop installer.`,
    draft: true,
    prerelease: channel !== "stable",
    make_latest: "false"
  });
}

const zipAsset = (release.assets ?? []).find((asset) => asset.name === zipName);
const zipDecision = decideImmutableAsset({ existingAsset: zipAsset, localSha256 });
if (zipDecision.action === "fail") {
  throw new Error(zipDecision.error);
}

async function assertRemoteZipMatches(url) {
  const downloaded = await downloadFollow(url);
  const remoteSha = sha256Hex(downloaded);
  if (remoteSha !== localSha256) {
    throw new Error(`downloaded zip sha256 ${remoteSha} != local ${localSha256}`);
  }
  const { verifyRuntimePackFiles, sha256 } = await import("../packages/runtime-host/dist/runtimeVerifier.js");
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(downloaded);
  const files = {};
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    files[entry.entryName.replaceAll("\\", "/")] = entry.getData();
  }
  const pub =
    process.env.RUNTIME_SIGNING_PUBLIC_KEY ||
    (fs.existsSync(path.join(root, ".build", "runtime-keys", "current.pub"))
      ? fs.readFileSync(path.join(root, ".build", "runtime-keys", "current.pub"), "utf8")
      : fs.readFileSync(path.join(root, ".build", "runtime-keys", "runtime-dev.pub"), "utf8"));
  const verified = verifyRuntimePackFiles({
    files,
    publicKey: pub,
    expectedBundleId: "dev.freebuddy.runtime",
    hostApiVersion: "1.0.0",
    hostCapabilities: [
      "agent.execute.v1",
      "workflow.repository.v1",
      "delegation.repository.v1",
      "events.publish.v1"
    ]
  });
  if (!verified.ok) throw new Error(`downloaded pack failed inner verify: ${verified.error}`);
  if (sha256(downloaded) !== localSha256) {
    throw new Error("downloaded pack hash mismatch after inner verify");
  }
}

if (zipDecision.action === "upload") {
  const uploaded = await fetch(
    `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(zipName)}`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/zip",
        "Content-Length": String(zipBytes.byteLength)
      },
      body: zipBytes
    }
  );
  if (!uploaded.ok) {
    throw new Error(`upload ${zipName} failed: ${uploaded.status} ${await uploaded.text()}`);
  }
  const asset = await uploaded.json();
  await assertRemoteZipMatches(runtimeAssetDownloadUrl(asset));
} else if (zipDecision.action === "compare-bytes") {
  await assertRemoteZipMatches(zipDecision.url);
} else if (zipDecision.action === "reuse") {
  const url = runtimeAssetDownloadUrl(zipAsset);
  await assertRemoteZipMatches(url);
}

release = await github("GET", `/repos/${repo}/releases/${release.id}`);
if (release.draft) {
  await github("PATCH", `/repos/${repo}/releases/${release.id}`, {
    draft: false,
    prerelease: channel !== "stable",
    make_latest: channel === "stable" ? "true" : "false",
    name: `Runtime ${version}`,
    body: `FreeBuddy Runtime Pack ${version}.\n\nThis is not a desktop installer.`
  });
}

async function commitChannelFiles() {
  const ref = await github("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = ref.object.sha;
  const commit = await github("GET", `/repos/${repo}/git/commits/${commitSha}`);
  const jsonBlob = await github("POST", `/repos/${repo}/git/blobs`, {
    content: channelBytes.toString("utf8"),
    encoding: "utf-8"
  });
  const sigBlob = await github("POST", `/repos/${repo}/git/blobs`, {
    content: sigBytes.toString("base64"),
    encoding: "base64"
  });
  const tree = await github("POST", `/repos/${repo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: [
      {
        path: `channels/${channel}.json`,
        mode: "100644",
        type: "blob",
        sha: jsonBlob.sha
      },
      {
        path: `channels/${channel}.json.sig`,
        mode: "100644",
        type: "blob",
        sha: sigBlob.sha
      }
    ]
  });
  if (tree.sha === commit.tree.sha) {
    return false;
  }
  const created = await github("POST", `/repos/${repo}/git/commits`, {
    message: `chore: publish ${channel} ${tag}`,
    tree: tree.sha,
    parents: [commitSha]
  });
  await github("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: created.sha
  });
  return true;
}

await commitChannelFiles();

console.log(`published ${tag} to https://github.com/${repo}/releases/tag/${tag}`);
