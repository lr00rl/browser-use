# Security

`browserctl` drives the browser you use every day, with your logins. Read this before pointing an agent at it.

## What you grant

When you enable `chrome://inspect/#remote-debugging` and approve the connection, any process that completes Chrome's connection flow can control the whole browser instance. That covers every window and profile, and cookies, storage, and page content. Chrome shows a notice while a client is connected. This is Chrome's permission model. This tool does not widen it and cannot narrow what Chrome itself allows.

## What this tool restricts

The broker is the only process holding the connection. It listens on a Unix socket with mode `0600` inside a `0700` directory, so only your own user account can send it commands. It opens no TCP port. Through that socket, every client is limited to this behavior:

- Only `http:` and `https:` pages in the profile you bound with `browserctl bind`. Agents cannot change the binding.
- No arbitrary JavaScript, raw CDP, cookies, storage, network bodies, file upload, or `chrome:` pages. The JavaScript the bridge runs is limited to the fixed snippets listed in [docs/architecture.md](docs/architecture.md).
- `fill` refuses password, one-time-code, and payment fields, and types nothing if focus moves away from the field it checked. Snapshots do not include password values. A password field that a "show password" toggle has turned into a plain text field, with no `autocomplete` hint, cannot be recognized.
- Actions must name an element by a ref from a current snapshot. A ref stops working when the page navigates or the element changes. Clicks are refused when another element covers the target.
- One automated writer at a time. Interrupted writes are reported as `OUTCOME_UNKNOWN` and never retried automatically.
- Only tabs opened through the tool can be closed through it.

These are rules this tool enforces. Chrome does not enforce them. Any other software running as your user can still connect to Chrome directly while remote debugging is enabled.

## Agents and untrusted pages

Web pages can contain text written to manipulate an agent (prompt injection). The MCP server tells agents to treat page content as data, but that is advice to a model, not a guarantee. Bind a profile that holds only the accounts you want an agent to reach. Watch the first runs. Keep your agent's own approval prompts on for actions that send, buy, publish, or delete.

## Turning it off

Run `browserctl stop` to drop the connection. Switch off "Allow remote debugging" in `chrome://inspect/#remote-debugging` to stop Chrome from accepting any debugging client. `browserctl unbind` removes the profile binding.

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting on this repository, not in a public issue. Include the version, platform, Chrome version, and steps to reproduce. Leave out real tab IDs, profile names, and screenshots of your own browser.
