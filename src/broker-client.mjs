import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

import { ensurePrivateDirectory, instancePaths } from './paths.mjs';

const DAEMON_PATH = fileURLToPath(new URL('./broker-server.mjs', import.meta.url));
const RESPONSE_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MUTATIONS = new Set(['bind', 'unbind', 'open', 'activate', 'navigate', 'click', 'fill', 'press', 'select', 'scroll', 'closeTab']);
const DAEMON_ENV = new Set(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function openSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('BROKER_CONNECT_TIMEOUT')); }, 3_000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
  });
}

export class BrokerClient {
  constructor(options = {}) {
    this.paths = options.paths || instancePaths();
    this.autoStart = options.autoStart !== false;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.buffer = '';
  }

  async ready() {
    if (this.closed) throw new Error('Browser broker client is closed');
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.#open().finally(() => { this.connecting = null; });
    }
    await this.connecting;
  }

  async #open() {
    await ensurePrivateDirectory(this.paths.dir);
    let spawned = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const socket = await openSocket(this.paths.socket);
        if (this.closed) { socket.destroy(); throw new Error('Browser broker client is closed'); }
        this.#attach(socket);
        return;
      } catch (error) {
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
        if (!this.autoStart) throw new Error('BROKER_NOT_RUNNING: start it with browserctl start');
        if (!spawned) {
          const log = openSync(this.paths.log, 'a', 0o600);
          try {
            // The daemon outlives this process, so it gets only what it needs, not the caller's whole environment.
            const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => DAEMON_ENV.has(key) || key.startsWith('BROWSERCTL_')));
            Object.assign(env, { BROWSERCTL_PROFILE_DIR: this.paths.profileDir, BROWSERCTL_STATE_DIR: this.paths.stateDir });
            const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: ['ignore', log, log], env });
            child.unref();
          } finally {
            closeSync(log);
          }
          spawned = true;
        }
        await delay(100);
      }
    }
    const log = await readFile(this.paths.log, 'utf8').catch(() => '');
    throw new Error(`BROKER_START_FAILED: the browser daemon did not create its socket. ${log.trim().slice(-2_000) || `See ${this.paths.log}`}`);
  }

  #attach(socket) {
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (this.socket !== socket) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_RESPONSE_BYTES) {
        socket.destroy(new Error('BROKER_RESPONSE_TOO_LARGE'));
        return;
      }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error('Invalid browser broker response')); return; }
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error));
        else waiting.resolve(message.result);
      }
    });
    const lost = error => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const waiting of this.pending.values()) {
        clearTimeout(waiting.timer);
        const prefix = MUTATIONS.has(waiting.method) ? 'OUTCOME_UNKNOWN' : 'BROKER_DISCONNECTED';
        waiting.reject(new Error(`${prefix}: ${error?.message || 'browser daemon connection closed'}`));
      }
      this.pending.clear();
    };
    socket.on('error', lost);
    socket.on('close', () => lost());
  }

  async request(method, args = []) {
    await this.ready();
    if (!this.socket) throw new Error('BROKER_DISCONNECTED: the broker connection closed before the request was sent');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const prefix = MUTATIONS.has(method) ? 'OUTCOME_UNKNOWN' : 'BROKER_TIMEOUT';
        reject(new Error(`${prefix}: browser daemon did not respond within ${RESPONSE_TIMEOUT_MS / 1000} seconds`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.write(`${JSON.stringify({ id, method, args })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  status() { return this.request('status'); }
  tabs() { return this.request('tabs'); }
  tabsAll() { return this.request('tabsAll'); }
  bind(tabId) { return this.request('bind', tabId === undefined ? [] : [tabId]); }
  unbind() { return this.request('unbind'); }
  open(url) { return this.request('open', [url]); }
  activate(tabId) { return this.request('activate', [tabId]); }
  navigate(tabId, url) { return this.request('navigate', [tabId, url]); }
  snapshot(tabId, options) { return this.request('snapshot', options === undefined ? [tabId] : [tabId, options]); }
  text(tabId, options) { return this.request('text', options === undefined ? [tabId] : [tabId, options]); }
  click(tabId, ref) { return this.request('click', [tabId, ref]); }
  fill(tabId, ref, text) { return this.request('fill', [tabId, ref, text]); }
  press(tabId, ref, key) { return this.request('press', [tabId, ref, key]); }
  select(tabId, ref, option) { return this.request('select', [tabId, ref, option]); }
  scroll(tabId, direction) { return this.request('scroll', [tabId, direction]); }
  closeTab(tabId) { return this.request('closeTab', [tabId]); }
  screenshot(tabId) { return this.request('screenshot', [tabId]); }
  shutdown() { return this.request('shutdown'); }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}

export async function connectBroker(options) {
  const client = new BrokerClient(options);
  await client.ready();
  return client;
}
