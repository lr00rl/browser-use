# Prior art

Surveyed in October 2026. Projects move quickly, so check each one's current README before relying on a detail here.

Tools that let an agent use your real, logged-in Chrome take one of two routes. The first route uses Chrome's own remote debugging permission (Chrome 144+, `chrome://inspect/#remote-debugging`): the tool connects to the running browser over CDP, and Chrome asks you to approve the connection. The second route installs a Chrome extension that holds the `debugger` permission and talks to a local process through Native Messaging or a local WebSocket. `browserctl` takes the first route.

## Same route: Chrome's remote debugging permission

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is Google's MCP server and the reference for this flow (Apache-2.0). With `--autoConnect` it attaches to the running Chrome stable, or to another channel when configured ([docs](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)). Its strength is debugging: performance traces, network, console with source maps, and Lighthouse. It also ships a `chrome-devtools` CLI backed by a background daemon. The CLI documentation describes that daemon as launching its own browser and does not mention attaching to an existing one. The docs also say Chrome shows a permission dialog each time the server requests a session, so every MCP client gets its own prompt. Usage statistics are on by default.

[agent-browser](https://github.com/vercel-labs/agent-browser) from Vercel Labs (Apache-2.0) is the closest match in shape. It is a native Rust CLI with a background daemon (one hour idle timeout by default), compact `@e1` refs, an interactive-only snapshot (`snapshot -i`), and `--auto-connect` to find a running Chrome. Its command set is far larger: tabs, frames, network routing, cookies, storage, tracing, `eval`, a dashboard, and an MCP mode. If you want breadth, start there. Its [security controls](https://agent-browser.dev/security) are extensive and all opt-in. They are `--action-policy` (allow and deny lists, which can block `eval`), `--confirm-actions` and `--confirm-interactive`, `--content-boundaries`, `--max-output`, an encrypted auth vault, and `--allowed-domains`. With none of them set, nothing is restricted. The security page says the domain allowlist rejects attach modes such as `--auto-connect`. It describes no way to limit an attached session to one Chrome profile, and no check that a click target is covered by another element.

[Puppeteer](https://pptr.dev/api/puppeteer.connectoptions) supports `connect({ channel: 'chrome' })`, which reads the same `DevToolsActivePort` file. It is a good choice when you want a full automation library in your own Node code rather than a ready CLI or MCP server.

[pi-browser-use](https://pi.dev/packages/pi-browser-use) (MIT, npm `pi-browser-use`) is a Pi package that wraps chrome-devtools-mcp. By default it runs a separate persistent Chrome profile. Its "existing" mode attaches to your running Chrome through a bundled extension, and its page notes that Chrome asks for consent each session. It also bundles Pi skills. This package is why this project cannot use the name `pi-browser-use` on npm.

## Other route: a Chrome extension

[Playwright MCP](https://playwright.dev/mcp/configuration/browser-extension) with `--extension` connects through the Playwright Chrome extension to existing tabs, logins, and installed extensions, and can pick a profile with `--profile-dir-name`. Microsoft maintains it (Apache-2.0), and it exposes Playwright's accessibility snapshot format.

[Open Browser Use](https://github.com/ifuryst/open-browser-use) (MIT) is an MV3 extension plus a native host, a CLI, SDKs for JavaScript, Python, and Go, and an MCP server. It describes itself as an alternative to the Chrome browser feature in the Codex app. Agents claim tabs for a session and release them when done. Its README does not describe a security model for the extension path.

[mcp-chrome](https://github.com/hangwin/mcp-chrome) and its many descendants (for example [real-browser-mcp](https://github.com/ofershap/real-browser-mcp) and two different projects named BrowserMCP) follow the same extension-plus-bridge pattern with varying quality and maintenance. Check licenses carefully. A derivative of mcp-chrome is listed as AGPL-3.0 on npm while its README says MIT.

[codex-control-chrome-mcp](https://github.com/iola1999/codex-control-chrome-mcp) (MIT) reuses the official Codex Chrome extension. It replaces the `com.openai.codexextension` native host registration with its own proxy and keeps a backup. Codex updates can overwrite the proxy, and connected clients get raw CDP. It shows that the Codex extension can be borrowed, and also why this is fragile.

## Closed products

Claude in Chrome (used by Claude Code's `--chrome`) and the ChatGPT/Codex Chrome extension (used by Codex's `@Chrome`) both use an extension with the `debugger` and `nativeMessaging` permissions. They are not open source. Their native hosts accept only their own extension IDs. The Codex desktop browser runtime also depends on privileged capabilities that the Codex host injects, so it cannot be imported into another agent.

## Where this project fits

| | browserctl | agent-browser | chrome-devtools-mcp | Playwright MCP `--extension` | Open Browser Use |
| --- | --- | --- | --- | --- | --- |
| Attaches to your running Chrome | yes, CDP permission | yes, `--auto-connect` | yes, `--autoConnect` | yes, extension | yes, extension |
| One approval shared by CLI, scripts, and agents | yes, broker | daemon (not verified for attach mode) | per server session | per extension connection | not documented |
| Human CLI | yes | yes | yes | no | yes |
| Arbitrary JavaScript or raw CDP | no | yes, unless denied by `--action-policy` | yes | opt-in | yes (CDP) |
| Scoped to one profile when attached | yes, `bind` | not documented | not documented | `--profile-dir-name` | not documented |
| Refs refuse changed elements | yes, digest per ref | refuses ambiguous replacements | not documented | per snapshot | not documented |
| Runtime dependencies | none (Node 22) | native binary | npm package | npm package plus extension | CLI plus extension |
| Per-tab grant enforced by Chrome | no | no | no | extension decides | extension decides |

The honest summary: if you want features, use agent-browser or chrome-devtools-mcp. agent-browser can also be configured to be strict. This project's case is narrower, and it is about working in the browser that holds your real accounts. Its restrictions are always on and cannot be switched off by an agent's configuration. It scopes access to one profile. Its refs refuse elements that changed meaning, and its clicks refuse targets that something else covers. One approval covers the terminal and every agent. And the whole thing is small enough to audit, with no dependency tree.

## Ideas taken from these projects

An interactive-only snapshot filter, from agent-browser's `snapshot -i`. Short refs that stay meaningful across snapshots of the same document, also from agent-browser. Closing only the tabs an agent opened, from the tab claiming in Open Browser Use and Claude in Chrome. Compact text snapshots for agents, from Playwright's YAML-style accessibility snapshots.

Possible later additions: an idle timeout like agent-browser's, and an optional extension mode like Playwright MCP's for grants that Chrome enforces per tab.
