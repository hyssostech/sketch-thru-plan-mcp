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
| `packages/knowledge` | The knowledge server (`stp-mcp-knowledge`, stdio): the contract and the public STP docs as read-only tools and resources (below). The docs are pinned in `stp-docs/` (`pin.json` names the source commit and each page's git blob id); `eval/search-eval.json` is the retrieval evaluation set. |

The live-STP server (STP-1063) is not started yet.

## Knowledge server

Tools (all read-only):

| Tool | What it does |
|---|---|
| `list_methods` | The STP JSON-RPC methods, with summary, safety class and availability. Methods the engine does not dispatch are hidden unless asked for, and then come with the reason. |
| `get_method` | One method's full contract entry and callable input schema. |
| `list_events` / `get_event` | The events STP sends to clients, and one event's params. |
| `search_docs` | `query`, optional `k` (default 5, max 20). Lexical BM25 search over the STP docs, split at their headings, and over every contract method and event description. Returns ranked passages - page title, heading path, snippet, score, resource URI - plus a `resource_link` per page. Unknown words are reported with close matches; a search with no match is an error that says so and suggests what to try. |

Resources:

| URI | Content |
|---|---|
| `stp-docs://<path>` (e.g. `stp-docs://guides/roles`) | One page of the STP docs as `text/markdown`, with the Docusaurus front matter and admonition syntax turned into plain Markdown, and links between pages pointing at their `stp-docs://` URIs. Ends with a source line naming the pinned commit. |
| `stp-api://method/<Name>` | A contract method as `application/json` (the same entry `get_method` returns). |
| `stp-api://event/<Name>` | A contract event as `application/json`. |

Every tool answer and every contract resource carries the provenance of both pins: `contract`
(repo, path, commit, version) and `docs` (repo, path, commit, page count).

### What the docs corpus holds

The hand-written pages of [hyssostech/stp-docs](https://github.com/hyssostech/stp-docs) (MIT):
everything under `docs/` - overview, installation, getting started, the guides, plugins and
reference pages. The generated API reference pages (`docs/api`, TypeDoc for the JS SDK, and
`docs/api-net`, the .NET SDK) are left out: on the evaluation set they did not answer any question
the guides and contract do not, and adding them lowered retrieval quality as their many near-identical
pages crowd the results (recall@5 on answerable questions 0.983 without them, 0.966 with either; MRR
0.914 vs 0.867 / 0.855; 318 passages vs 1025 / 2494). The JSON-RPC contract, which is indexed, covers
the API surface itself.

## Develop

```sh
npm ci
npm test            # builds every workspace, then runs the tests (including the search evaluation)
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

### Re-pinning the docs

```sh
npm run docs:update                # or: node scripts/update-docs.mjs --ref <branch|tag|sha>
npm test                           # includes the search evaluation; read its recall line and misses
git diff packages/knowledge/stp-docs
```

The script fetches with `git` (no GitHub API, no credentials), copies the pages verbatim and
rewrites `pin.json`. If a re-pin moves or removes a page the evaluation set names, update that
question's expected sources in the same change; the recall floor in
`packages/knowledge/test/search-eval.test.ts` is not lowered to make a re-pin pass.

The `Contract drift` workflow checks weekly whether the published contract or docs have moved past
their pins.

### The search evaluation

`packages/knowledge/eval/search-eval.json` holds realistic developer and agent questions about STP,
each with the resource URIs that answer it. The test runs `search_docs` on each and reports
recall@5 (an expected page among the top 5 results), every miss, and what the questions marked
`noGoodSource` - topics the docs do not cover well yet - currently retrieve. Recall on the answerable
questions must stay at or above the floor.

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

## Status

Work in progress, tracked in the STP Jira project under STP-943 (STP-1058 - STP-1065).

## License

MIT - see [LICENSE](LICENSE). Like the STP SDKs, this project is a client of
STP's public API; it contains no STP engine code and bundles only public
material.
