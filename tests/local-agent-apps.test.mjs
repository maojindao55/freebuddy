import test from 'node:test';
import assert from 'node:assert/strict';
import { localAgentAppCandidates } from '../dist-electron/cli/localAgentApps.js';

test('desktop discovery searches system and per-user macOS locations without claiming CLI readiness', () => {
  assert.deepEqual(localAgentAppCandidates('Qoder', 'darwin', '/Users/test'), [
    '/Applications/Qoder.app/Contents/Info.plist',
    '/Users/test/Applications/Qoder.app/Contents/Info.plist'
  ]);
  assert.equal(localAgentAppCandidates('Codex', 'darwin', '/Users/test')[0], '/Applications/Codex.app/Contents/Info.plist');
});

test('Windows discovery uses the supplied installation roots and omits missing ones', () => {
  assert.deepEqual(localAgentAppCandidates('Qoder', 'win32', 'C:\\Users\\test', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }), [
    'C:\\Users\\test\\AppData\\Local\\Programs\\Qoder\\Qoder.exe'
  ]);
  assert.deepEqual(localAgentAppCandidates('Qoder', 'win32', '', {}), []);
});

test('Linux discovery checks launchers in system and per-user application directories', () => {
  assert.deepEqual(localAgentAppCandidates('Qoder', 'linux', '/home/test'), [
    '/usr/share/applications/qoder.desktop', '/home/test/.local/share/applications/qoder.desktop'
  ]);
});
