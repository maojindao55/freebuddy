import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";

const read = (relativePath) =>
  fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");

function makeDemoZip() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillhub-pkg-"));
  const zipPath = path.join(root, "demo.zip");
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from("---\nname: demo\ndescription: Demo\n---\n"));
  zip.addFile("README.md", Buffer.from("# Demo\n"));
  zip.addFile("scripts/run.sh", Buffer.from("echo ok\n"));
  zip.writeZip(zipPath);
  return { root, zipPath };
}

test("skill market modules and IPC surface are wired", () => {
  const market = read("../electron/cli/skillMarket.ts");
  const skillhub = read("../electron/cli/skillMarketProviders/skillhub.ts");
  const clawhub = read("../electron/cli/skillMarketProviders/clawhub.ts");
  const http = read("../electron/cli/skillMarketHttp.ts");
  const skills = read("../electron/cli/skills.ts");
  const db = read("../electron/cli/db.ts");
  const ipc = read("../electron/cli/ipc.ts");
  const preload = read("../electron/preload.ts");
  const ui = read("../src/components/Settings/SkillsTab.tsx");
  const panel = read("../src/components/Settings/SkillMarketPanel.tsx");
  const store = read("../src/store/skillMarketStore.ts");

  const types = read("../electron/cli/skillTypes.ts");
  assert.match(market, /installSkillFromMarket/);
  assert.match(types, /MARKET_CONFIRMATION_REQUIRED/);
  assert.match(market, /MARKET_CONFIRMATION_PREFIX/);
  assert.match(skillhub, /computeSkillhubContentHash/);
  assert.match(skillhub, /cos\.accelerate\.myqcloud\.com/);
  assert.match(skillhub, /searchParams\.set\("version"/);
  assert.match(skillhub, /signed === false/);
  assert.match(skillhub, /signed !== true/);
  assert.match(clawhub, /skills\/\$\{encodeURIComponent\(args\.slug\)\}\/scan/);
  assert.match(clawhub, /scanStatusFromClawhubScan/);
  assert.match(clawhub, /matchesRequestedVersion/);
  assert.match(clawhub, /moderationAppliesToRequestedVersion/);
  assert.match(clawhub, /resolveClawhubIdentity/);
  assert.match(clawhub, /parseClawhubGithubHandoff/);
  assert.match(clawhub, /computeClawhubContentHash/);
  assert.match(clawhub, /createClawhubIgnoreMatcher|\.clawhubignore/);
  assert.match(clawhub, /api\.github\.com/);
  assert.match(clawhub, /DO_NOT_INSTALL|do_not_install/);
  assert.match(market, /extractGitHubZipSkillPath/);
  assert.match(market, /assertClawhubContentHash/);
  assert.match(market, /assertClawhubFileManifest/);
  assert.match(market, /contentBound/);
  // GitHub handoffs only bind the text fingerprint, so they never auto-trust.
  assert.match(market, /stay untrusted regardless of scan verdict/);
  // List/search cards must not claim a verified clean scan they never fetched.
  assert.match(clawhub, /scanStatus: "unknown"/);
  // Generated _meta.json is stripped before manifest verification.
  assert.match(market, /Drop the packaging-generated _meta.json/);
  assert.match(market, /resolveSkillMarketHomepage/);
  assert.match(market, /allowLocalOverwrite/);
  assert.match(market, /parseMarketInstallRequest/);
  assert.match(types, /parseMarketInstallRequest/);
  assert.match(clawhub, /assertClawhubFileManifest/);
  assert.match(clawhub, /fetchClawhubVersionFileManifest/);
  assert.match(clawhub, /clawhubHomepageUrl/);
  assert.match(ipc, /skills:resolveMarketHomepage/);
  assert.match(preload, /skills:resolveMarketHomepage/);
  assert.match(panel, /ownerQualifiedId/);
  assert.match(store, /rowKey\(item\) !== key/);
  assert.match(http, /Blocked market host/);
  assert.match(http, /withMarketRequestTimeout/);
  assert.match(http, /readMarketResponseText/);
  assert.match(http, /MAX_MARKET_JSON_BYTES/);
  assert.match(http, /await sleep\(wait, activeSignal\)/);
  assert.match(http, /signal\?\.addEventListener\("abort"/);
  assert.match(clawhub, /withMarketRequestTimeout\(60_000/);
  assert.match(clawhub, /readMarketResponseJson/);
  assert.match(clawhub, /readMarketResponseText/);
  assert.match(skills, /nextSkillEnabledFlag/);
  assert.match(skills, /nextSkillEnabledFlag\(previous\?\.enabled, \{ trusted \}\)/);
  assert.match(skills, /setSkillTrusted/);
  assert.match(skills, /getSkillByMarketIdentity/);
  assert.match(market, /attachPersistedClawhubIdentities/);
  assert.match(clawhub, /Ambiguous ClawHub slug/);
  assert.doesNotMatch(clawhub, /highest-download exact slug match/);
  assert.match(skills, /findExistingSkillForInstall/);
  assert.match(skills, /hasLocalSkillDrift/);
  assert.match(skills, /assertDestinationReadyForInstall/);
  assert.match(skills, /migrateSkillIdReferences/);
  assert.match(skills, /rewriteSkillIdListJson/);
  assert.match(skills, /previousMovedToBackup/);
  assert.match(skills, /databaseCommitted/);
  assert.match(skills, /shouldRollbackSkillInstallFiles/);
  assert.match(skills, /removePathBestEffort/);
  assert.match(skills, /\.delete-\$\{crypto\.randomUUID\(\)\}/);
  assert.match(skills, /Never delete a leftover pre-commit backup here/);
  assert.match(skills, /Load the row inside the transaction/);
  assert.match(skills, /return rowToSkill\(row\);/);
  assert.doesNotMatch(skills, /write\(\);\s*return getSkill/);
  assert.match(db, /market_provider/);
  assert.match(ipc, /skills:installFromMarket/);
  assert.match(ipc, /skills:setTrusted/);
  assert.match(preload, /skills:installFromMarket/);
  assert.match(preload, /setTrusted/);
  assert.match(ui, /SkillMarketPanel/);
  assert.match(panel, /showRefresh/);
  assert.match(panel, /localDriftConfirm/);
  assert.match(panel, /skill-untrusted-badge|skills\.untrusted/);
  assert.match(store, /searchSeq/);
  assert.match(store, /allowLocalOverwrite/);
  assert.match(store, /message\.indexOf\(marker\)/);
  assert.match(read("../src/store/skillStore.ts"), /setTrusted/);
  assert.match(types, /parseMarketConfirmationError/);
  assert.match(types, /SkillHub marketSkillId must equal slug/);
  assert.match(market, /attachPersistedClawhubIdentities/);
  assert.match(clawhub, /attachPersistedClawhubIdentitiesToItems/);
  assert.match(types, /message\.indexOf\(marker\)/);
  assert.match(clawhub, /clawhubHomepageUrl/);
  assert.doesNotMatch(clawhub, /clawhub\.ai\/skills\/\$\{/);
});

test("skill market locales expose installed and market copy", () => {
  const zh = JSON.parse(read("../src/locales/zh-CN.json"));
  const en = JSON.parse(read("../src/locales/en.json"));
  assert.equal(zh.skills.marketView, "技能市场");
  assert.equal(zh.skills.market.unsignedConfirm.includes("尚未签名"), true);
  assert.match(zh.skills.market.localDriftConfirm, /本地文件已被修改/);
  assert.equal(zh.skills.untrusted, "未验证");
  assert.match(zh.skills.trustConfirm, /标记为可信/);
  assert.equal(en.skills.marketView, "Skill Market");
  assert.match(en.skills.market.reinstallHint, /Reinstall/i);
  assert.match(en.skills.market.localDriftConfirm, /local file changes/i);
  assert.equal(en.skills.untrusted, "Unverified");
});

test("existing skills keep enabled=false across seed/upsert helper", async () => {
  const { nextSkillEnabledFlag } = await import("../dist-electron/cli/skillEnabled.js");
  assert.equal(nextSkillEnabledFlag(undefined), 1);
  assert.equal(nextSkillEnabledFlag(undefined, { trusted: true }), 1);
  assert.equal(nextSkillEnabledFlag(undefined, { trusted: false }), 0);
  assert.equal(nextSkillEnabledFlag(true), 1);
  assert.equal(nextSkillEnabledFlag(true, { trusted: false }), 1);
  assert.equal(nextSkillEnabledFlag(false), 0);
  const skills = read("../electron/cli/skills.ts");
  assert.match(skills, /nextSkillEnabledFlag\(previous\?\.enabled, \{ trusted \}\)/);
  assert.match(skills, /setSkillTrusted/);
  assert.doesNotMatch(skills, /preserveEnabled && existing/);
});

test("SkillHub content hash matches official fingerprint rules", async () => {
  const { computeSkillhubContentHash } = await import(
    "../dist-electron/cli/skillMarketProviders/skillhub.js"
  );
  const { root, zipPath } = makeDemoZip();
  const entries = [
    ["README.md", Buffer.from("# Demo\n")],
    ["SKILL.md", Buffer.from("---\nname: demo\ndescription: Demo\n---\n")],
    ["scripts/run.sh", Buffer.from("echo ok\n")]
  ];
  const joined = entries
    .map(([rel, buf]) => `${rel}:${crypto.createHash("sha256").update(buf).digest("hex")}\n`)
    .join("");
  const expected = crypto.createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex");
  assert.equal(computeSkillhubContentHash(zipPath).contentHash, expected);
  assert.equal(computeSkillhubContentHash(zipPath).fileCount, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("SkillHub download whitelist includes accelerate CDN redirect host", async () => {
  const { SKILLHUB_DOWNLOAD_HOSTS } = await import(
    "../dist-electron/cli/skillMarketProviders/skillhub.js"
  );
  assert.equal(
    SKILLHUB_DOWNLOAD_HOSTS.has("skillhub-1388575217.cos.accelerate.myqcloud.com"),
    true
  );
  assert.equal(
    SKILLHUB_DOWNLOAD_HOSTS.has("skillhub-1388575217.cos.ap-guangzhou.myqcloud.com"),
    true
  );
});

test("SkillHub verify fails closed for incomplete signed payloads", async () => {
  const { computeSkillhubContentHash, verifySkillhubPackage } = await import(
    "../dist-electron/cli/skillMarketProviders/skillhub.js"
  );
  const { root, zipPath } = makeDemoZip();
  const local = computeSkillhubContentHash(zipPath);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/signature")) {
      return new Response(
        JSON.stringify({
          signed: true,
          key_id: "skillhub-platform-v1",
          signature: "AAAA",
          content_hash: local.contentHash,
          package_md5: "deadbeef",
          payload: JSON.stringify({
            skill_slug: "demo",
            skill_version: "1.0.0",
            content_hash: local.contentHash
            // intentionally omit package_md5 and file_count
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await assert.rejects(
      () => verifySkillhubPackage({ slug: "demo", version: "1.0.0", zipPath }),
      /missing file_count|missing package_md5/
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SkillHub verify rejects missing signed flag instead of treating as unsigned", async () => {
  const { verifySkillhubPackage } = await import(
    "../dist-electron/cli/skillMarketProviders/skillhub.js"
  );
  const { root, zipPath } = makeDemoZip();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        content_hash: "abc",
        payload: "{}",
        signature: "AAAA",
        key_id: "skillhub-platform-v1"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  try {
    await assert.rejects(
      () => verifySkillhubPackage({ slug: "demo", version: "1.0.0", zipPath }),
      /missing a valid signed flag/
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ClawHub nested scanner verdicts override top-level clean", async () => {
  const { scanStatusFromClawhubScan } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: null,
      security: { status: "clean", hasScanResult: true }
    }),
    "clean"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: null,
      security: {
        status: "clean",
        hasWarnings: true,
        hasScanResult: true,
        scanners: {
          vt: { status: "clean" },
          skillspector: {
            status: "suspicious",
            severity: "CRITICAL",
            recommendation: "DO_NOT_INSTALL"
          }
        }
      }
    }),
    "malware"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: null,
      security: {
        status: "clean",
        hasWarnings: true,
        hasScanResult: true,
        scanners: {
          skillspector: {
            status: "suspicious",
            severity: "MEDIUM",
            recommendation: "CAUTION"
          }
        }
      }
    }),
    "suspicious"
  );
  // Real ClawHub payload shape: top-level clean + advisory hasWarnings + benign verdict.
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: {
        matchesRequestedVersion: true,
        sourceVersion: "1.0.0",
        verdict: "clean",
        isSuspicious: false,
        isMalwareBlocked: false
      },
      security: {
        status: "clean",
        hasWarnings: true,
        hasScanResult: true,
        verdict: "benign",
        normalizedStatus: "clean",
        scanners: {
          vt: { status: "clean", verdict: "benign" },
          skillspector: {
            status: "complete",
            verdict: "benign",
            normalizedStatus: "clean"
          }
        }
      }
    }),
    "clean"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: null,
      security: {
        status: "complete",
        hasScanResult: true,
        scanners: {
          skillspector: {
            status: "complete",
            verdict: "malware"
          }
        }
      }
    }),
    "malware"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: {
        matchesRequestedVersion: true,
        sourceVersion: "1.2.3",
        verdict: "malware"
      },
      security: { status: "clean", hasScanResult: true }
    }),
    "malware"
  );
  assert.equal(
    scanStatusFromClawhubScan({
      moderation: null,
      security: { status: "clean", hasScanResult: false }
    }),
    "unscanned"
  );
  // Historical version: latest moderation is clean, but must not apply.
  assert.equal(
    scanStatusFromClawhubScan(
      {
        moderation: {
          matchesRequestedVersion: false,
          sourceVersion: "2.0.0",
          verdict: "clean",
          isSuspicious: false,
          isMalwareBlocked: false
        },
        security: null
      },
      "1.0.0"
    ),
    "unscanned"
  );
  assert.equal(
    scanStatusFromClawhubScan(
      {
        moderation: {
          matchesRequestedVersion: false,
          sourceVersion: "2.0.0",
          verdict: "clean"
        },
        security: { hasScanResult: false }
      },
      "1.0.0"
    ),
    "unscanned"
  );
  // Same-version moderation still applies when the flag is true.
  assert.equal(
    scanStatusFromClawhubScan(
      {
        moderation: {
          matchesRequestedVersion: true,
          sourceVersion: "1.0.0",
          verdict: "clean"
        },
        security: null
      },
      "1.0.0"
    ),
    "clean"
  );
});

test("ClawHub identity resolution does not splice list version onto wrong owner", async () => {
  const { resolveClawhubIdentity, searchClawhub } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/v1/search?")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              slug: "self-improving-agent",
              displayName: "self-improving agent",
              downloads: 278,
              ownerHandle: "kingaiwork"
            },
            {
              slug: "self-improving-agent",
              displayName: "self-improving agent",
              downloads: 468436,
              ownerHandle: "pskoett"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/v1/skills/self-improving-agent?ownerHandle=pskoett")) {
      return new Response(
        JSON.stringify({
          skill: { slug: "self-improving-agent", tags: { latest: "4.0.1" } },
          latestVersion: { version: "4.0.1" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/v1/skills/self-improving-agent?ownerHandle=kingaiwork")) {
      return new Response(
        JSON.stringify({
          skill: { slug: "self-improving-agent", tags: { latest: "1.0.1" } },
          latestVersion: { version: "1.0.1" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/api/v1/skills?") && url.includes("sort=downloads")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              slug: "self-improving-agent",
              displayName: "self-improving agent",
              summary: "learning",
              tags: { latest: "4.0.1" },
              stats: { downloads: 468436, stars: 3932 },
              latestVersion: { version: "4.0.1" }
            }
          ],
          nextCursor: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const identity = await resolveClawhubIdentity({
      slug: "self-improving-agent",
      version: "4.0.1",
      downloadsHint: 468436
    });
    assert.equal(identity.ownerHandle, "pskoett");
    assert.equal(identity.version, "4.0.1");

    // Unique latest-version match still resolves without downloadsHint.
    const byVersion = await resolveClawhubIdentity({
      slug: "self-improving-agent",
      version: "4.0.1"
    });
    assert.equal(byVersion.ownerHandle, "pskoett");

    // Multiple publishers and no disambiguator must not guess by download rank.
    await assert.rejects(
      () => resolveClawhubIdentity({ slug: "self-improving-agent" }),
      /Ambiguous ClawHub slug/
    );

    // Browse/list must not N+1 resolve owners; install uses resolveClawhubIdentity.
    const listed = await searchClawhub({ limit: 1 });
    assert.equal(listed.items[0]?.ownerHandle, undefined);
    assert.equal(listed.items[0]?.version, "4.0.1");
    assert.equal(listed.items[0]?.marketSkillId, "self-improving-agent");
    assert.equal(listed.items[0]?.downloads, 468436);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persisted ClawHub installs reattach owner identity on owner-less list cards", async () => {
  const { attachPersistedClawhubIdentitiesToItems } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );
  const card = {
    provider: "clawhub.ai",
    marketSkillId: "self-improving-agent",
    slug: "self-improving-agent",
    name: "self-improving agent",
    description: "learning",
    version: "4.0.1",
    author: "unknown",
    downloads: 468436,
    stars: 3932,
    homepageUrl: "",
    scanStatus: "clean"
  };
  const enriched = attachPersistedClawhubIdentitiesToItems([card], [
    {
      marketSlug: "self-improving-agent",
      marketSkillId: "pskoett/self-improving-agent"
    }
  ]);
  assert.equal(enriched[0]?.ownerHandle, "pskoett");
  assert.equal(enriched[0]?.marketSkillId, "pskoett/self-improving-agent");
  assert.equal(
    enriched[0]?.homepageUrl,
    "https://clawhub.ai/pskoett/skills/self-improving-agent"
  );

  const ambiguous = attachPersistedClawhubIdentitiesToItems([card], [
    {
      marketSlug: "self-improving-agent",
      marketSkillId: "pskoett/self-improving-agent"
    },
    {
      marketSlug: "self-improving-agent",
      marketSkillId: "kingaiwork/self-improving-agent"
    }
  ]);
  assert.equal(ambiguous[0]?.ownerHandle, undefined);
  assert.equal(ambiguous[0]?.marketSkillId, "self-improving-agent");
});

test("skill market adapters normalize provider-specific payloads", async () => {
  const { searchSkillhub } = await import(
    "../dist-electron/cli/skillMarketProviders/skillhub.js"
  );
  const { searchClawhub } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("api.skillhub.cn/api/skills")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            total: 1,
            skills: [
              {
                slug: "summarize",
                name: "Summarize",
                description_zh: "总结网页与文件",
                version: "1.0.0",
                ownerName: "paudyyin",
                installs: 46000,
                stars: 990,
                homepage: "https://skillhub.cn/skills/summarize"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("clawhub.ai/api/v1/search")) {
      const query = new URL(url).searchParams.get("q") || "";
      if (query.includes("agent-browser")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                slug: "agent-browser",
                displayName: "Agent Browser",
                downloads: 36400,
                ownerHandle: "rez0"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              slug: "summarize",
              displayName: "Summarize",
              summary: "Summarize URLs",
              version: null,
              downloads: 1484,
              ownerHandle: "paudyyin"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("clawhub.ai/api/v1/skills/agent-browser")) {
      return new Response(
        JSON.stringify({
          skill: { slug: "agent-browser", tags: { latest: "0.1.0" } },
          latestVersion: { version: "0.1.0" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("clawhub.ai/api/v1/skills/summarize")) {
      return new Response(
        JSON.stringify({
          skill: { slug: "summarize", tags: { latest: "1.2.3" } },
          latestVersion: { version: "1.2.3" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("clawhub.ai/api/v1/skills?")) {
      return new Response(
        JSON.stringify({
          items: [
            {
              slug: "agent-browser",
              displayName: "Agent Browser",
              summary: "Browser automation",
              tags: { latest: "0.1.0" },
              stats: { downloads: 36400, stars: 901 }
            }
          ],
          nextCursor: "cursor-1"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const skillhub = await searchSkillhub({ query: "summarize", limit: 10 });
    assert.equal(skillhub.items[0]?.provider, "skillhub.cn");
    assert.equal(skillhub.items[0]?.slug, "summarize");
    assert.equal(skillhub.items[0]?.downloads, 46000);

    const clawSearch = await searchClawhub({ query: "summarize", limit: 10 });
    assert.equal(clawSearch.items[0]?.provider, "clawhub.ai");
    assert.equal(clawSearch.items[0]?.ownerHandle, "paudyyin");
    assert.equal(clawSearch.items[0]?.marketSkillId, "paudyyin/summarize");
    assert.equal(clawSearch.items[0]?.version, "1.2.3");

    const clawList = await searchClawhub({ limit: 10 });
    assert.equal(clawList.items[0]?.slug, "agent-browser");
    assert.equal(clawList.items[0]?.ownerHandle, undefined);
    assert.equal(clawList.items[0]?.marketSkillId, "agent-browser");
    assert.equal(clawList.nextCursor, "cursor-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ClawHub default list issues a single skills request", async () => {
  const { searchClawhub } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/v1/skills?") && url.includes("sort=downloads")) {
      return new Response(
        JSON.stringify({
          items: Array.from({ length: 30 }, (_, index) => ({
            slug: `skill-${index}`,
            displayName: `Skill ${index}`,
            summary: "demo",
            tags: { latest: "1.0.0" },
            stats: { downloads: 1000 - index, stars: 10 },
            latestVersion: { version: "1.0.0" }
          })),
          nextCursor: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const listed = await searchClawhub({ limit: 30 });
    assert.equal(listed.items.length, 30);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/api\/v1\/skills\?/);
    assert.equal(
      urls.some((url) => url.includes("/api/v1/search?")),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market UI keeps refresh for installed skills and search store is race-safe", async () => {
  const storeSource = read("../src/store/skillMarketStore.ts");
  const panel = read("../src/components/Settings/SkillMarketPanel.tsx");
  assert.match(storeSource, /searchSeq/);
  assert.match(storeSource, /current\.searchSeq !== seq/);
  assert.match(storeSource, /resolveMarketHomepage/);
  assert.match(storeSource, /Only rewrite the clicked row/);
  assert.match(panel, /showRefresh/);
  assert.match(panel, /sameMarket/);
  assert.match(panel, /ownerQualifiedId/);
  assert.doesNotMatch(panel, /installedBySlug/);
  assert.match(panel, /local-drift/);
});

test("ClawHub file manifest binds hosted ZIP contents", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const { assertClawhubFileManifest, clawhubHomepageUrl } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );

  assert.equal(clawhubHomepageUrl("summarize"), "");
  assert.equal(
    clawhubHomepageUrl("summarize", "paudyyin"),
    "https://clawhub.ai/paudyyin/skills/summarize"
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-manifest-"));
  const skillMd = "---\nname: demo\ndescription: Demo\n---\n# Demo\n";
  const helper = "print('ok')\n";
  fs.writeFileSync(path.join(root, "SKILL.md"), skillMd);
  fs.writeFileSync(path.join(root, "helper.py"), helper);

  const files = [
    {
      path: "SKILL.md",
      sha256: crypto.createHash("sha256").update(skillMd).digest("hex")
    },
    {
      path: "helper.py",
      sha256: crypto.createHash("sha256").update(helper).digest("hex")
    }
  ];
  const digest = assertClawhubFileManifest(root, files);
  assert.match(digest, /^[0-9a-f]{64}$/);

  // _meta.json is no longer whitelisted: an unmanifested file is always rejected.
  fs.writeFileSync(path.join(root, "_meta.json"), JSON.stringify({ slug: "demo" }));
  assert.throws(() => assertClawhubFileManifest(root, files), /unexpected file/);
  fs.rmSync(path.join(root, "_meta.json"), { force: true });

  fs.writeFileSync(path.join(root, "helper.py"), "print('tampered')\n");
  assert.throws(() => assertClawhubFileManifest(root, files), /hash mismatch/);

  fs.writeFileSync(path.join(root, "helper.py"), helper);
  fs.writeFileSync(path.join(root, "extra.txt"), "nope");
  assert.throws(() => assertClawhubFileManifest(root, files), /unexpected file/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("ClawHub install trust requires content binding for hosted ZIP", () => {
  const market = read("../electron/cli/skillMarket.ts");
  assert.match(market, /contentBound/);
  assert.match(
    market,
    /trusted = clawhubScanStatus === "clean" && contentBound/
  );
  assert.doesNotMatch(
    market,
    /trusted =\s*\([\s\S]*allowSuspicious/
  );
  assert.match(market, /assertClawhubFileManifest/);
  assert.match(market, /missing a file integrity manifest/);
  assert.match(market, /unsigned packages stay untrusted/);
});

test("market install IPC rejects non-boolean confirmation flags", async () => {
  const { parseMarketInstallRequest } = await import(
    "../dist-electron/cli/skillTypes.js"
  );
  const valid = parseMarketInstallRequest({
    provider: "clawhub.ai",
    marketSkillId: "owner/demo",
    slug: "demo",
    ownerHandle: "owner",
    version: "1.0.0",
    allowSuspicious: true,
    allowLocalOverwrite: false
  });
  assert.equal(valid.allowSuspicious, true);
  assert.equal(valid.allowLocalOverwrite, false);

  assert.throws(
    () =>
      parseMarketInstallRequest({
        provider: "clawhub.ai",
        marketSkillId: "owner/demo",
        slug: "demo",
        allowSuspicious: "false"
      }),
    /Invalid market install request/
  );
  assert.throws(
    () =>
      parseMarketInstallRequest({
        provider: "clawhub.ai",
        marketSkillId: "owner/demo",
        slug: "demo",
        allowLocalOverwrite: "false"
      }),
    /Invalid market install request/
  );
  assert.throws(
    () =>
      parseMarketInstallRequest({
        provider: "clawhub.ai",
        marketSkillId: "owner/demo",
        slug: "demo",
        downloadsHint: "100"
      }),
    /Invalid market install request/
  );
  assert.throws(
    () =>
      parseMarketInstallRequest({
        provider: "skillhub.cn",
        marketSkillId: "other-id",
        slug: "demo"
      }),
    /marketSkillId must equal slug/
  );
  assert.throws(
    () =>
      parseMarketInstallRequest({
        provider: "clawhub.ai",
        marketSkillId: "alice/demo",
        slug: "demo",
        ownerHandle: "bob"
      }),
    /ownerHandle must match marketSkillId/
  );
});

test("ClawHub trust formula ignores allowSuspicious for suspicious and unbound packages", async () => {
  const market = read("../electron/cli/skillMarket.ts");
  // allowSuspicious may gate confirmation, but must not grant trusted.
  assert.match(market, /requiresConfirmation\(result\.scanStatus\) && !request\.allowSuspicious/);
  assert.match(market, /trusted = clawhubScanStatus === "clean" && contentBound/);
  assert.match(market, /missing a file integrity manifest/);
});

test("market confirmation parser accepts Electron-wrapped IPC errors", async () => {
  const { parseMarketConfirmationError } = await import(
    "../dist-electron/cli/skillTypes.js"
  );
  const store = read("../src/store/skillMarketStore.ts");
  assert.match(store, /message\.indexOf\(marker\)/);
  assert.match(store, /Error invoking remote method/);

  const wrapped =
    "Error invoking remote method 'skills:installFromMarket': Error: MARKET_CONFIRMATION_REQUIRED:unscanned:Confirm to continue.";
  const parsed = parseMarketConfirmationError(wrapped);
  assert.equal(parsed?.reason, "unscanned");
  assert.match(parsed?.detail ?? "", /Confirm to continue/);
  assert.equal(
    parseMarketConfirmationError(
      "Error invoking remote method 'skills:installFromMarket': Error: MARKET_CONFIRMATION_REQUIRED:local-drift:Local changes"
    )?.reason,
    "local-drift"
  );
  assert.equal(
    parseMarketConfirmationError(
      "Error invoking remote method 'skills:installFromMarket': Error: MARKET_CONFIRMATION_REQUIRED:unsigned:Unsigned package"
    )?.reason,
    "unsigned"
  );
  assert.equal(parseMarketConfirmationError("plain failure without marker"), undefined);
});

test("ClawHub content hash applies gitignore and clawhub ignore negation rules", async () => {
  const { computeClawhubContentHash } = await import(
    "../dist-electron/cli/skillMarketProviders/clawhub.js"
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-hash-"));
  try {
    fs.writeFileSync(
      path.join(root, "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n# Demo\n"
    );
    fs.writeFileSync(path.join(root, "tracked.md"), "# tracked\n");
    fs.writeFileSync(path.join(root, "ignored.txt"), "should be ignored\n");
    fs.mkdirSync(path.join(root, "temp"), { recursive: true });
    fs.writeFileSync(path.join(root, "temp", "gone.md"), "gone\n");
    fs.writeFileSync(path.join(root, "temp", "keep.md"), "keep\n");
    fs.writeFileSync(
      path.join(root, ".gitignore"),
      ["ignored.txt", "temp/*", "!temp/keep.md", ""].join("\n")
    );
    fs.writeFileSync(path.join(root, ".clawhubignore"), "extra.md\n");
    fs.writeFileSync(path.join(root, "extra.md"), "extra\n");

    const withIgnores = computeClawhubContentHash(root);

    // Mutating ignored files must not change the fingerprint.
    fs.writeFileSync(path.join(root, "ignored.txt"), "changed ignored\n");
    fs.writeFileSync(path.join(root, "temp", "gone.md"), "changed gone\n");
    fs.writeFileSync(path.join(root, "extra.md"), "changed extra\n");
    assert.equal(computeClawhubContentHash(root), withIgnores);

    // Negated keep.md and tracked files still affect the hash.
    fs.writeFileSync(path.join(root, "temp", "keep.md"), "keep changed\n");
    assert.notEqual(computeClawhubContentHash(root), withIgnores);

    // Fixed fixture: same tree without ignore files includes ignored paths and differs.
    const noIgnoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-hash-raw-"));
    try {
      fs.writeFileSync(
        path.join(noIgnoreRoot, "SKILL.md"),
        "---\nname: demo\ndescription: Demo\n---\n# Demo\n"
      );
      fs.writeFileSync(path.join(noIgnoreRoot, "tracked.md"), "# tracked\n");
      fs.writeFileSync(path.join(noIgnoreRoot, "ignored.txt"), "should be ignored\n");
      fs.mkdirSync(path.join(noIgnoreRoot, "temp"), { recursive: true });
      fs.writeFileSync(path.join(noIgnoreRoot, "temp", "gone.md"), "gone\n");
      fs.writeFileSync(path.join(noIgnoreRoot, "temp", "keep.md"), "keep\n");
      fs.writeFileSync(path.join(noIgnoreRoot, "extra.md"), "extra\n");
      assert.notEqual(computeClawhubContentHash(noIgnoreRoot), withIgnores);
    } finally {
      fs.rmSync(noIgnoreRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("market install resolves identity by market id and detects local drift", async () => {
  const {
    assertDestinationReadyForInstall,
    findExistingSkillForInstall,
    hasLocalSkillDrift,
    rewriteSkillIdListJson,
    rewriteWorkflowRolesSkillIdsJson
  } = await import("../dist-electron/cli/skillInstallResolve.js");

  const installed = {
    id: "old-name",
    name: "old-name",
    description: "old",
    version: "1.0.0",
    source: "market",
    rootPath: "/skills/old-name",
    contentHash: "aaa",
    enabled: true,
    trusted: true,
    createdAt: "t0",
    updatedAt: "t0",
    marketProvider: "clawhub.ai",
    marketSkillId: "owner/demo"
  };

  const byMarket = findExistingSkillForInstall({
    packageName: "new-name",
    source: "market",
    market: { provider: "clawhub.ai", marketSkillId: "owner/demo" },
    getById: () => undefined,
    getByMarket: (provider, marketSkillId) =>
      provider === "clawhub.ai" && marketSkillId === "owner/demo" ? installed : undefined
  });
  assert.equal(byMarket?.id, "old-name");

  assert.equal(
    hasLocalSkillDrift({
      existing: installed,
      source: "market",
      diskContentHash: "aaa"
    }),
    false
  );
  assert.equal(
    hasLocalSkillDrift({
      existing: installed,
      source: "market",
      diskContentHash: "bbb"
    }),
    true
  );
  assert.equal(
    hasLocalSkillDrift({
      existing: installed,
      source: "market",
      allowLocalOverwrite: true,
      diskContentHash: "bbb"
    }),
    false
  );
  assert.equal(
    hasLocalSkillDrift({
      existing: installed,
      source: "market",
      diskContentHash: null
    }),
    true
  );

  assert.doesNotThrow(() =>
    assertDestinationReadyForInstall({
      destination: "/skills/old-name",
      previousRoot: "/skills/old-name",
      destinationExists: true
    })
  );
  assert.throws(
    () =>
      assertDestinationReadyForInstall({
        destination: "/skills/new-name",
        previousRoot: "/skills/old-name",
        destinationExists: true
      }),
    /already exists/
  );

  assert.equal(
    rewriteSkillIdListJson('["keep","old-name","old-name"]', "old-name", "new-name"),
    '["keep","new-name"]'
  );
  assert.equal(
    rewriteWorkflowRolesSkillIdsJson(
      JSON.stringify([
        { id: "r1", skillIds: ["old-name", "other"] },
        { id: "r2", skillIds: ["keep"] }
      ]),
      "old-name",
      "new-name"
    ),
    JSON.stringify([
      { id: "r1", skillIds: ["new-name", "other"] },
      { id: "r2", skillIds: ["keep"] }
    ])
  );
});

test("429 retry wait respects abort signal timeout", async () => {
  const { marketFetchJson } = await import("../dist-electron/cli/skillMarketHttp.js");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("rate limited", {
      status: 429,
      headers: {
        "retry-after": "2",
        "content-type": "text/plain"
      }
    });
  };

  const started = Date.now();
  try {
    await assert.rejects(
      () =>
        marketFetchJson(
          "https://clawhub.ai/api/v1/search?q=demo",
          new Set(["clawhub.ai"]),
          undefined,
          50
        ),
      /timed out/
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 250, `expected timeout near 50ms, took ${elapsed}ms`);
    assert.ok(calls >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market JSON responses enforce Content-Length and streamed size limits", async () => {
  const { readMarketResponseText } = await import(
    "../dist-electron/cli/skillMarketHttp.js"
  );

  await assert.rejects(
    () =>
      readMarketResponseText(
        new Response("tiny", {
          status: 200,
          headers: { "content-length": "1000" }
        }),
        100
      ),
    /exceeds the 100 byte limit/
  );

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abcdefghij"));
      controller.enqueue(new TextEncoder().encode("klmnopqrst"));
      controller.close();
    }
  });
  await assert.rejects(
    () => readMarketResponseText(new Response(stream), 12),
    /exceeds the 12 byte limit/
  );

  const ok = await readMarketResponseText(
    new Response('{"ok":true}', {
      status: 200,
      headers: { "content-length": "11" }
    }),
    64
  );
  assert.equal(ok, '{"ok":true}');
});

test("market download timeout covers a hanging response body", async () => {
  const {
    marketWriteResponseToFile,
    withMarketRequestTimeout
  } = await import("../dist-electron/cli/skillMarketHttp.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "market-body-timeout-"));
  const destination = path.join(root, "hang.zip");
  const body = new ReadableStream({
    start() {
      // Intentionally never enqueue or close — simulates a hung download body.
    }
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "application/zip" }
  });

  try {
    await assert.rejects(
      () =>
        withMarketRequestTimeout(80, (signal) =>
          marketWriteResponseToFile(response, destination, 1024 * 1024, signal)
        ),
      /timed out/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-commit backup cleanup failures do not trigger install rollback", async () => {
  const {
    removePathBestEffort,
    shouldRollbackSkillInstallFiles
  } = await import("../dist-electron/cli/skillInstallResolve.js");

  assert.equal(shouldRollbackSkillInstallFiles(false), true);
  assert.equal(shouldRollbackSkillInstallFiles(true), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-backup-"));
  const backup = path.join(root, "backup-dir");
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, "SKILL.md"), "keep\n");

  const warnings = [];
  const removed = removePathBestEffort(backup, {
    rmSync: () => {
      const error = new Error("EBUSY: resource busy or locked");
      error.code = "EBUSY";
      throw error;
    },
    warn: (message, error) => {
      warnings.push({ message, error });
    }
  });

  assert.equal(removed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /failed to remove path/);
  // Fault-injected rmSync must not delete the directory or rethrow.
  assert.equal(fs.existsSync(path.join(backup, "SKILL.md")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("ClawHub GitHub handoff extracts nested path and verifies contentHash", async () => {
  const {
    extractGitHubZipSkillPath,
    extractSkillArchive
  } = await import("../dist-electron/cli/skillArchive.js");
  const {
    assertClawhubContentHash,
    computeClawhubContentHash,
    expectedGitHubZipballUrl,
    parseClawhubGithubHandoff
  } = await import("../dist-electron/cli/skillMarketProviders/clawhub.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawhub-gh-"));
  const zipPath = path.join(root, "repo.zip");
  const nestedExtract = path.join(root, "nested-out");
  const heuristicExtract = path.join(root, "heuristic-out");
  const zipRoot = "owner-repo-abcdef1234567890abcdef1234567890abcdef12";
  const nestedSkillMd = `---
name: nested-skill
description: Real nested skill
---
# Nested
`;
  const decoySkillMd = `---
name: decoy-root
description: Decoy at repository root
---
# Decoy
`;

  const zip = new AdmZip();
  // GitHub zipballs commonly emit explicit directory entries before files.
  zip.addFile(`${zipRoot}/`, Buffer.alloc(0));
  zip.addFile(`${zipRoot}/nested/`, Buffer.alloc(0));
  zip.addFile(`${zipRoot}/nested/skill/`, Buffer.alloc(0));
  zip.addFile(`${zipRoot}/SKILL.md`, Buffer.from(decoySkillMd));
  zip.addFile(`${zipRoot}/nested/skill/SKILL.md`, Buffer.from(nestedSkillMd));
  zip.addFile(`${zipRoot}/nested/skill/README.md`, Buffer.from("# Nested skill\n"));
  zip.writeZip(zipPath);

  try {
    const handoff = parseClawhubGithubHandoff({
      sourceRef: "public-github",
      repo: "owner/repo",
      commit: "abcdef1234567890abcdef1234567890abcdef12",
      path: "nested/skill",
      contentHash: "pending",
      archiveUrl: expectedGitHubZipballUrl(
        "owner/repo",
        "abcdef1234567890abcdef1234567890abcdef12"
      )
    });
    assert.equal(handoff.path, "nested/skill");
    assert.equal(
      handoff.archiveUrl,
      "https://api.github.com/repos/owner/repo/zipball/abcdef1234567890abcdef1234567890abcdef12"
    );

    assert.throws(
      () =>
        parseClawhubGithubHandoff({
          sourceRef: "public-github",
          repo: "owner/repo",
          commit: "abcdef1234567890abcdef1234567890abcdef12",
          path: "nested/skill",
          contentHash: "abc",
          archiveUrl: "https://evil.example/zip"
        }),
      /archiveUrl does not match/
    );

    extractGitHubZipSkillPath(zipPath, nestedExtract, "nested/skill");
    assert.equal(
      fs.readFileSync(path.join(nestedExtract, "SKILL.md"), "utf8"),
      nestedSkillMd
    );
    assert.equal(fs.existsSync(path.join(nestedExtract, "README.md")), true);
    assert.equal(fs.existsSync(path.join(nestedExtract, "nested")), false);

    // Heuristic full-archive extraction would prefer the root decoy SKILL.md.
    extractSkillArchive(zipPath, heuristicExtract);
    assert.match(
      fs.readFileSync(path.join(heuristicExtract, zipRoot, "SKILL.md"), "utf8"),
      /decoy-root/
    );

    const contentHash = computeClawhubContentHash(nestedExtract);
    assert.match(contentHash, /^[0-9a-f]{64}$/);
    assertClawhubContentHash(nestedExtract, contentHash);
    assert.throws(
      () => assertClawhubContentHash(nestedExtract, "0".repeat(64)),
      /content hash mismatch/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
