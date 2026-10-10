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

## Status

Work in progress, tracked under STP-943 (STP-1058 - STP-1065).

## License

MIT - see [LICENSE](LICENSE). Like the STP SDKs, this project is a client of
STP's public API; it contains no STP engine code and bundles only public
material.
