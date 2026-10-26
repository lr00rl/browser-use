import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Default user data directories, matching what Chrome and Puppeteer use for each channel.
const CHANNEL_DIRS = {
  darwin: { stable: 'Google/Chrome', beta: 'Google/Chrome Beta', dev: 'Google/Chrome Dev', canary: 'Google/Chrome Canary' },
  linux: { stable: 'google-chrome', beta: 'google-chrome-beta', dev: 'google-chrome-unstable', canary: 'google-chrome-canary' },
};

function unsupported() {
  // yagni: macOS and Linux only; Windows needs named pipes and ACL checks instead of POSIX mode bits.
  return new Error(`UNSUPPORTED_PLATFORM: browserctl supports macOS and Linux, not ${process.platform}`);
}

export function profileDirectory(env = process.env) {
  if (env.BROWSERCTL_PROFILE_DIR) return env.BROWSERCTL_PROFILE_DIR;
  const dirs = CHANNEL_DIRS[process.platform];
  if (!dirs) throw unsupported();
  const channel = env.BROWSERCTL_CHANNEL || 'stable';
  if (!Object.hasOwn(dirs, channel)) {
    throw new Error(`Unknown BROWSERCTL_CHANNEL "${channel}". Use one of: ${Object.keys(dirs).join(', ')}`);
  }
  const base = process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support')
    : env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, dirs[channel]);
}

export function stateDirectory(env = process.env) {
  if (env.BROWSERCTL_STATE_DIR) return env.BROWSERCTL_STATE_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/browserctl');
  if (process.platform === 'linux') {
    return env.XDG_RUNTIME_DIR
      ? join(env.XDG_RUNTIME_DIR, 'browserctl')
      : join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'browserctl');
  }
  throw unsupported();
}

// Each Chrome user data directory gets its own broker, binding and locks, so two channels never share state.
export function instancePaths(profileDir = profileDirectory(), stateDir = stateDirectory()) {
  const dir = join(stateDir, createHash('sha256').update(profileDir).digest('hex').slice(0, 8));
  return {
    profileDir,
    stateDir,
    dir,
    socket: join(dir, 'ipc.sock'),
    binding: join(dir, 'binding.json'),
    locks: join(dir, 'locks'),
    log: join(dir, 'broker.log'),
  };
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
    throw new Error(`Unsafe browserctl state directory (must be a real directory owned by you with mode 0700): ${directory}`);
  }
  return directory;
}
