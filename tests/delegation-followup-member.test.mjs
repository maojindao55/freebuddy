import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/services/delegation/followupMember.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { resolveDelegationFollowupMember: resolve } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('team follow-up resolves replacement after original agent is deleted', () => {
  const replacement = { id: 'bai', name: 'bai-DeepSeekHarness' };
  const team = { entryRoleId: 'pm', roster: [{ id: 'pm', agentId: replacement.id }] };
  assert.equal(resolve(team, [replacement]), replacement);
  assert.equal(resolve(team, [{ id: 'tokenrouter' }, replacement]), replacement);
});

test('missing team or current entry does not fall back to another member', () => {
  assert.equal(resolve(undefined, [{ id: 'old' }]), undefined);
  assert.equal(resolve({ entryRoleId: 'pm', roster: [{ id: 'pm', agentId: 'deleted' }] }, [{ id: 'old' }]), undefined);
  assert.equal(resolve({ entryRoleId: 'pm', roster: [] }, [{ id: 'old' }]), undefined);
});

test('entry role selects the current lead rather than the first teammate', () => {
  const members = [{ id: 'reviewer' }, { id: 'lead' }];
  assert.equal(resolve({ entryRoleId: 'pm', roster: [{ id: 'qa', agentId: 'reviewer' }, { id: 'pm', agentId: 'lead' }] }, members), members[1]);
});
