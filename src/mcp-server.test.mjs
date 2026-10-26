import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createMcpRequestHandler, formatSnapshot, runMcpServer, TOOLS } from "./mcp-server.mjs";

function mockBridge(overrides = {}) {
  return {
    status: async () => ({ connected: true }),
    tabs: async () => [{ tabId: "ABCD1234", title: "Example" }],
    open: async (url) => ({ tabId: "ABCD5678", url }),
    navigate: async (tabId, url) => ({ tabId, url }),
    activate: async (tabId) => ({ tabId, activated: true }),
    snapshot: async (tabId) => ({ tabId, title: "Example", url: "https://example.com/", totalMatches: 0, truncated: false, nodes: [] }),
    text: async (tabId, { offset }) => ({ tabId, title: "Example", url: "https://example.com/", offset, totalLength: 10, truncated: false, text: "hello" }),
    click: async (tabId, ref) => ({ tabId, ref, dispatched: true }),
    fill: async (tabId, ref, text) => ({ tabId, ref, text }),
    press: async (tabId, ref, key) => ({ tabId, ref, key }),
    select: async (tabId, ref, option) => ({ tabId, ref, selected: option }),
    scroll: async (tabId, direction) => ({ tabId, direction }),
    closeTab: async (tabId) => ({ tabId, closed: true }),
    screenshot: async () => ({ data: "iVBORw0KGgo=", mimeType: "image/png" }),
    close: async () => {},
    ...overrides,
  };
}

function call(handle, name, args, id = 1) {
  return handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

test("advertises only the bounded browser tools", async () => {
  const handle = createMcpRequestHandler({ connectBrowser: async () => mockBridge() });
  const response = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  assert.deepEqual(
    response.result.tools.map(({ name }) => name),
    [
      "browser_status", "browser_tabs", "browser_open", "browser_navigate", "browser_activate",
      "browser_snapshot", "browser_text", "browser_click", "browser_fill", "browser_press",
      "browser_select", "browser_scroll", "browser_close_tab", "browser_screenshot",
    ],
  );
  assert.equal(response.result.tools, TOOLS);
});

test("negotiates the protocol version and sends agent instructions", async () => {
  const handle = createMcpRequestHandler({ connectBrowser: async () => mockBridge() });
  const known = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(known.result.protocolVersion, "2025-03-26");
  assert.match(known.result.instructions, /untrusted/);
  const unknown = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
});

test("dispatches typed tool arguments and returns JSON text", async () => {
  const calls = [];
  const handle = createMcpRequestHandler({
    connectBrowser: async () => mockBridge({ fill: async (...args) => { calls.push(args); return { ok: true }; } }),
  });

  const response = await call(handle, "browser_fill", { tabId: "ABCD1234", ref: "e4-0123abcd", text: "hello" });

  assert.deepEqual(calls, [["ABCD1234", "e4-0123abcd", "hello"]]);
  assert.deepEqual(response.result, { content: [{ type: "text", text: '{"ok":true}' }] });
});

test("passes snapshot options and returns one line per element", async () => {
  let options;
  const handle = createMcpRequestHandler({
    connectBrowser: async () => mockBridge({
      snapshot: async (tabId, received) => {
        options = received;
        return {
          tabId, title: "Example", url: "https://example.com/", totalMatches: 3, truncated: true,
          nodes: [
            { ref: "e7-0123abcd", role: "textbox", name: "Query", value: "cats", states: ["focused"] },
            { ref: null, role: "heading", name: "Results" },
          ],
        };
      },
    }),
  });
  const response = await call(handle, "browser_snapshot", { tabId: "ABCD1234", interactive: true });
  assert.deepEqual(options, { query: undefined, interactive: true });
  const lines = response.result.content[0].text.split("\n");
  assert.match(lines[2], /2 of 3 \(truncated/);
  assert.equal(lines[3], '[e7-0123abcd] textbox "Query" value="cats" (focused)');
  assert.equal(lines[4], 'heading "Results"');
});

test("formats page text with a continuation offset", async () => {
  const handle = createMcpRequestHandler({
    connectBrowser: async () => mockBridge({
      text: async (tabId, { offset, limit }) => ({ tabId, title: "T", url: "https://example.com/", offset, totalLength: 100, truncated: true, text: "x".repeat(limit) }),
    }),
  });
  const response = await call(handle, "browser_text", { tabId: "ABCD1234", offset: 10, limit: 20 });
  assert.match(response.result.content[0].text, /Characters 10-30 of 100 \(continue with offset 30\)/);
});

test("returns screenshots as MCP image content", async () => {
  const handle = createMcpRequestHandler({ connectBrowser: async () => mockBridge() });
  const response = await call(handle, "browser_screenshot", { tabId: "ABCD1234" });
  assert.deepEqual(response.result, { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] });
});

test("rejects missing, mistyped, out-of-range, and extra tool arguments", async () => {
  const handle = createMcpRequestHandler({ connectBrowser: async () => mockBridge() });
  const cases = [
    ["browser_click", { tabId: "ABCD1234" }],
    ["browser_click", { tabId: "ABCD1234", ref: 3 }],
    ["browser_click", { tabId: "ABCD1234", ref: "e1-0123abcd", extra: true }],
    ["browser_click", { tabId: "AB", ref: "e1-0123abcd" }],
    ["browser_press", { tabId: "ABCD1234", ref: "e1-0123abcd", key: "F13" }],
    ["browser_scroll", { tabId: "ABCD1234", direction: "left" }],
    ["browser_snapshot", { tabId: "ABCD1234", interactive: "yes" }],
    ["browser_text", { tabId: "ABCD1234", limit: 50001 }],
    ["browser_text", { tabId: "ABCD1234", offset: 1.5 }],
  ];
  for (const [name, args] of cases) {
    const response = await call(handle, name, args);
    assert.equal(response.error?.code, -32602, `${name} ${JSON.stringify(args)}`);
  }
});

test("surfaces bridge failures as tool errors", async () => {
  const handle = createMcpRequestHandler({
    connectBrowser: async () => mockBridge({ click: async () => { throw new Error("Chrome target disappeared"); } }),
  });
  const response = await call(handle, "browser_click", { tabId: "ABCD1234", ref: "e2-0123abcd" });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Chrome target disappeared/);
});

test("does not execute a tool call notification without an id", async () => {
  let clickCalls = 0;
  const handle = createMcpRequestHandler({
    connectBrowser: async () => mockBridge({ click: async () => { clickCalls++; return {}; } }),
  });
  const response = await handle({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "browser_click", arguments: { tabId: "ABCD1234", ref: "e2-0123abcd" } },
  });
  assert.equal(response, undefined);
  assert.equal(clickCalls, 0);
});

test("formats an empty snapshot", () => {
  const text = formatSnapshot({ tabId: "ABCD1234", title: "Blank", url: "https://example.com/", totalMatches: 0, truncated: false, nodes: [] });
  assert.equal(text, "Tab ABCD1234: Blank\nURL: https://example.com/\nElements: 0 of 0");
});

test("stdio runner uses newline-delimited JSON-RPC and closes the bridge", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  let written = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { written += chunk; });

  const running = runMcpServer({
    input,
    output,
    connectBrowser: async () => mockBridge({ close: async () => { closed = true; } }),
  });
  input.end(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' +
      '{not json}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_status","arguments":{}}}\n',
  );
  await running;

  const responses = written.trim().split("\n").map(JSON.parse);
  assert.deepEqual(responses[0], { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(responses[1].error.code, -32700);
  assert.deepEqual(responses[2].result.content, [{ type: "text", text: '{"connected":true}' }]);
  assert.equal(closed, true);
});
