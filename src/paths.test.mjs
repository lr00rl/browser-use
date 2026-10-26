import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { instancePaths, profileDirectory, stateDirectory } from './paths.mjs';

test('resolves the default Chrome user data directory for each channel', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const expected = process.platform === 'darwin'
    ? { stable: 'Library/Application Support/Google/Chrome', canary: 'Library/Application Support/Google/Chrome Canary' }
    : { stable: '.config/google-chrome', canary: '.config/google-chrome-canary' };
  const env = {};
  assert.equal(profileDirectory(env), join(homedir(), expected.stable));
  assert.equal(profileDirectory({ BROWSERCTL_CHANNEL: 'canary' }), join(homedir(), expected.canary));
  assert.throws(() => profileDirectory({ BROWSERCTL_CHANNEL: 'nightly' }), /Unknown BROWSERCTL_CHANNEL/);
  assert.equal(profileDirectory({ BROWSERCTL_PROFILE_DIR: '/tmp/custom', BROWSERCTL_CHANNEL: 'nightly' }), '/tmp/custom');
});

test('keeps separate state for separate Chrome user data directories', () => {
  const stable = instancePaths('/profiles/stable', '/state');
  const canary = instancePaths('/profiles/canary', '/state');
  assert.notEqual(stable.dir, canary.dir);
  assert.equal(stable.dir, instancePaths('/profiles/stable', '/state').dir);
  assert.ok(stable.socket.startsWith(stable.dir));
  assert.equal(stateDirectory({ BROWSERCTL_STATE_DIR: '/custom/state' }), '/custom/state');
});
