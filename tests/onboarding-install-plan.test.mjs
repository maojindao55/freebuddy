import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = mkdtempSync(path.join(tmpdir(), 'fb-onboarding-tests-'));
test.after(() => rmSync(temp, { recursive: true, force: true }));
await build({ entryPoints: ['src/utils/onboardingInstallPlan.ts'], outfile: path.join(temp, 'plan.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { buildOnboardingInstallPlan: plan } = await import(pathToFileURL(path.join(temp, 'plan.mjs')).href);
const adapters = ['codex-acp', 'claude-agent-acp', 'qoder-acp', 'dsh-acp', 'pi-acp', 'kimi-acp'].map(id => ({ id, label: id, protocol: 'acp', defaultBinary: id, installHint: 'install ' + id }));
const ids = items => items.map(item => item.id);

test('existing Codex and Qoder are connected before the remaining trio, without duplicates', () => {
  const items = plan(adapters, {
    'codex-acp': { installed: false, lastError: 'codex cli found; acp adapter missing' },
    'qoder-acp': { installed: false, lastError: 'qoder app found; cli missing' }
  });
  assert.deepEqual(ids(items), ['codex-acp', 'qoder-acp', 'dsh-acp', 'claude-agent-acp']);
  assert.deepEqual(items.map(item => item.detected), [true, true, false, false]);
});

test('fresh installations get only the trio, while existing other agents are retained', () => {
  assert.deepEqual(ids(plan(adapters, {})), ['codex-acp', 'dsh-acp', 'claude-agent-acp']);
  const items = plan(adapters, { 'kimi-acp': { installed: true }, 'pi-acp': { installed: true } });
  assert.deepEqual(ids(items), ['kimi-acp', 'codex-acp', 'dsh-acp', 'claude-agent-acp']);
  assert.equal(items[0].installed, true);
});

test('installation progress does not move rows between discovery groups', () => {
  const discovered = { 'codex-acp': { installed: false, lastError: 'codex app found; acp adapter missing' } };
  const items = plan(adapters, { ...discovered, 'dsh-acp': { installed: true } }, discovered);
  assert.deepEqual(ids(items), ['codex-acp', 'dsh-acp', 'claude-agent-acp']);
  assert.equal(items[1].installed, true);
  assert.equal(items[1].detected, false);
});

test('broken detected binaries are repair candidates, not installed successes', () => {
  const items = plan(adapters, { 'qoder-acp': { installed: false, binaryPath: '/bin/qodercli' } });
  assert.equal(items[0].id, 'qoder-acp');
  assert.equal(items[0].needsRepair, true);
  assert.equal(items[0].installed, false);
});

test('shared queue deduplicates, waits for verification, retries failures and cancels pending work', async () => {
  const events = new Map();
  const started = [];
  let available = true;
  let verified = true;
  let releaseCheck;
  globalThis.__onboardingTest = {
    cli: { isAvailable: () => available, installStream: (id, command, callback) => {
      if (id === 'throw') throw new Error('bridge failure');
      started.push(id); events.set(id, callback); return () => {};
    } },
    executor: { check: () => new Promise(resolve => { releaseCheck = resolve; }), resolve: () => ({ runtime: { installed: verified } }) }
  };
  await build({ entryPoints: ['src/store/cliInstallStore.ts'], outfile: path.join(temp, 'queue.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'bridges', setup(b) {
    b.onResolve({ filter: /^@\/services\/cli\/client$/ }, () => ({ path: 'cli', namespace: 'fixture' }));
    b.onResolve({ filter: /^@\/store\/cliExecutorStore$/ }, () => ({ path: 'executor', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'cli'
      ? 'export const cliClient = globalThis.__onboardingTest.cli;'
      : 'export const useCliExecutorStore = { getState: () => globalThis.__onboardingTest.executor };' }));
  } }] });
  const { useCliInstallStore: store } = await import(pathToFileURL(path.join(temp, 'queue.mjs')).href);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const request = id => ({ adapterId: id, label: id, command: 'install ' + id });
  store.getState().enqueueJobs(['codex', 'qoder', 'codex', 'deepseek'].map(request));
  await tick();
  assert.deepEqual(started, ['codex']);
  assert.deepEqual(store.getState().queue.map(j => j.adapterId), ['qoder', 'deepseek']);
  events.get('codex')({ type: 'done', exitCode: 0 });
  await tick();
  assert.equal(store.getState().jobs[0].phase, 'verifying');
  assert.deepEqual(started, ['codex']);
  releaseCheck(); await tick();
  assert.deepEqual(started, ['codex', 'qoder']);
  events.get('qoder')({ type: 'done', exitCode: 1 }); await tick();
  assert.deepEqual(started, ['codex', 'qoder', 'deepseek']);
  events.get('deepseek')({ type: 'done', exitCode: 0 }); await tick();
  verified = false; releaseCheck(); await tick();
  assert.equal(store.getState().jobs.find(j => j.id === 'deepseek').phase, 'verification_failed');
  store.getState().enqueueJobs(['qoder', 'later'].map(request)); await tick();
  assert.equal(started.filter(id => id === 'qoder').length, 2);
  store.getState().clearQueue();
  events.get('qoder')({ type: 'done', exitCode: 1 }); await tick();
  assert.equal(started.includes('later'), false);
  store.getState().enqueueJobs(['throw', 'recovered'].map(request)); await tick();
  assert.equal(store.getState().jobs.find(j => j.id === 'throw').phase, 'failed');
  assert.equal(started.at(-1), 'recovered');
  events.get('recovered')({ type: 'done', exitCode: 1 }); await tick();
  available = false; store.getState().enqueueJobs([request('unavailable')]); await tick();
  assert.equal(store.getState().queue.length, 0);
  assert.equal(started.includes('unavailable'), false);
  delete globalThis.__onboardingTest;
});
