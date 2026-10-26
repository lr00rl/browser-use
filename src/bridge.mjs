import { readFile, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ensurePrivateDirectory, instancePaths, profileDirectory } from './paths.mjs';

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 60_000;
const SNAPSHOT_WAIT_MS = 15_000;
const MAX_TEXT_LENGTH = 100_000;
const MAX_PAGE_TEXT = 50_000;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 200;
const QUERY_LIMIT = 80;
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Control elsewhere

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
]);

// key, code, windowsVirtualKeyCode, and the text Chrome must receive for keypress side effects such as form submission.
export const KEYS = {
  Enter: ['Enter', 'Enter', 13, '\r'],
  Tab: ['Tab', 'Tab', 9],
  Escape: ['Escape', 'Escape', 27],
  Backspace: ['Backspace', 'Backspace', 8],
  Delete: ['Delete', 'Delete', 46],
  Space: [' ', 'Space', 32, ' '],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39],
  Home: ['Home', 'Home', 36],
  End: ['End', 'End', 35],
  PageUp: ['PageUp', 'PageUp', 33],
  PageDown: ['PageDown', 'PageDown', 34],
};

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden', 'range', 'color']);

const SELECT_OPTION = `function (wanted) {
  if (this.localName !== 'select') return { error: 'NOT_A_SELECT: use click for custom dropdowns' };
  const options = Array.from(this.options);
  const option = options.find(o => o.label === wanted || o.value === wanted) ||
    options.find(o => o.label.trim().toLowerCase() === wanted.trim().toLowerCase());
  if (!option) return { error: 'OPTION_NOT_FOUND', options: options.slice(0, 50).map(o => o.label) };
  if (this.disabled || option.disabled) return { error: 'OPTION_DISABLED' };
  option.selected = true;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: option.value, label: option.label };
}`;

// True when `other` is this element or inside it, including inside its shadow trees.
const CONTAINS = `function (other) {
  for (let node = other; node; node = node.parentNode || node.host) if (node === this) return true;
  return false;
}`;

// After the click, focus must still be on the element that passed the field checks. Pages that move focus
// (auto-advancing code inputs, login steps) would otherwise receive the text in a different field.
const FOCUS_CHECK = `function () {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  let inside = false;
  for (let node = active; node; node = node.parentNode || node.host) if (node === this) { inside = true; break; }
  if (!inside) return 'FOCUS_MOVED';
  if (active.localName === 'input') {
    const type = (active.getAttribute('type') || '').toLowerCase();
    const autocomplete = (active.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    if (type === 'password' || autocomplete.some(value => /^(current-password|new-password|one-time-code|cc-)/.test(value))) return 'SENSITIVE';
  }
  return 'OK';
}`;

export async function acquireMutationLock(root) {
  // yagni: one browser-wide writer lock; use per-tab leases if parallel writes become necessary.
  await ensurePrivateDirectory(root);
  const lockPath = join(root, 'mutation.lock');
  const ownerPath = join(lockPath, 'owner.json');
  const owner = { pid: process.pid, id: randomUUID(), createdAt: Date.now() };
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        await rm(lockPath, { recursive: true, force: true });
        throw writeError;
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(ownerPath, 'utf8'));
          if (current.id === owner.id) await rm(lockPath, { recursive: true, force: true });
        } catch { /* A replaced lock must not be removed. */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(ownerPath, 'utf8')); } catch { /* owner is being written */ }
      if (!previous && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }
      if (!previous) {
        const age = Date.now() - (await lstat(lockPath)).mtimeMs;
        if (age < 2_000) throw new Error('CONTROLLER_BUSY: browser writer lock is being initialized');
      }
      let alive = false;
      if (Number.isInteger(previous?.pid)) {
        try { process.kill(previous.pid, 0); alive = true; } catch (checkError) { alive = checkError.code === 'EPERM'; }
      }
      if (alive && (!Number.isFinite(previous.createdAt) || Date.now() - previous.createdAt < 120_000)) {
        throw new Error(`CONTROLLER_BUSY: another browser action is running in process ${previous.pid}`);
      }
      const stalePath = join(root, `stale-${randomUUID()}`);
      try {
        await rename(lockPath, stalePath);
      } catch (moveError) {
        if (moveError.code !== 'ENOENT') throw moveError;
        continue;
      }
      let moved;
      try { moved = JSON.parse(await readFile(join(stalePath, 'owner.json'), 'utf8')); } catch { /* stale lock without an owner */ }
      if (moved?.id !== previous?.id) {
        // Another waiter reclaimed the stale lock and took a fresh one first; give it back.
        await rename(stalePath, lockPath).catch(() => {});
        throw new Error(`CONTROLLER_BUSY: another browser action just started in process ${moved?.pid}`);
      }
      await rm(stalePath, { recursive: true, force: true });
    }
  }
  throw new Error('CONTROLLER_BUSY: could not acquire the browser writer lock');
}

export async function discoverEndpoint(profileDir = profileDirectory()) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  let file;
  try {
    const stat = await lstat(portFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('unexpected file owner or type');
    }
    file = await readFile(portFile, 'utf8');
  } catch (error) {
    throw new Error(`CHROME_NOT_ENABLED: Chrome has not enabled browser debugging for this profile. In the running Chrome, open chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance". Then approve its connection dialog. (${portFile}: ${error.message})`, { cause: error });
  }
  const [rawPort, path] = file.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || '')) {
    throw new Error(`Chrome produced an invalid DevToolsActivePort file at ${portFile}`);
  }
  return { url: `ws://127.0.0.1:${port}${path}`, profileDir, endpointId: path.slice('/devtools/browser/'.length) };
}

export function validateUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http: and https: URLs can be opened or navigated to');
  }
  return url.href;
}

function isWebUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateTabId(tabId) {
  if (typeof tabId !== 'string' || !/^[A-F0-9]{4,}$/i.test(tabId)) {
    throw new Error('tabId must be a Chrome target ID (or a unique prefix of at least 4 characters) from tabs() or open()');
  }
  return tabId.toUpperCase();
}

function matchTab(prefix, tabs) {
  const wanted = validateTabId(prefix);
  const matches = tabs.filter(tab => tab.tabId.toUpperCase().startsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`TAB_NOT_FOUND: no web tab in the bound profile matches ${prefix}`);
  throw new Error(`AMBIGUOUS_TAB: ${matches.length} tabs start with ${prefix}; use more characters`);
}

// A ref names one accessibility node in one document. The digest covers the document identity and the node's
// role and name, so a ref stops validating after navigation or when the element changes meaning.
function elementRef(documentToken, node) {
  const digest = createHash('sha256')
    .update([documentToken, node.backendDOMNodeId, node.role?.value || '', node.name?.value || ''].join('\0'))
    .digest('hex').slice(0, 8);
  return `e${node.backendDOMNodeId}-${digest}`;
}

function parseRef(ref) {
  const match = typeof ref === 'string' && /^e(\d{1,15})-[0-9a-f]{8}$/.exec(ref);
  if (!match) throw new Error('ref must be a value such as "e123-ab12cd34" from a current snapshot');
  return Number(match[1]);
}

function nodeStates(node) {
  const states = [];
  for (const { name, value } of node.properties || []) {
    const v = value?.value;
    if (name === 'checked') {
      if (v === 'true' || v === true) states.push('checked');
      else if (v === 'mixed') states.push('mixed');
      else states.push('unchecked');
    } else if (name === 'pressed' && (v === 'true' || v === true)) {
      states.push('pressed');
    } else if (name === 'expanded') {
      states.push(v ? 'expanded' : 'collapsed');
    } else if (['disabled', 'selected', 'focused', 'required'].includes(name) && v === true) {
      states.push(name);
    }
  }
  return states;
}

// The CDP transport failed, so a command that was already sent may or may not have run.
class TransportError extends Error {}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener('message', event => this.#onMessage(event.data));
    socket.addEventListener('close', () => this.#close(new TransportError('Chrome closed the debugging connection')));
    socket.addEventListener('error', () => this.#close(new TransportError('Chrome debugging connection failed')));
  }

  static async open(url, signal) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(new Error('Chrome bridge connection cancelled'));
      const timer = setTimeout(() => finish(new Error('Timed out waiting for Chrome connection approval')), CONNECT_TIMEOUT_MS);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', () => finish(), { once: true });
      socket.addEventListener('error', () => finish(new Error('Could not connect to Chrome. Check its remote debugging approval dialog.')), { once: true });
    }).catch(error => {
      socket.close();
      throw error;
    });
    return new CdpConnection(socket);
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id === undefined) {
      if (message.method === 'Target.detachedFromTarget' || message.method === 'Inspector.detached') {
        const detachedSession = message.params?.sessionId || message.sessionId;
        for (const [id, waiting] of this.pending) {
          if (waiting.sessionId === detachedSession) {
            clearTimeout(waiting.timer);
            this.pending.delete(id);
            waiting.reject(new TransportError('DEBUGGER_DETACHED: Chrome detached from the target tab'));
          }
        }
      }
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
    else waiting.resolve(message.result || {});
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      try { this.socket.close(); } catch { /* Chrome may already have torn down the socket. */ }
    }
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new TransportError('Chrome debugging connection is closed'));
    }
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransportError(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method, sessionId });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new TransportError(`Could not send ${method}: ${error.message}`));
      }
    });
  }

  close() {
    this.#close(new TransportError('Chrome bridge closed'));
  }
}

export class BrowserBridge {
  constructor(options = {}) {
    this.paths = options.paths || instancePaths(options.profileDir || profileDirectory());
    this.profileDir = this.paths.profileDir;
    this.endpointId = null;
    this.connection = null;
    this.connecting = null;
    this.connectController = null;
    this.ownedTabs = new Set();
  }

  async #connected() {
    if (this.connection && !this.connection.closed) return this.connection;
    if (!this.connecting) {
      const controller = new AbortController();
      this.connectController = controller;
      this.connecting = discoverEndpoint(this.profileDir)
        .then(async ({ url, endpointId }) => ({ connection: await CdpConnection.open(url, controller.signal), endpointId }))
        .then(({ connection, endpointId }) => {
          if (controller.signal.aborted) {
            connection.close();
            throw new Error('Chrome bridge connection cancelled');
          }
          if (endpointId !== this.endpointId) this.ownedTabs.clear();
          this.endpointId = endpointId;
          this.connection = connection;
          return connection;
        })
        .finally(() => { this.connecting = null; this.connectController = null; });
    }
    return this.connecting;
  }

  async #send(method, params, sessionId) {
    return (await this.#connected()).send(method, params, sessionId);
  }

  async #binding() {
    await this.#connected();
    let binding;
    try {
      const stat = await lstat(this.paths.binding);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
        throw new Error('unsafe binding file owner, type or permissions');
      }
      binding = JSON.parse(await readFile(this.paths.binding, 'utf8'));
    } catch (error) {
      throw new Error(`PROFILE_NOT_BOUND: run browserctl bind (or browserctl tabs --all, then browserctl bind <tabId>) to choose your Chrome profile. (${error.message})`, { cause: error });
    }
    if (binding.endpointId !== this.endpointId) {
      throw new Error('PROFILE_BINDING_EXPIRED: Chrome restarted or changed its debugging session. Run browserctl bind again.');
    }
    if (binding.contextId !== null && (typeof binding.contextId !== 'string' || !/^[A-F0-9]{8,}$/i.test(binding.contextId))) {
      throw new Error('Invalid browser profile binding');
    }
    return binding;
  }

  async bind(tabId) {
    return this.#mutate(async () => {
      const all = await this.tabsAll();
      let anchor;
      if (tabId === undefined) {
        const contexts = Map.groupBy(all, tab => tab.contextId);
        if (contexts.size === 0) throw new Error('NO_WEB_TABS: open any http: or https: page in the Chrome profile you want to bind');
        if (contexts.size > 1) {
          const summary = [...contexts.values()].map(tabs => `${tabs.length} tab(s), e.g. ${tabs[0].tabId} "${tabs[0].title}"`).join('; ');
          throw new Error(`AMBIGUOUS_PROFILE: ${contexts.size} Chrome profiles have open web tabs (${summary}). Run browserctl bind <tabId> with a tab from the profile you want.`);
        }
        anchor = all[0];
      } else {
        anchor = matchTab(tabId, all);
      }
      await ensurePrivateDirectory(this.paths.dir);
      const binding = { endpointId: this.endpointId, contextId: anchor.contextId, anchorTabId: anchor.tabId };
      const tempPath = join(this.paths.dir, `binding-${randomUUID()}.json`);
      try {
        await writeFile(tempPath, JSON.stringify(binding), { mode: 0o600, flag: 'wx' });
        await rename(tempPath, this.paths.binding);
      } finally {
        await rm(tempPath, { force: true });
      }
      return { bound: true, contextId: binding.contextId, anchorTabId: anchor.tabId, anchorTitle: anchor.title };
    });
  }

  async unbind() {
    return this.#mutate(async () => {
      await rm(this.paths.binding, { force: true });
      return { bound: false };
    });
  }

  async #mutate(action) {
    await this.#connected();
    const release = await acquireMutationLock(this.paths.locks);
    try {
      return await action();
    } catch (error) {
      if (error instanceof TransportError) {
        throw new Error(`OUTCOME_UNKNOWN: Chrome may have applied part or all of this action. Read a new snapshot before deciding whether to retry. ${error.message}`, { cause: error });
      }
      throw error;
    } finally {
      await release();
    }
  }

  async status() {
    try {
      const version = await this.#send('Browser.getVersion');
      const base = { connected: true, product: version.product, protocolVersion: version.protocolVersion, profileDir: this.profileDir };
      try {
        const binding = await this.#binding();
        return { ...base, bound: true, contextId: binding.contextId, anchorTabId: binding.anchorTabId };
      } catch (error) {
        return { ...base, bound: false, reason: error.message };
      }
    } catch (error) {
      return { connected: false, bound: false, profileDir: this.profileDir, reason: error.message };
    }
  }

  async tabsAll() {
    const { targetInfos } = await this.#send('Target.getTargets');
    const pages = targetInfos.filter(target => target.type === 'page' && isWebUrl(target.url));
    if (pages.length > 500) throw new Error('TOO_MANY_TABS: refusing to return an unbounded tab list');
    return pages.map(({ targetId, title, url, browserContextId }) => ({ tabId: targetId, title, url, contextId: browserContextId || null }));
  }

  async tabs() {
    const binding = await this.#binding();
    return (await this.tabsAll()).filter(tab => tab.contextId === binding.contextId)
      .map(({ tabId, title, url }) => ({ tabId, title, url }));
  }

  // Resolves a full ID or unique prefix to a web tab in the bound profile.
  async #allowedTab(tabId) {
    const wanted = validateTabId(tabId);
    const binding = await this.#binding();
    const targetId = wanted.length >= 32 ? wanted : matchTab(wanted, await this.tabs()).tabId;
    let targetInfo;
    try {
      ({ targetInfo } = await this.#send('Target.getTargetInfo', { targetId }));
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new Error(`TAB_NOT_FOUND: no open tab has the ID ${tabId}`, { cause: error });
    }
    if (targetInfo.type !== 'page' || !isWebUrl(targetInfo.url) || (targetInfo.browserContextId || null) !== binding.contextId) {
      throw new Error('TAB_NOT_ALLOWED: this tab is not an http: or https: page in the bound profile');
    }
    return targetInfo;
  }

  async open(input) {
    const url = validateUrl(input);
    return this.#mutate(async () => {
      const binding = await this.#binding();
      const params = binding.contextId ? { url, browserContextId: binding.contextId } : { url };
      const { targetId } = await this.#send('Target.createTarget', params);
      this.ownedTabs.add(targetId);
      await this.#send('Target.activateTarget', { targetId });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { targetInfo } = await this.#send('Target.getTargetInfo', { targetId });
        if (isWebUrl(targetInfo.url)) return { tabId: targetId, url: targetInfo.url, targetUrlObserved: true };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { tabId: targetId, requestedUrl: url, targetUrlObserved: false };
    });
  }

  async activate(tabId) {
    return this.#mutate(async () => {
      const { targetId } = await this.#allowedTab(tabId);
      await this.#send('Target.activateTarget', { targetId });
      return { tabId: targetId, activated: true };
    });
  }

  async closeTab(tabId) {
    return this.#mutate(async () => {
      const { targetId } = await this.#allowedTab(tabId);
      if (!this.ownedTabs.has(targetId)) {
        throw new Error('TAB_NOT_OWNED: only tabs opened through browserctl since the broker started can be closed');
      }
      await this.#send('Target.closeTarget', { targetId });
      this.ownedTabs.delete(targetId);
      return { tabId: targetId, closed: true };
    });
  }

  async #withPage(tabId, action) {
    const targetInfo = await this.#allowedTab(tabId);
    const connection = await this.#connected();
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
    const send = (method, params = {}) => connection.send(method, params, sessionId);
    try {
      return await action(send, targetInfo);
    } finally {
      await connection.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  async navigate(tabId, input) {
    const url = validateUrl(input);
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      const result = await send('Page.navigate', { url });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { frameTree } = await send('Page.getFrameTree');
        const frame = frameTree?.frame;
        if (isWebUrl(frame?.url) && (result.loaderId ? frame.loaderId === result.loaderId : frame.url === url)) {
          return { tabId: targetId, url: frame.url, navigationCommitted: true };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('OUTCOME_UNKNOWN: navigation started but did not commit within 10 seconds; inspect the tab before retrying');
    }));
  }

  async #documentToken(send) {
    const { frameTree } = await send('Page.getFrameTree');
    const frame = frameTree?.frame;
    if (!frame?.id) throw new Error('Could not identify the current document');
    if (!isWebUrl(frame.url)) throw new Error('TAB_NOT_ALLOWED: the main frame is no longer an http: or https: page');
    const urlDigest = createHash('sha256').update(frame.url).digest('hex').slice(0, 16);
    return `${frame.id}:${frame.loaderId || ''}:${urlDigest}`;
  }

  // Confirms that the element a ref names is still in the same document with the same role and name.
  async #assertCurrent(send, ref) {
    const backendNodeId = parseRef(ref);
    const documentToken = await this.#documentToken(send);
    let nodes;
    try {
      ({ nodes } = await send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false }));
    } catch {
      throw new Error('STALE_REF: the element is no longer in the page; read a new snapshot');
    }
    const current = nodes.some(node => node.backendDOMNodeId === backendNodeId && !node.ignored && elementRef(documentToken, node) === ref);
    if (!current) throw new Error('STALE_REF: the page navigated or the element changed since the snapshot; read a new snapshot');
    return backendNodeId;
  }

  async snapshot(tabId, options = {}) {
    const { query, interactive = false } = options;
    if (query !== undefined && (typeof query !== 'string' || query.length > 200)) {
      throw new Error('snapshot query must be a string of at most 200 characters');
    }
    if (typeof interactive !== 'boolean') throw new Error('snapshot interactive must be a boolean');
    return this.#withPage(tabId, async (send, { targetId }) => {
      await send('Accessibility.enable');
      const deadline = Date.now() + SNAPSHOT_WAIT_MS;
      let documentToken;
      let nodes;
      let readyState = 'loading';
      let completeAt;
      while (true) {
        nodes = undefined;
        readyState = 'loading';
        try {
          const before = await this.#documentToken(send);
          ({ nodes } = await send('Accessibility.getFullAXTree'));
          const after = await this.#documentToken(send);
          if (before !== after) throw new Error('Document changed while reading its accessibility tree');
          if (documentToken && documentToken !== after) completeAt = undefined;
          documentToken = after;
          const evaluated = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          readyState = evaluated.result?.value || 'loading';
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
          continue;
        }
        if (readyState === 'complete') completeAt ??= Date.now();
        if (nodes?.length > 1 && readyState !== 'loading') break;
        if (completeAt && Date.now() - completeAt > 2_000) break;
        if (Date.now() >= deadline) throw new Error('PAGE_NOT_READY: Chrome did not finish loading a readable page');
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const byId = new Map(nodes.map(node => [node.nodeId, node]));
      const needle = query?.toLowerCase();
      const matched = [];
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = node.role?.value || '';
        const name = String(node.name?.value ?? '');
        const value = node.value?.value;
        if (role === 'none' || role === 'RootWebArea' || role === 'InlineTextBox') continue;
        if (!name && (value === undefined || value === '') && !INTERACTIVE_ROLES.has(role)) continue;
        // Static text usually repeats the accessible name of the link or heading that contains it.
        if (role === 'StaticText' && byId.get(node.parentId)?.name?.value === name) continue;
        if (interactive && !INTERACTIVE_ROLES.has(role)) continue;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        matched.push(node);
      }
      const limit = query ? QUERY_LIMIT : SNAPSHOT_LIMIT;
      const entries = matched.slice(0, limit).map(node => {
        const entry = {
          ref: node.backendDOMNodeId ? elementRef(documentToken, node) : null,
          role: node.role?.value || '',
          name: String(node.name?.value ?? '').slice(0, 300),
        };
        if (node.value?.value !== undefined && node.value.value !== '') entry.value = String(node.value.value).slice(0, 300);
        const states = nodeStates(node);
        if (states.length) entry.states = states;
        return entry;
      });
      const { targetInfo } = await this.#send('Target.getTargetInfo', { targetId });
      return {
        tabId: targetId, url: targetInfo.url, title: targetInfo.title, readyState,
        query: query || null, interactive, totalMatches: matched.length, truncated: matched.length > limit, nodes: entries,
      };
    });
  }

  async text(tabId, options = {}) {
    const { offset = 0, limit = 20_000 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('text offset must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_TEXT) throw new Error(`text limit must be an integer from 1 to ${MAX_PAGE_TEXT}`);
    return this.#withPage(tabId, async (send, { targetId, url, title }) => {
      await this.#documentToken(send);
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: `(() => { const t = document.body ? document.body.innerText : ''; return [t.length, t.slice(${offset}, ${offset + limit})]; })()`,
        returnByValue: true,
      });
      if (exceptionDetails || !Array.isArray(result?.value)) throw new Error('Could not read the page text');
      // The page's own scripts can tamper with what it returns, so the bounds are enforced again here.
      const text = String(result.value[1] ?? '').slice(0, limit);
      const totalLength = Number.isSafeInteger(result.value[0]) && result.value[0] >= offset + text.length ? result.value[0] : offset + text.length;
      return { tabId: targetId, url, title, offset, totalLength, truncated: offset + text.length < totalLength, text };
    });
  }

  // Runs a fixed function with `this` bound to the element, and always releases the remote object.
  async #onElement(send, backendNodeId, functionDeclaration, args = []) {
    const { object } = await send('DOM.resolveNode', { backendNodeId });
    try {
      const { result, exceptionDetails } = await send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration, arguments: args, returnByValue: true,
      });
      if (exceptionDetails) throw new Error('The page rejected an element check');
      return result.value;
    } finally {
      await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }

  async #clickWith(send, backendNodeId) {
    await send('DOM.enable');
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    const { model } = await send('DOM.getBoxModel', { backendNodeId });
    const quad = model.content || model.border;
    if (!quad || quad.length !== 8) throw new Error('The element has no clickable box');
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // The click goes to whatever is on top at (x, y), so refuse if that is not the element or something inside it.
    const hit = await send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: true });
    if (hit.backendNodeId !== backendNodeId) {
      const { object } = await send('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
      try {
        const inside = await this.#onElement(send, backendNodeId, CONTAINS, [{ objectId: object.objectId }]);
        if (!inside) throw new Error('TARGET_OBSCURED: another element covers this one; dismiss it or scroll, then take a new snapshot');
      } finally {
        await send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      }
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { x, y };
  }

  async #pressWith(send, name) {
    const [key, code, windowsVirtualKeyCode, text] = KEYS[name];
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode, ...(text && { text }) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  }

  async click(tabId, ref) {
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      const backendNodeId = await this.#assertCurrent(send, ref);
      await this.#clickWith(send, backendNodeId);
      return { tabId: targetId, ref, dispatched: true };
    }));
  }

  async fill(tabId, ref, text) {
    if (typeof text !== 'string') throw new Error('text must be a string');
    if (text.length > MAX_TEXT_LENGTH) throw new Error(`TEXT_TOO_LARGE: maximum ${MAX_TEXT_LENGTH} characters`);
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      const backendNodeId = await this.#assertCurrent(send, ref);
      const { node } = await send('DOM.describeNode', { backendNodeId });
      const attributes = Object.fromEntries(Array.from({ length: (node.attributes || []).length / 2 }, (_, i) => [node.attributes[2 * i].toLowerCase(), node.attributes[2 * i + 1]]));
      const type = (attributes.type || 'text').toLowerCase();
      const editable = (node.nodeName === 'INPUT' && !NON_TEXT_INPUTS.has(type)) || node.nodeName === 'TEXTAREA' ||
        (Object.hasOwn(attributes, 'contenteditable') && attributes.contenteditable.toLowerCase() !== 'false');
      if (!editable) throw new Error('fill supports text inputs, textareas, and contenteditable elements; use click or select for other controls');
      const autocomplete = (attributes.autocomplete || '').toLowerCase().split(/\s+/);
      if (type === 'password' || autocomplete.some(value => /^(current-password|new-password|one-time-code|cc-)/.test(value))) {
        throw new Error('SENSITIVE_FIELD_DENIED: credential or payment input');
      }
      await this.#clickWith(send, backendNodeId);
      const focus = await this.#onElement(send, backendNodeId, FOCUS_CHECK);
      if (focus === 'SENSITIVE') throw new Error('SENSITIVE_FIELD_DENIED: focus moved to a credential or payment input; the click was sent, nothing was typed');
      if (focus !== 'OK') throw new Error('FOCUS_MOVED: the element did not keep focus after the click; the click was sent, nothing was typed');
      // The explicit selectAll command is what makes the shortcut work on macOS, where Chrome ignores a synthetic Cmd+A.
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: SELECT_ALL_MODIFIER, commands: ['selectAll'] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: SELECT_ALL_MODIFIER });
      if (text === '') await this.#pressWith(send, 'Backspace');
      else await send('Input.insertText', { text });
      return { tabId: targetId, ref, dispatched: true, length: text.length };
    }));
  }

  async press(tabId, ref, key) {
    if (!Object.hasOwn(KEYS, key)) throw new Error(`Unsupported key: ${key}. Supported: ${Object.keys(KEYS).join(', ')}`);
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      const backendNodeId = await this.#assertCurrent(send, ref);
      await send('DOM.focus', { backendNodeId });
      await this.#pressWith(send, key);
      return { tabId: targetId, ref, key, dispatched: true };
    }));
  }

  async select(tabId, ref, option) {
    if (typeof option !== 'string' || option.length === 0 || option.length > 500) throw new Error('option must be a non-empty string');
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      const backendNodeId = await this.#assertCurrent(send, ref);
      const outcome = await this.#onElement(send, backendNodeId, SELECT_OPTION, [{ value: option }]);
      if (outcome.error) {
        throw new Error(outcome.options ? `${outcome.error}: available options are ${JSON.stringify(outcome.options)}` : outcome.error);
      }
      return { tabId: targetId, ref, selected: outcome.value, label: outcome.label };
    }));
  }

  async scroll(tabId, direction) {
    if (direction !== 'up' && direction !== 'down') throw new Error('direction must be "up" or "down"');
    return this.#mutate(() => this.#withPage(tabId, async (send, { targetId }) => {
      await this.#documentToken(send);
      const { cssVisualViewport: viewport } = await send('Page.getLayoutMetrics');
      const deltaY = Math.round(viewport.clientHeight * 0.8) * (direction === 'down' ? 1 : -1);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: viewport.clientWidth / 2, y: viewport.clientHeight / 2, deltaX: 0, deltaY });
      await new Promise(resolve => setTimeout(resolve, 250));
      const after = (await send('Page.getLayoutMetrics')).cssVisualViewport;
      return { tabId: targetId, direction, dispatched: true, scrollY: Math.round(after.pageY), moved: Math.round(after.pageY) !== Math.round(viewport.pageY) };
    }));
  }

  async screenshot(tabId) {
    return this.#withPage(tabId, async send => {
      await this.#documentToken(send);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) {
        throw new Error(`SCREENSHOT_TOO_LARGE: maximum ${MAX_SCREENSHOT_BYTES} bytes`);
      }
      return { data, mimeType: 'image/png' };
    });
  }

  close() {
    this.connectController?.abort();
    this.connection?.close();
    this.connection = null;
  }
}

export async function connectBrowser(options) {
  return new BrowserBridge(options);
}
