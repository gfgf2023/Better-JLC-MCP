# Local Setup

This skill supplies instructions; it does not itself install or start an MCP server. Prefer the available Better-JLC-MCP typed tools. If missing, inspect the existing client configuration and connect this implementation rather than invoking old JLC Agent tools with similar names.

## Installed Project

Locate the user's Better-JLC-MCP checkout from the current workspace or configured MCP entry point. Do not assume the skill installation directory contains the server source. Use that checkout's absolute path for the settings below.

Entry point: `dist/server.js`. Official bridge: `scripts/bridge-server.mjs`. Client config examples: `examples/codex.toml`, `examples/claude-code.json`, `examples/opencode.json`. Check that the path still exists; if moved, use the actual checkout path. Public source: https://github.com/gfgf2023/Better-JLC-MCP.

Requires Node.js 22+ and EasyEDA with the official Run API Gateway extension. In the project directory, `npm ci` and `npm run build` install locked dependencies and build the server when needed. `npm run start:bridge` starts the official bridge. Reuse a healthy existing bridge; avoid launching duplicates or stopping an established session unnecessarily.

The previously used endpoint was `http://127.0.0.1:49620`; it is a historical value, not a guarantee of a current connection. Inspect session/bridge discovery first. A listening bridge is distinct from a connected EDA Gateway. Reconnect the extension in the intended EDA window if necessary.

## Client Settings

The standard MCP process uses command `node` and the absolute `dist/server.js` path as its argument. Keep stdout reserved for MCP. The local example uses:

```text
EASYEDA_STATE_DIR=<absolute project path>/.easyeda-mcp
AUTO_SPAWN_BRIDGE=false
EASYEDA_COMPAT=0
EASYEDA_EXPERIMENTAL_ROUTING=0
EASYEDA_ALLOW_RAW_CODE=0
EASYEDA_TOOL_MODE=full
```

All clients operating on this installation must share the same absolute state directory for operation records and window locks. With auto-spawn disabled, the bridge needs to be running separately. Set `GATEWAY_BASE_URL` only when intentionally pinning a verified endpoint; otherwise use discovery. Preserve unrelated client configuration and credentials when making an authorized setup change.

Version 0.2.0 defaults to full typed tool exposure. Set `EASYEDA_TOOL_MODE=compact` only for a client's tool budget; this does not change execution policy. After updating files, reconnect the MCP or open a new client session so its process and tool list use the new build. Reuse the running official bridge.

After connecting, call `eda_session` and a read-only state tool for the actual document to distinguish transport health from usable EDA access. Keep capability tests read-only unless the current task includes a write. Merely loading this skill is not a reason to modify an open circuit.

If the MCP is not available in the current client, explain that connection gap and complete authorized setup work. Do not silently switch to unrestricted Gateway evaluation or an old autonomous routing implementation.
