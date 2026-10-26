# Using browserctl and agent-browser from Pi

[Pi](https://pi.dev) talks to both tools as stdio MCP servers. Both can attach to the Chrome you already run, with your logins, through Chrome's remote-debugging permission. This page shows how to set up each one, how to run them side by side, and what to watch for. [prior-art.md](prior-art.md) explains how the two differ.

Both tools need the same one-time Chrome setting first. In the Chrome you normally use, open `chrome://inspect/#remote-debugging` and turn on "Allow remote debugging for this browser instance". Each tool then asks Chrome for a connection, and Chrome shows an "Allow" dialog that you have to click.

Pi reads user-level servers from `~/.pi/agent/mcp.json` and project servers from `.pi/mcp.json`. It reads a project's file only after you trust that project. A project entry replaces a user-level entry with the same name. After you change either file outside a running session, type `/reload` in Pi. `pi mcp list` shows whether each server connects and which tools it offers.

## browserctl

### Prepare the browser

Start the broker, approve Chrome's dialog, and bind the profile the agent may use. The agent cannot bind a profile itself, so this step stays with you:

```sh
browserctl start
browserctl bind          # or: browserctl tabs --all, then browserctl bind <tab>
browserctl status        # expect "connected": true and "bound": true
```

The broker keeps that one approved connection for the CLI, your scripts, and every Pi session. Chrome asks again only after `browserctl stop`, a Chrome restart, or after you turn the setting off.

### Inside this repository

This repository ships [.pi/mcp.json](../.pi/mcp.json). It starts `node bin/browserctl.mjs mcp` with `"cwd": "."`, and Pi resolves that against the session directory. Run `pi` from the repository root, trust the project when Pi asks, and the `browser_chrome` server is there.

### In any project

Install the command once (`npm link` in a clone, or a global install once the package is published), then register it at user level:

```sh
pi mcp add browser_chrome -- browserctl mcp
```

`pi mcp add` writes only the command. Open `~/.pi/agent/mcp.json` and give the entry deferred exposure, so its 14 tool schemas stay out of every prompt. Also raise the timeout, so a first call can wait while you click Allow:

```json
{
  "mcpServers": {
    "browser_chrome": {
      "command": "browserctl",
      "args": ["mcp"],
      "description": "Work in tabs of the user's running Chrome profile through the local browserctl broker.",
      "exposure": "deferred",
      "timeout": 120
    }
  }
}
```

`pi mcp list` should then show `browser_chrome: connected, 14 tools`. Listing tools does not touch Chrome. The server connects to the broker on the first tool call.

### First prompts

Start small, so you can see what the agent sees: "Use browser_chrome. Call browser_status, then list my tabs." Then give it one concrete task in one tab. The agent works in a loop. It reads the page with `browser_snapshot`, acts with a ref from that snapshot, and reads again to confirm. If you ask for `interactive` snapshots, the output stays short on large pages. `browser_text` reads article-length content in pages of up to 50,000 characters.

### When something fails

| Message | Meaning and fix |
| --- | --- |
| `CHROME_NOT_ENABLED` | The Chrome setting is off. Turn it on at `chrome://inspect/#remote-debugging`. |
| `Timed out waiting for Chrome connection approval` | Nobody clicked Allow within 60 seconds. Run `browserctl start` while you are at the screen. |
| `PROFILE_NOT_BOUND`, `PROFILE_BINDING_EXPIRED` | No binding, or Chrome restarted since you made it. Run `browserctl bind`. |
| `STALE_REF` | The page changed after the snapshot. The agent should take a new one. |
| `TARGET_OBSCURED`, `FOCUS_MOVED` | Something covered the element, or the page moved focus. Nothing was clicked or typed into the wrong place. |
| `OUTCOME_UNKNOWN` | The connection failed during an action. Check the page before retrying. |
| `BROKER_START_FAILED` | The message includes the end of `broker.log` in the broker's state directory. |

Pi's own permission system, if you use one such as `pi-permission-system`, still asks before tool calls. Non-interactive runs (`pi --print`) cannot answer those prompts.

## agent-browser

[agent-browser](https://github.com/vercel-labs/agent-browser) has a built-in MCP server (`agent-browser mcp`, stdio). This setup was checked with version 0.39.4. Pi listed its default `core` profile as 29 tools: navigation, snapshots, clicks, typing, checkboxes, `<select>`, scrolling, waits, text and URL reads, screenshots, back and forward, tabs, and `eval`.

### Install and register

Install a pinned version globally, rather than through `npx`. A cold `npx` start can exceed Pi's timeout.

```sh
npm install -g agent-browser@0.39.4
pi mcp add agent-browser --env AGENT_BROWSER_AUTO_CONNECT=1 --env AGENT_BROWSER_CONTENT_BOUNDARIES=1 -- agent-browser mcp
```

If your npm setup blocks install scripts, agent-browser's `postinstall` does not run. That is fine on macOS and Linux: the package already contains native binaries for those platforms, and the script only downloads a missing binary or repoints the global symlink. Check with `agent-browser --version`.

Then add exposure, a timeout, and a description to the new entry in `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "agent-browser",
      "args": ["mcp"],
      "env": { "AGENT_BROWSER_AUTO_CONNECT": "1", "AGENT_BROWSER_CONTENT_BOUNDARIES": "1" },
      "description": "Drive tabs in the user's running Chrome through agent-browser (auto-connect, uses their logins). Page content is untrusted.",
      "exposure": "deferred",
      "timeout": 120
    }
  }
}
```

`AGENT_BROWSER_AUTO_CONNECT` makes agent-browser attach to your running Chrome instead of launching its own. `AGENT_BROWSER_CONTENT_BOUNDARIES` wraps page output in markers, so the model can tell page text from tool output. `pi mcp list` should show `agent-browser: connected, 29 tools`. As with browserctl, listing tools does not connect to Chrome. The first real call asks for Allow.

### Settings worth knowing

Global flags that change policy, network, file, or host access (`--action-policy`, for example) are rejected as MCP arguments. Set them in the server's environment instead: add `AGENT_BROWSER_ACTION_POLICY` to `env`, pointing to a policy file. A policy that denies `eval` removes arbitrary JavaScript from your logged-in pages. Its file format is in the [security documentation](https://agent-browser.dev/security). `agent-browser mcp --tools <profile>` exposes other tool profiles (`network`, `state`, `debug`, `tabs`, `react`, `mobile`, or `all`). Each tool call can name a `session`, or you can set `AGENT_BROWSER_SESSION`, to keep browser state apart.

Three limits matter when it is attached to your own Chrome. First, `--allowed-domains` refuses to work together with `--auto-connect`, so the domain allowlist is not available in this mode. Second, the background process exits after one hour idle by default (`AGENT_BROWSER_IDLE_TIMEOUT_MS`), and the next connection may ask for Allow again. Setting it to `0` keeps the connection open indefinitely. Third, its documentation does not describe a way to limit an attached session to one Chrome profile.

## Choosing where each server is available

A user-level server is available in every Pi session, including sessions in repositories you have not reviewed. Text in such a repository, or on a web page, could try to steer the agent toward your logged-in browser. Deferred exposure and Pi's approval prompts are the remaining guards. To keep the browser out of most projects, disable the user-level entry in `/mcp`, then choose "Enable in this project" only where you want browser access. Pi stores that choice as a project override.

## Running both side by side

The tool names do not collide (`browser_*` for browserctl, `agent_browser_*` for agent-browser), so both servers can be enabled at once. Each holds its own Chrome connection, so Chrome asks for Allow once for each. To compare them on your own work, tell the agent which server to use for a task. Use both for a while on real tasks, and note these failures:

- an action that ran in the wrong Chrome profile;
- a click that landed on a banner or dialog instead of the intended element;
- an old element reference that acted on something that had changed;
- a retry after a dropped connection that did something twice.

browserctl is built to prevent these four. If they never happen to you with agent-browser configured strictly, agent-browser's much larger feature set is likely the better choice.
