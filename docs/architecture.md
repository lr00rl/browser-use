# Architecture

This document explains how `browserctl` reaches the Chrome you already have open, what each part is responsible for, and which trade-offs were made on purpose.

## Connection chain

```text
Your running Chrome (144+)
  you enable chrome://inspect/#remote-debugging and approve the connection
  Chrome writes DevToolsActivePort into its user data directory
        |  WebSocket on 127.0.0.1, opened by Chrome, approved once
src/broker-server.mjs   long-lived broker; owns the only CDP connection (src/bridge.mjs)
        |  Unix socket, mode 0600, inside a 0700 state directory
        +-- bin/browserctl.mjs     the CLI, one short-lived client per command
        +-- src/broker-client.mjs  the Node API for scripts
        +-- src/mcp-server.mjs     MCP stdio server for agents (browserctl mcp)
```

Chrome 136 stopped honoring `--remote-debugging-port` for the default user data directory, so the old trick of relaunching your everyday Chrome with a debugging port no longer works, and for good reason. Chrome 144 added a different path: the user turns on remote debugging from inside the running browser, and Chrome asks for approval when a client connects. [chrome-devtools-mcp](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect) (`--autoConnect`), [Puppeteer](https://pptr.dev/api/puppeteer.connectoptions) (`connect({ channel })`), and [agent-browser](https://github.com/vercel-labs/agent-browser) (`--auto-connect`) use the same flow. Like them, the bridge finds the port and browser target path in `DevToolsActivePort`.

Each new WebSocket connection can trigger a new approval dialog. That is why the broker exists. Early versions opened a connection per CLI command and Chrome asked every time. Now the broker connects once, and every CLI call, script, and MCP session talks to the broker over a Unix socket instead. The approval is needed again only after the broker stops, Chrome restarts, or remote debugging is switched off. The broker starts automatically on first use. Its output goes to `broker.log` in its state directory, and a failed start reports the tail of that log.

## Components

[src/paths.mjs](../src/paths.mjs) resolves Chrome's user data directory for the platform and channel, and derives a private state directory per user data directory from a hash of its path. The socket, binding, locks, and log all live there, so two channels never share state and tests never touch your real state.

[src/bridge.mjs](../src/bridge.mjs) is the only module that speaks CDP. It owns the connection, the profile binding, the writer lock, refs, and every page action. All policy lives here, so the CLI, scripts, and agents get identical rules.

[src/broker-server.mjs](../src/broker-server.mjs) and [src/broker-client.mjs](../src/broker-client.mjs) carry newline-delimited JSON requests over the Unix socket. The server only accepts method names from a fixed table with fixed argument counts. If the socket drops while an action is in flight, the client reports `OUTCOME_UNKNOWN` instead of a plain error, because the action may already have reached Chrome.

[src/mcp-server.mjs](../src/mcp-server.mjs) maps MCP tools onto the client. It validates arguments against each tool's schema, formats snapshots as one line per element to save the agent's context, and sends short instructions about verifying results and distrusting page content.

## Profile binding

The debugging permission covers the whole Chrome instance, including every profile that is open. CDP shows each profile as a separate browser context. `browserctl bind` records which context the tools may use, together with the ID of the browser endpoint it was recorded against. Every later call checks both. A binding from an earlier Chrome session is rejected with `PROFILE_BINDING_EXPIRED` rather than silently reused. Without an argument, `bind` succeeds only when exactly one context has web tabs. Otherwise it lists the candidates and asks you to choose. Agents cannot call `bind`.

## Refs

A ref looks like `e42-1f9a0c3b`. `42` is the backend DOM node ID from the accessibility tree. `1f9a0c3b` is the first eight hex digits of a SHA-256 over the document token (frame ID, loader ID, and a digest of the URL), the node ID, and the node's role and name. Before acting, the bridge reads that one node with `Accessibility.getPartialAXTree` and recomputes the digest. A navigation, a `pushState` URL change, a replaced node, or a node whose name or role changed all produce a different digest. Each of these is refused with `STALE_REF`.

This puts the staleness check into the ref itself. Callers pass only the tab and the ref, and they cannot forget the check. The digest is a consistency check, not a secret. A page cannot see the frame or loader IDs, so it cannot forge a matching digest for a different element.

The check has two known gaps. First, it cannot tell whether a button's event handler changed while its name stayed the same. Second, a framework that reuses DOM nodes, such as a list keyed by index, can leave a "Delete" button in place while the row it belongs to changes. Both are reasons to confirm results with a fresh snapshot. In the other direction, the URL is part of the document identity on purpose: single-page apps often swap content under the same nodes when the route changes. As a result, a site that rewrites its query string while you type invalidates refs taken before the edit, and you need a new snapshot after typing.

Two more checks run at action time. A click goes to whatever is on top at the element's center, so the bridge hit-tests that point first (`DOM.getNodeForLocation`). If an overlay, banner, or dialog covers the element, it refuses with `TARGET_OBSCURED` and sends nothing. `fill` also checks, after its click, that focus is still inside the element it vetted. Pages that move focus elsewhere, such as auto-advancing code inputs or multi-step logins, would otherwise receive the text in a different field. That case fails with `FOCUS_MOVED`, or `SENSITIVE_FIELD_DENIED` if focus landed in a credential field, and nothing is typed.

## Writes, locks, and failure

Every action that changes the page takes a writer lock, which is a directory created atomically in the state directory. A second automated writer gets `CONTROLLER_BUSY` immediately instead of queueing behind the first. A lock left by a crashed process is detected by its PID and reclaimed. If a CDP call times out, the connection closes, or Chrome detaches the debugger in the middle of an action, the error becomes `OUTCOME_UNKNOWN`. Errors are classified by type (a `TransportError` raised by the CDP connection), not by matching message text. The tool never retries a write on its own.

`open` remembers the tabs it created for the life of the broker, and `close` only accepts those. Navigation waits for the new document to commit. Snapshots wait for the document to finish loading, up to 15 seconds.

## CDP surface

| Methods | Used for |
| --- | --- |
| `Browser.getVersion` | Status |
| `Target.getTargets`, `getTargetInfo`, `createTarget`, `activateTarget`, `closeTarget` | Tab discovery, opening, focusing, closing |
| `Target.attachToTarget`, `detachFromTarget` | A short session per action |
| `Accessibility.getFullAXTree`, `getPartialAXTree` | Snapshots and ref checks |
| `Page.getFrameTree`, `navigate`, `getLayoutMetrics`, `captureScreenshot` | Document identity, navigation, scrolling, screenshots |
| `DOM.describeNode`, `getBoxModel`, `getNodeForLocation`, `scrollIntoViewIfNeeded`, `focus`, `resolveNode` | Field checks, click coordinates, and the hit test |
| `Input.dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | Clicks, keys, text, wheel scrolling |
| `Runtime.evaluate`, `callFunctionOn` | Only fixed code: reading `document.readyState` and `document.body.innerText`, the option chooser for `<select>`, the containment check for the hit test, and the focus check for `fill`. Arguments are passed as CDP values, never spliced into code, except two integers that `text` validates first. |

These snippets run in the page's own JavaScript world, so a hostile page can make them return wrong answers. Node therefore bounds their results again (for example, the length of returned text). The checks are there to catch honest mistakes, not to contain a malicious page, which can read its own form fields anyway.

Two input details matter. On macOS, Chrome ignores a synthetic Cmd+A, so `fill` sends the `selectAll` editing command with the key event. Without it, new text was appended to the old value. Enter and Space carry their `text` (`\r` and a space), which Chrome needs to generate the keypress that submits forms. The end-to-end test covers both.

## Why not reuse the Codex or Claude browser runtime

Both products ship their Chrome control as closed components. Each pairs a Chrome extension with a native messaging host that only accepts its own extension ID. The Codex desktop browser runtime also expects privileged capabilities that the Codex host injects into its own Node process. A plain Node process, such as one started by Pi, does not have them. Reusing these components would mean depending on private interfaces that change with every release, and working around the products' own permission checks. Chrome's public CDP flow gives the same browser access with a stable, documented interface.

## Possible next steps

These are deliberately not built yet. The first three are planned next. They close the gaps that matter most when the browser holds real accounts ([prior-art.md](prior-art.md#project-direction) explains why).

- A per-binding domain allowlist, checked in `open` and `navigate` and against the tab's URL before every action.
- Confirmation for sensitive actions, as a terminal prompt or a hook the calling agent answers.
- Boundary markers around page content in MCP results.
- An extension mode, built on `chrome.debugger` and Native Messaging, for per-tab grants that Chrome itself enforces.
- Iframe traversal for snapshots.
- File upload behind an explicit allow-list.
- An optional idle timeout for the broker.
- Windows support through named pipes.
