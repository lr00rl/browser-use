# chrome-tether

`browserctl` lets coding agents and your own scripts work in the Chrome window you are already using, with your logins, instead of a separate automation browser. One small local broker holds a single approved debugging connection to Chrome. The command line, Node scripts, and any MCP client (Pi, Claude Code, Codex CLI, Cursor) all share that connection, so Chrome asks for permission once per broker lifetime rather than once per command.

It is browser use, not computer use: it reads pages through the accessibility tree and sends input through the Chrome DevTools Protocol (CDP). It never moves your mouse or takes over the screen.

The runtime has no dependencies beyond Node.js 22. It does not download a browser, install Playwright, or open a network port of its own.

> Status: early. macOS is tested with Chrome stable. Linux follows the same code path and has a CI job, but nobody has run it against a real Linux desktop yet. Windows is not supported.

## How it fits with other tools

Several mature projects overlap with this one, and they may suit you better. [agent-browser](https://github.com/vercel-labs/agent-browser) has a much larger command set and can also attach to a running Chrome. [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) with `--autoConnect` is the reference implementation of the same Chrome connection flow, with deep debugging tools. [Playwright MCP](https://playwright.dev/docs/getting-started-mcp) in extension mode and [Open Browser Use](https://github.com/ifuryst/open-browser-use) use a Chrome extension instead, which can limit access to chosen tabs. [docs/prior-art.md](docs/prior-art.md) compares them in detail.

This project stays deliberately small. It is about 1,800 lines of auditable code, and its safety rules live in one place. Those rules are profile binding, refs that expire when the page changes, refusal of password and payment fields, and no arbitrary JavaScript.

## Requirements

You need macOS or Linux, Google Chrome 144 or later (developed against 155), and Node.js 22 or later.

## Quick start

1. In the Chrome you normally use, open `chrome://inspect/#remote-debugging` and turn on "Allow remote debugging for this browser instance". This is Chrome's own permission gate; `browserctl` never edits Chrome's preferences to get around it.
2. Install the command. From a clone, run `npm link`, or call `node bin/browserctl.mjs` directly.
3. Start the broker and approve Chrome's "Allow" dialog:

   ```sh
   browserctl start
   ```

4. Bind the profile you want the tools to use. If only one Chrome profile has web pages open, `browserctl bind` picks it. Otherwise list every tab and bind one from the right profile:

   ```sh
   browserctl bind            # works when one profile has open web tabs
   browserctl tabs --all      # otherwise: find a tab in the profile you want
   browserctl bind 7F3A       # a unique prefix of its tab ID is enough
   ```

5. Use it:

   ```sh
   browserctl open https://example.com
   browserctl snapshot 9C1E --interactive --text
   browserctl click 9C1E e42-1f9a0c3b
   browserctl snapshot 9C1E --text      # confirm what actually happened
   ```

`browserctl status` shows whether Chrome is connected and which profile is bound. The binding lasts until Chrome restarts. After a restart, run `bind` again; the tool will not guess.

## Command reference

| Command | What it does |
| --- | --- |
| `status`, `start` | Start the broker if needed and report the connection and binding. |
| `stop` | Stop the broker. Chrome stays open; the next start may ask for permission again. |
| `tabs [--all]` | List web tabs in the bound profile, or in every profile with `--all`. |
| `bind [tab]`, `unbind` | Choose or forget the profile the tools may use. |
| `open <url>` | Open a new tab in the bound profile. |
| `activate <tab>` | Bring a tab to the front. |
| `navigate <tab> <url>` | Load a URL in an existing tab. |
| `snapshot <tab> [query] [-i] [--text]` | Read the accessibility tree. `query` searches names across the whole page, `-i` keeps only interactive elements, `--text` prints one line per element instead of JSON. |
| `text <tab> [offset] [limit]` | Read the page's visible text, up to 50,000 characters per call. |
| `click <tab> <ref>` | Click an element. |
| `fill <tab> <ref> <text>` | Replace the content of an input, textarea, or contenteditable element. Use `-` to read the text from stdin, which keeps it out of shell history. |
| `press <tab> <ref> <key>` | Press Enter, Tab, Escape, Backspace, Delete, Space, an arrow key, Home, End, PageUp, or PageDown. |
| `select <tab> <ref> <option>` | Choose an option of a native `<select>` by label or value. |
| `scroll <tab> <up\|down>` | Scroll by most of one screen. |
| `close <tab>` | Close a tab that `browserctl` opened. Your own tabs cannot be closed. |
| `screenshot <tab> <file.png>` | Save the visible part of a tab. Existing files are never overwritten. |
| `shell` | Read commands line by line (plain words or a JSON array of strings) and print one JSON result per line. |
| `mcp` | Serve the same tools to an agent over MCP stdio. |

Everything prints JSON unless you ask for `--text`, so results pipe into `jq` cleanly. Exit codes are `0` for success, `2` when Chrome is not connected, and `3` for profile or tab problems. `4` means another writer holds the lock, `5` means a ref is stale, and `6` means the outcome is unknown. `64` is a usage error.

## Refs and the safety model

A snapshot gives every element a ref such as `e42-1f9a0c3b`. The number names the DOM node. The suffix is a digest of the current document and the element's role and name. Before every click, fill, press, or select, the bridge recomputes the digest against the live page. If the page navigated, the URL changed, or the element was renamed or replaced, the action is refused with `STALE_REF` and nothing is sent. A button that turned from "Save" into "Delete data" cannot be clicked with the old ref. A click is also refused with `TARGET_OBSCURED` when a banner or dialog covers the element. `fill` types nothing (`FOCUS_MOVED`) if the page moves focus to another field after the click.

Actions return `dispatched: true`, which means Chrome received the input. It does not mean the page did what you hoped. Read a new snapshot to confirm. If the connection drops or times out in the middle of an action, the result is `OUTCOME_UNKNOWN`: the action may or may not have happened, and nothing is retried automatically.

The tools only touch `http:` and `https:` pages in the bound profile. Fields marked as passwords, one-time codes, or payment cards are refused. There is no tool for arbitrary JavaScript, cookies, storage, network bodies, or raw CDP. Only one automated writer may act at a time (`CONTROLLER_BUSY` otherwise), although nothing stops you from using the same tab by hand. See [SECURITY.md](SECURITY.md) for what the Chrome permission itself allows.

## Scripting from Node

```js
import { connectBroker } from './src/broker-client.mjs';

const browser = await connectBroker();
try {
  const { tabId } = await browser.open('https://example.com');
  const page = await browser.snapshot(tabId, { interactive: true });
  const link = page.nodes.find(node => node.role === 'link');
  await browser.click(tabId, link.ref);
  console.log((await browser.text(tabId)).text.slice(0, 500));
} finally {
  browser.close(); // closes this script's socket; the broker and Chrome keep running
}
```

The client exposes `status`, `tabs`, `tabsAll`, `bind`, `unbind`, `open`, `activate`, `navigate`, `snapshot(tabId, { query, interactive })`, `text(tabId, { offset, limit })`, `click`, `fill`, `press`, `select`, `scroll`, `closeTab`, and `screenshot`.

## Using it from an agent

`browserctl mcp` is a stdio MCP server. It connects to the same broker, so an agent and your terminal see the same tabs and share the same single approval. The agent cannot bind a profile; you do that with the CLI. Profile binding is a human decision.

[docs/pi.md](docs/pi.md) walks through Pi in detail. It covers this tool and agent-browser, side by side, with troubleshooting. Pi reads [.pi/mcp.json](.pi/mcp.json) when you run it inside this repository. For use anywhere, add the server at user level:

```json
{
  "mcpServers": {
    "browser_chrome": { "command": "browserctl", "args": ["mcp"], "exposure": "deferred", "timeout": 120 }
  }
}
```

For Claude Code, run `claude mcp add browserctl -- browserctl mcp`. For the Codex CLI, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.browserctl]
command = "browserctl"
args = ["mcp"]
```

The agent gets these tools: `browser_status`, `browser_tabs`, `browser_open`, `browser_navigate`, `browser_activate`, `browser_snapshot`, `browser_text`, `browser_click`, `browser_fill`, `browser_press`, `browser_select`, `browser_scroll`, `browser_close_tab`, and `browser_screenshot`. Snapshots come back as compact text, one element per line, to keep the context small. The server's instructions tell the agent to verify results and to treat page content as untrusted data.

## Configuration

| Variable | Effect |
| --- | --- |
| `BROWSERCTL_CHANNEL` | `stable` (default), `beta`, `dev`, or `canary`. |
| `BROWSERCTL_PROFILE_DIR` | Chrome's user data directory, if it is not in the default place for the channel. This is the root directory, not `Default` or `Profile 1` inside it. |
| `BROWSERCTL_STATE_DIR` | Where the broker socket, binding, locks, and log live. Defaults to `~/Library/Application Support/browserctl` on macOS and `$XDG_RUNTIME_DIR/browserctl` on Linux. |

Each Chrome user data directory gets its own broker, so stable and Canary never share a connection or a binding. The broker log is `broker.log` in that broker's state directory.

## Limitations

The Chrome permission covers the whole browser instance. Profile binding narrows what these tools will touch, but it is a rule this tool enforces, not a boundary Chrome enforces. An extension-based design would be needed for Chrome itself to limit access to one tab. While the broker is connected, Chrome shows that it is being controlled by automated software. Snapshots cover the main frame and return at most 200 elements (80 for a query), with a `truncated` flag. Pages inside cross-origin iframes are not reachable yet. File upload, drag and drop, and dialogs are not implemented.

## Development

```sh
npm test                    # unit tests plus an end-to-end run against a throwaway headless Chrome
npm run check:redaction     # fails if tracked files contain home paths, live browser IDs, emails, or secrets
```

The end-to-end test starts its own headless Chrome with a temporary profile and a temporary state directory, so it never touches your browser. Set `CHROME_PATH` if Chrome is not in the standard location; without Chrome the test is skipped. [docs/architecture.md](docs/architecture.md) explains the design.

Real-browser checks produce real tab IDs, profile names, and screenshots. Keep them in `evidence/`, which git ignores, and do not paste them into issues or commits.

## License

[MIT](LICENSE)
