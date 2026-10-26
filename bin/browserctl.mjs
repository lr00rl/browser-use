#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { connectBroker } from '../src/broker-client.mjs';
import { formatSnapshot } from '../src/mcp-server.mjs';

const USAGE = `Usage:
  browserctl status | start | stop
  browserctl tabs [--all]
  browserctl bind [tab]
  browserctl unbind
  browserctl open <url>
  browserctl activate <tab>
  browserctl navigate <tab> <url>
  browserctl snapshot <tab> [query] [--interactive|-i] [--text]
  browserctl text <tab> [offset] [limit]
  browserctl click <tab> <ref>
  browserctl fill <tab> <ref> <text|->
  browserctl press <tab> <ref> <key>
  browserctl select <tab> <ref> <option>
  browserctl scroll <tab> <up|down>
  browserctl close <tab>
  browserctl screenshot <tab> <output.png>
  browserctl shell
  browserctl mcp

<tab> is a tab ID from "tabs" or "open", or a unique prefix of at least 4 characters.
<ref> comes from the latest snapshot of that tab, for example e123-ab12cd34.
Pass - as the fill text to read it from stdin instead of argv.
"mcp" serves the same tools to an agent over MCP stdio.

Chrome must allow debugging first: open chrome://inspect/#remote-debugging in the
running browser and enable "Allow remote debugging for this browser instance".
Environment: BROWSERCTL_CHANNEL (stable, beta, dev, canary), BROWSERCTL_PROFILE_DIR,
BROWSERCTL_STATE_DIR.`;

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 100_000) throw new Error('TEXT_TOO_LARGE: maximum 100000 characters');
  }
  return text;
}

function exitCode(error) {
  if (/OUTCOME_UNKNOWN/.test(error.message)) return 6;
  if (/STALE_/.test(error.message)) return 5;
  if (/CONTROLLER_BUSY/.test(error.message)) return 4;
  if (/PROFILE_NOT_BOUND|PROFILE_BINDING_EXPIRED|AMBIGUOUS_PROFILE|NO_WEB_TABS|TAB_NOT_|AMBIGUOUS_TAB/.test(error.message)) return 3;
  if (/CHROME_NOT_ENABLED|connection|approval/i.test(error.message)) return 2;
  return 1;
}

function usageError() {
  return Object.assign(new Error(USAGE), { usage: true });
}

function integer(value, name) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

// Positional argument counts per command. Flags are only recognized for the commands that accept them.
const ARGS = {
  status: [0], start: [0], stop: [0], tabs: [0], bind: [0, 1], unbind: [0], open: [1], activate: [1],
  navigate: [2], snapshot: [1, 2], text: [1, 2, 3], click: [2], fill: [3], press: [3], select: [3],
  scroll: [2], close: [1], screenshot: [2],
};
const FLAGS = { tabs: ['--all'], snapshot: ['--interactive', '-i', '--text'] };

async function run(argv, browser) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(ARGS, command)) throw usageError();
  const accepted = FLAGS[command] || [];
  const flags = new Set(rest.filter(arg => accepted.includes(arg)));
  const args = rest.filter(arg => !accepted.includes(arg));
  if (!ARGS[command].includes(args.length)) throw usageError();
  switch (command) {
    case 'status':
    case 'start': return browser.status();
    case 'stop': return browser.shutdown();
    case 'tabs': return flags.has('--all') ? browser.tabsAll() : browser.tabs();
    case 'bind': return browser.bind(args[0]);
    case 'unbind': return browser.unbind();
    case 'open': return browser.open(args[0]);
    case 'activate': return browser.activate(args[0]);
    case 'navigate': return browser.navigate(args[0], args[1]);
    case 'snapshot': {
      const snapshot = await browser.snapshot(args[0], { query: args[1], interactive: flags.has('--interactive') || flags.has('-i') });
      return flags.has('--text') ? formatSnapshot(snapshot) : snapshot;
    }
    case 'text': return browser.text(args[0], {
      offset: args[1] === undefined ? 0 : integer(args[1], 'offset'),
      limit: args[2] === undefined ? 20_000 : integer(args[2], 'limit'),
    });
    case 'click': return browser.click(args[0], args[1]);
    case 'fill': return browser.fill(args[0], args[1], args[2] === '-' ? await readStdin() : args[2]);
    case 'press': return browser.press(args[0], args[1], args[2]);
    case 'select': return browser.select(args[0], args[1], args[2]);
    case 'scroll': return browser.scroll(args[0], args[1]);
    case 'close': return browser.closeTab(args[0]);
    case 'screenshot': {
      const { data } = await browser.screenshot(args[0]);
      await writeFile(args[1], Buffer.from(data, 'base64'), { flag: 'wx' });
      return { tabId: args[0], path: args[1], saved: true };
    }
  }
}

function print(result) {
  process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
}

function parseShellLine(line) {
  if (line.trim().startsWith('[')) {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed) || !parsed.every(part => typeof part === 'string')) {
      throw new Error('A JSON command must be an array of strings');
    }
    return parsed;
  }
  return (line.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) || [])
    .map(part => part.startsWith('"') ? JSON.parse(part) : part.startsWith("'") ? part.slice(1, -1) : part);
}

async function runShell(browser) {
  const lines = createInterface({ input: process.stdin, terminal: Boolean(process.stdin.isTTY) });
  if (process.stdin.isTTY) {
    process.stderr.write('One broker connection for this shell. Type help or exit.\n');
    lines.setPrompt('browserctl> ');
    lines.prompt();
  }
  for await (const line of lines) {
    try {
      const args = parseShellLine(line);
      if (args.length === 0) continue;
      if (args[0] === 'exit' || args[0] === 'quit') break;
      if (args[0] === 'help') {
        process.stderr.write(`${USAGE}\n`);
        continue;
      }
      if (args[0] === 'fill' && args[3] === '-') throw new Error('Use quoted text or a JSON command array inside shell');
      const result = await run(args, browser);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, code: exitCode(error), error: error.message })}\n`);
    } finally {
      if (process.stdin.isTTY) lines.prompt();
    }
  }
}

const command = process.argv[2];
if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`);
} else if (command === 'mcp') {
  const { runMcpServer } = await import('../src/mcp-server.mjs');
  await runMcpServer();
} else {
  let browser;
  try {
    browser = await connectBroker({ autoStart: command !== 'stop' });
    if (command === 'shell') {
      await runShell(browser);
    } else {
      const result = await run(process.argv.slice(2), browser);
      print(result);
      if (command === 'status' || command === 'start') {
        if (!result.connected) process.exitCode = 2;
        else if (!result.bound) process.exitCode = 3;
      }
    }
  } catch (error) {
    if (error.usage) {
      process.exitCode = 64;
      process.stderr.write(`${USAGE}\n`);
    } else {
      process.exitCode = exitCode(error);
      process.stderr.write(`${JSON.stringify({ code: process.exitCode, error: error.message })}\n`);
    }
  } finally {
    browser?.close();
  }
}
