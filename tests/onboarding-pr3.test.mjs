import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

test("ChatView tailors hero and starter prompts for GuideBuddy", () => {
  const chatView = read("src/components/CLI/ChatView.tsx");
  assert.match(chatView, /isGuide/);
  assert.match(chatView, /member\?\.profile === "guide"/);
  assert.match(chatView, /ONBOARDING_GUIDE_AGENT_ID/);
  assert.match(chatView, /onboarding\.starter\.tour/);
  assert.match(chatView, /onboarding\.starter\.installAgent/);
  assert.match(chatView, /onboarding\.starter\.freebie/);
  assert.match(chatView, /onboarding\.starter\.tryCoding/);
  assert.match(chatView, /chat-empty-hero--guide/);
});

test("ChatView renders guide notice banner with finish and settings triggers", () => {
  const chatView = read("src/components/CLI/ChatView.tsx");
  assert.match(chatView, /guide-chat-banner/);
  assert.match(chatView, /guideBannerText/);
  assert.match(chatView, /guideBannerSettings/);
  assert.match(chatView, /guideBannerFinish/);
  assert.match(chatView, /useOnboardingStore\.getState\(\)\.markDone\(\)/);
});

test("onboarding locale strings are fully mirrored across zh-CN and en", () => {
  const zh = JSON.parse(read("src/locales/zh-CN.json"));
  const en = JSON.parse(read("src/locales/en.json"));

  assert.ok(zh.onboarding, "zh onboarding missing");
  assert.ok(en.onboarding, "en onboarding missing");

  const requiredKeys = [
    "title",
    "subtitle",
    "trial",
    "trialHint",
    "trialProviderName",
    "byok",
    "byokHint",
    "skip",
    "guideEyebrow",
    "guideHeroHeading",
    "guideHeroBody",
    "guideBannerText",
    "guideBannerSettings",
    "guideBannerFinish",
    "guideGraduated"
  ];

  for (const key of requiredKeys) {
    assert.ok(zh.onboarding[key], `zh onboarding missing key: ${key}`);
    assert.ok(en.onboarding[key], `en onboarding missing key: ${key}`);
  }

  const starterKeys = ["tour", "installAgent", "freebie", "tryCoding"];
  for (const key of starterKeys) {
    assert.ok(zh.onboarding.starter?.[key], `zh onboarding.starter missing key: ${key}`);
    assert.ok(en.onboarding.starter?.[key], `en onboarding.starter missing key: ${key}`);
  }
});

test("onboarding-guide skill exists as a builtin with proper frontmatter and instructions", () => {
  const skillFile = path.join(rootDir, "assets", "skills", "onboarding-guide", "SKILL.md");
  assert.equal(fs.existsSync(skillFile), true, "onboarding-guide/SKILL.md not found");

  const content = fs.readFileSync(skillFile, "utf8");
  assert.match(content, /^---\nname:\s*onboarding-guide/m);
  assert.match(content, /description:/);
  assert.match(content, /FreeBuddy's onboarding guide/);
  assert.match(content, /Audience assumptions/);
  assert.match(content, /Onboarding flow/);
  assert.match(content, /Graduation/);
});

test("ChatView renders OnboardingGuideSetupCard for guide onboarding", () => {
  const chatView = read("src/components/CLI/ChatView.tsx");
  assert.match(chatView, /<OnboardingGuideSetupCard/);
  assert.match(chatView, /import \{ OnboardingGuideSetupCard \}/);

  const card = read("src/components/Onboarding/OnboardingGuideSetupCard.tsx");
  assert.match(card, /useCliExecutorStore/);
  assert.match(card, /useCliInstallStore/);
  assert.match(card, /useProviderStore/);
  assert.match(card, /codex-acp/);
  assert.match(card, /dsh-acp/);
  assert.match(card, /claude-agent-acp/);
  assert.match(card, /handleInstall/);
  assert.match(card, /handleInstallAll/);
  assert.match(card, /handleAuthorize/);
  assert.match(card, /handleStartTask/);
});

test("onboarding.setup locale keys are fully mirrored", () => {
  const zh = JSON.parse(read("src/locales/zh-CN.json"));
  const en = JSON.parse(read("src/locales/en.json"));

  assert.ok(zh.onboarding.setup, "zh onboarding.setup missing");
  assert.ok(en.onboarding.setup, "en onboarding.setup missing");

  const setupKeys = [
    "cardTitle",
    "cardSubtitle",
    "allInstalled",
    "partiallyInstalled",
    "noneInstalled",
    "installAll",
    "installAllNone",
    "installingAll",
    "install",
    "installing",
    "installed",
    "codexDesc",
    "dshDesc",
    "claudeDesc",
    "step2Title",
    "step2Desc",
    "step2Done",
    "authorizeTrial",
    "authorizing",
    "noProviderFound",
    "authorizedSuccess",
    "askGuideBtn",
    "askGuidePrompt",
    "askGuideTooltip",
    "step3Title",
    "step3Desc",
    "startFirstTask",
    "firstTaskTitle",
    "firstTaskStarted",
    "noAgentReady",
    "exploreOtherAgents"
  ];

  for (const key of setupKeys) {
    assert.ok(zh.onboarding.setup[key], `zh onboarding.setup missing: ${key}`);
    assert.ok(en.onboarding.setup[key], `en onboarding.setup missing: ${key}`);
  }
});

test("guide chat elements and setup card have styling in styles.css", () => {
  const styles = read("styles.css");
  assert.match(styles, /\.guide-chat-banner/);
  assert.match(styles, /\.guide-chat-banner-btn--finish/);
  assert.match(styles, /\.chat-empty-hero--guide/);
  assert.match(styles, /\.onboarding-setup-card/);
  assert.match(styles, /\.step-btn--launch/);
  assert.match(styles, /\.step-btn--guide-auto/);
  assert.match(styles, /\.onboarding-core-agents-list/);
});




