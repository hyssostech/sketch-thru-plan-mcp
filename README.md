# stp-mcp

[Model Context Protocol](https://modelcontextprotocol.io) servers for
[Sketch-thru-Plan](https://github.com/hyssostech) (STP).

Two servers, one repo:

- **Knowledge server** - the published STP documentation and the STP JSON-RPC
  (OpenRPC) contract, as MCP resources and read-only lookup tools. Needs no
  running STP; works offline.
- **Live-STP server** - query tools over a running STP's WebSockets JSON-RPC
  bridge, plus a live context of recent STP events.

## Principles

- **Read-only by default.** State-changing tools appear only when the live
  server is started in write mode, and destructive calls need a per-call
  confirmation from the user.
- **Refuse or explain, never a silent failure.** A refused, failed or timed-out
  call comes back as an explained error, never as an empty success.
- **The OpenRPC contract is the source of truth.** Tool definitions are
  generated from
  [`json-api/sketch-thru-plan-api.json`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/blob/main/json-api/sketch-thru-plan-api.json),
  never maintained by hand. Methods the engine does not dispatch are never
  exposed.
- **Tool descriptions are prompts.** They are written for a model reader.

## Layout

| Package | What it is |
|---|---|
| `packages/contract-tools` | The pinned OpenRPC contract (`contract/`, with `pin.json` naming its source commit) and the generator that turns it into MCP tool definitions. Methods the engine does not dispatch, and transport-layer messages, are excluded with their reason. |
| `packages/knowledge` | The knowledge server (`stp-mcp-knowledge`, stdio). Today: `list_methods`, `get_method`, `list_events`, `get_event` over the contract. Next: the STP docs as resources and `search_docs` (STP-1061). |

The live-STP server (STP-1063) is not started yet.

## Develop

```sh
npm ci
npm test            # builds every workspace, then runs the tests
```

Run the knowledge server from a local checkout in Claude Code:

```sh
npm run build
claude mcp add stp-knowledge -- node /path/to/stp-mcp/packages/knowledge/dist/index.js
```

or in Claude Desktop's `claude_desktop_config.json`:

```json
{ "mcpServers": { "stp-knowledge": { "command": "node", "args": ["/path/to/stp-mcp/packages/knowledge/dist/index.js"] } } }
```

### Re-pinning the contract

```sh
npm run contract:update            # or: node scripts/update-contract.mjs --ref <branch|tag|sha>
npx vitest run -u                  # regenerate the tool snapshot
git diff packages/contract-tools   # review what agents will see change
```

The `Contract drift` workflow checks weekly whether the published contract has moved past the pin.

## Status

Work in progress, tracked in the STP Jira project under STP-943 (STP-1058 - STP-1065).

## License

MIT - see [LICENSE](LICENSE). Like the STP SDKs, this project is a client of
STP's public API; it contains no STP engine code and bundles only public
material.
