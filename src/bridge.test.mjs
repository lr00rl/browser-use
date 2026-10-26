import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { acquireMutationLock, connectBrowser, validateUrl } from './bridge.mjs';
import { instancePaths } from './paths.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/browserctl.mjs', import.meta.url));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const candidate of candidates) {
    if (isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (dir && existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  return null;
}

const CHROME = findChrome();

const FIXTURE = `<!doctype html><title>Bridge Fixture</title>
<label>Message <input id="message" value="old text"></label>
<label>Password <input type="password" id="password" value="fixture-secret-value"></label>
<label>Subscribe <input type="checkbox" id="subscribe" checked></label>
<label>Size <select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
<div id="notes" contenteditable="true" role="textbox" aria-label="Notes">draft</div>
<form id="search"><label>Search <input id="q"></label></form>
<label>Code <input id="code"></label>
<div style="position: relative; display: inline-block"><button id="covered">Covered action</button><div style="position: absolute; inset: 0"></div></div>
<button id="save">Save</button><button id="switch">Switch</button><button id="route">Route</button>
<output id="result"></output>
<div style="height: 3000px">Tall content</div><p>Footer text</p>
<script>
  const $ = selector => document.querySelector(selector);
  let formState = $('#message').value;
  $('#message').oninput = event => { formState = event.target.value; };
  $('#message').onkeydown = event => { if (event.key === 'Escape') $('#result').textContent = 'ESCAPED'; };
  $('#save').onclick = () => { $('#result').textContent = 'SAVED:' + formState; };
  $('#switch').onclick = () => {
    $('#save').textContent = 'Delete data';
    $('#save').onclick = () => { $('#result').textContent = 'DELETED'; };
  };
  $('#route').onclick = () => history.pushState({}, '', '?route=other');
  $('#search').onsubmit = event => { event.preventDefault(); $('#result').textContent = 'SUBMITTED:' + $('#q').value; };
  $('#size').onchange = () => { $('#result').textContent = 'SIZE:' + $('#size').value; };
  $('#code').onfocus = () => $('#password').focus();
  $('#covered').onclick = () => { $('#result').textContent = 'COVERED-CLICKED'; };
</script>`;

// Minimal raw CDP client, used only to create a second browser context for the ambiguity test.
async function rawCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, message => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}

test('rejects non-web navigation schemes', () => {
  assert.throws(() => validateUrl('javascript:alert(1)'), /Only http/);
  assert.throws(() => validateUrl('file:///tmp/example'), /Only http/);
});

test('prevents competing writers and releases the lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bctl-lock-'));
  try {
    const release = await acquireMutationLock(root);
    await assert.rejects(acquireMutationLock(root), /CONTROLLER_BUSY/);
    await release();
    const releaseAgain = await acquireMutationLock(root);
    await releaseAgain();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers a writer lock left by a dead process', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'bctl-lock-child-'));
  const moduleUrl = new URL('./bridge.mjs', import.meta.url).href;
  const code = `const {acquireMutationLock}=await import(${JSON.stringify(moduleUrl)});await acquireMutationLock(${JSON.stringify(root)});console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not acquire the lock')), 5_000);
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('ready')) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`child exited early: ${code}`)); });
    });
    await assert.rejects(acquireMutationLock(root), /CONTROLLER_BUSY/);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const release = await acquireMutationLock(root);
    await release();
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('controls a real Chrome target through the CDP bridge', { timeout: 90_000, skip: CHROME ? false : 'no Chrome found; set CHROME_PATH' }, async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'bctl-profile-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'bctl-state-'));
  const paths = instancePaths(profileDir, stateDir);
  const server = createServer((request, response) => {
    const reply = () => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FIXTURE);
    };
    if (request.url.startsWith('/slow')) setTimeout(reply, 3_000);
    else reply();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const chromeArgs = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
  if (process.platform === 'linux' && process.env.CI) chromeArgs.push('--no-sandbox');
  const chrome = spawn(CHROME, [...chromeArgs, origin], { stdio: 'ignore' });
  const cliEnv = { ...process.env, BROWSERCTL_PROFILE_DIR: profileDir, BROWSERCTL_STATE_DIR: stateDir };
  const cli = async (...args) => JSON.parse((await execFileAsync(process.execPath, [CLI, ...args], { env: cliEnv })).stdout);
  let bridge;
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(join(profileDir, 'DevToolsActivePort')); attempt++) await delay(100);
    bridge = await connectBrowser({ paths });
    assert.equal((await bridge.status()).connected, true);
    assert.equal((await bridge.status()).bound, false);
    let anchor;
    for (let attempt = 0; attempt < 50 && !anchor; attempt++) {
      anchor = (await bridge.tabsAll()).find(tab => tab.url.startsWith(origin));
      if (!anchor) await delay(100);
    }
    assert.ok(anchor?.tabId);

    await t.test('binds without a tab ID when one profile has web tabs, and refuses when several do', async () => {
      const [port, path] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      const raw = await rawCdp(`ws://127.0.0.1:${port}${path}`);
      try {
        const { browserContextId } = await raw.send('Target.createBrowserContext');
        await raw.send('Target.createTarget', { url: origin, browserContextId });
        for (let attempt = 0; attempt < 50 && new Set((await bridge.tabsAll()).map(tab => tab.contextId)).size < 2; attempt++) await delay(100);
        await assert.rejects(bridge.bind(), /AMBIGUOUS_PROFILE/);
        await raw.send('Target.disposeBrowserContext', { browserContextId });
      } finally {
        raw.close();
      }
      for (let attempt = 0; attempt < 50 && new Set((await bridge.tabsAll()).map(tab => tab.contextId)).size > 1; attempt++) await delay(100);
      const bound = await bridge.bind();
      assert.equal(bound.anchorTabId, anchor.tabId);
      assert.equal((await bridge.status()).bound, true);
    });

    await t.test('expires a binding from an earlier Chrome session', async () => {
      const original = JSON.parse(await readFile(paths.binding, 'utf8'));
      await writeFile(paths.binding, JSON.stringify({ ...original, endpointId: 'expired' }), { mode: 0o600 });
      await assert.rejects(bridge.tabs(), /PROFILE_BINDING_EXPIRED/);
      await bridge.bind(anchor.tabId.slice(0, 8));
      assert.ok((await bridge.tabs()).every(tab => /^https?:/.test(tab.url)));
    });

    const { tabId } = await bridge.open(origin);
    assert.ok((await bridge.tabs()).some(tab => tab.tabId === tabId));

    await t.test('shares one broker daemon across CLI processes and the shell', async () => {
      const first = await cli('status');
      assert.equal(first.connected, true);
      assert.ok(Number.isInteger(first.daemonPid));
      assert.equal((await cli('status')).daemonPid, first.daemonPid);
      assert.ok((await cli('tabs')).some(tab => tab.tabId === tabId));
      const shell = spawn(process.execPath, [CLI, 'shell'], { env: cliEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      shell.stdout.on('data', chunk => { output += chunk; });
      const exited = new Promise((resolve, reject) => shell.on('exit', code => code === 0 ? resolve() : reject(new Error(`CLI shell exited ${code}`))));
      shell.stdin.end('["status"]\n["tabs"]\n["exit"]\n');
      await exited;
      const results = output.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(results[0].result.daemonPid, first.daemonPid);
      assert.ok(results[1].result.some(tab => tab.tabId === tabId));
    });

    let snapshot;
    for (let attempt = 0; attempt < 30; attempt++) {
      snapshot = await bridge.snapshot(tabId);
      if (snapshot.nodes.some(node => node.name === 'Save')) break;
      await delay(100);
    }
    const find = (role, name, from = snapshot) => {
      const node = from.nodes.find(item => item.role === role && item.name === name);
      assert.ok(node?.ref, `${role} "${name}" missing from ${JSON.stringify(from.nodes)}`);
      return node;
    };
    const resultText = async () => (await bridge.text(tabId)).text;

    await t.test('reports values and states without leaking password values', () => {
      assert.match(find('textbox', 'Message').ref, /^e\d+-[0-9a-f]{8}$/);
      assert.equal(find('textbox', 'Message').value, 'old text');
      assert.ok(find('checkbox', 'Subscribe').states.includes('checked'));
      assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-value'));
      assert.equal(snapshot.tabId, tabId);
      assert.equal(snapshot.title, 'Bridge Fixture');
    });

    await t.test('filters by name, by interactivity, and accepts a tab ID prefix', async () => {
      const filtered = await bridge.snapshot(tabId.slice(0, 6), { query: 'save' });
      assert.equal(filtered.tabId, tabId);
      assert.ok(filtered.nodes.length > 0 && filtered.nodes.every(node => node.name.toLowerCase().includes('save')));
      const interactive = await bridge.snapshot(tabId, { interactive: true });
      assert.ok(interactive.nodes.some(node => node.name === 'Save'));
      assert.ok(!interactive.nodes.some(node => node.name === 'Footer text'));
    });

    await t.test('replaces an existing value instead of appending to it', async () => {
      await bridge.fill(tabId, find('textbox', 'Message').ref, 'new text');
      await bridge.click(tabId, find('button', 'Save').ref);
      assert.match(await resultText(), /SAVED:new text/);
      const after = await bridge.snapshot(tabId, { query: 'Message' });
      assert.equal(find('textbox', 'Message', after).value, 'new text');
    });

    await t.test('submits a form when Enter is pressed in its input', async () => {
      snapshot = await bridge.snapshot(tabId);
      await bridge.fill(tabId, find('textbox', 'Search').ref, 'cats');
      await bridge.press(tabId, find('textbox', 'Search').ref, 'Enter');
      assert.match(await resultText(), /SUBMITTED:cats/);
    });

    await t.test('fills contenteditable elements and refuses password fields', async () => {
      snapshot = await bridge.snapshot(tabId);
      await bridge.fill(tabId, find('textbox', 'Notes').ref, 'final notes');
      assert.match(await resultText(), /final notes/);
      assert.doesNotMatch(await resultText(), /draft/);
      await assert.rejects(bridge.fill(tabId, find('textbox', 'Password').ref, 'do not enter'), /SENSITIVE_FIELD_DENIED/);
    });

    await t.test('refuses to click an element covered by another one', async () => {
      snapshot = await bridge.snapshot(tabId);
      await assert.rejects(bridge.click(tabId, find('button', 'Covered action').ref), /TARGET_OBSCURED/);
      assert.doesNotMatch(await resultText(), /COVERED-CLICKED/);
    });

    await t.test('types nothing when the page moves focus to another field', async () => {
      snapshot = await bridge.snapshot(tabId);
      await assert.rejects(bridge.fill(tabId, find('textbox', 'Code').ref, 'typed elsewhere'), /FOCUS_MOVED/);
    });

    await t.test('selects a native option by label', async () => {
      snapshot = await bridge.snapshot(tabId);
      const result = await bridge.select(tabId, find('combobox', 'Size').ref, 'Large');
      assert.equal(result.selected, 'l');
      assert.match(await resultText(), /SIZE:l/);
      await assert.rejects(bridge.select(tabId, find('combobox', 'Size').ref, 'Huge'), /OPTION_NOT_FOUND/);
    });

    await t.test('presses other keys on a focused element', async () => {
      snapshot = await bridge.snapshot(tabId);
      await bridge.press(tabId, find('textbox', 'Message').ref, 'Escape');
      assert.match(await resultText(), /ESCAPED/);
    });

    await t.test('reads page text in pages', async () => {
      const page = await bridge.text(tabId, { offset: 0, limit: 5 });
      assert.equal(page.text.length, 5);
      assert.equal(page.truncated, true);
      assert.ok(page.totalLength > 5);
    });

    await t.test('scrolls the page', async () => {
      const result = await bridge.scroll(tabId, 'down');
      assert.equal(result.moved, true);
      assert.ok(result.scrollY > 0);
    });

    await t.test('captures a screenshot', async () => {
      const screenshot = await bridge.screenshot(tabId);
      assert.equal(screenshot.mimeType, 'image/png');
      assert.ok(screenshot.data.startsWith('iVBORw0KGgo'));
    });

    await t.test('rejects refs after the element changes, the URL changes, or the page navigates', async () => {
      snapshot = await bridge.snapshot(tabId);
      const oldSave = find('button', 'Save');
      await bridge.click(tabId, find('button', 'Switch').ref);
      await assert.rejects(bridge.click(tabId, oldSave.ref), /STALE_REF/);
      assert.doesNotMatch(await resultText(), /DELETED/);
      snapshot = await bridge.snapshot(tabId);
      const renamed = find('button', 'Delete data');
      await bridge.click(tabId, find('button', 'Route').ref);
      await assert.rejects(bridge.click(tabId, renamed.ref), /STALE_REF/);
      snapshot = await bridge.snapshot(tabId);
      const route = find('button', 'Route');
      await bridge.navigate(tabId, `${origin}?next=1`);
      for (let attempt = 0; attempt < 30 && (await bridge.snapshot(tabId)).url === snapshot.url; attempt++) await delay(100);
      await assert.rejects(bridge.click(tabId, route.ref), /STALE_REF/);
    });

    await t.test('reports a write interrupted by a lost connection as OUTCOME_UNKNOWN', async () => {
      const pending = bridge.navigate(tabId, `${origin}slow`);
      await delay(300);
      bridge.close();
      await assert.rejects(pending, /OUTCOME_UNKNOWN/);
    });

    await t.test('closes only tabs it opened', async () => {
      await assert.rejects(bridge.closeTab(anchor.tabId), /TAB_NOT_OWNED/);
      await bridge.closeTab(tabId);
      for (let attempt = 0; attempt < 30 && (await bridge.tabs()).some(tab => tab.tabId === tabId); attempt++) await delay(100);
      assert.ok(!(await bridge.tabs()).some(tab => tab.tabId === tabId));
    });
  } finally {
    bridge?.close();
    await execFileAsync(process.execPath, [CLI, 'stop'], { env: cliEnv }).catch(() => {});
    chrome.kill('SIGTERM');
    server.close();
    await delay(500);
    await rm(profileDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
