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
| `packages/live` | The live-STP server (`stp-mcp-live`, stdio): the contract's read methods as tools against a running engine, and a live context of recent STP events as resources (below). `test/fixtures/session.jsonl` is a recorded wire session the integration test replays; `scripts/` holds the recorder and the live smoke test, neither run in CI. |

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

## Live-STP server

Answers questions about a running STP from the engine itself - "which units are in COA B1?", "what is
the unit I just added tasked with?" - over the engine's WebSockets JSON-RPC bridge.

### Configuration

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `STP_URL` | `ws://localhost:9599` | The engine's WebSockets bridge. |
| `STP_SESSION` | (none) | The STP session to join - this is how the server sees the user's plan. Use the session id the user's STP app registered with. Without it the engine starts a new, empty session. |
| `STP_COA` | (none) | A default COA poid: it fills a missing `poid` of `GetCoaContent` and `GetCoaObjectSet` (the answer says so), and the context reports it. |
| `STP_TIMEOUT_S` | `15` | Request timeout in seconds. It is sent to the engine (whose `Request.timeout` is in seconds); the server itself gives up 2 s later. |

The server never calls `SetRole`, `SetCurrentCoa` or any other method that changes engine state, so
it has no role or COA configuration. STP keeps the role, current COA and current task org per
client and announces a change (`RoleSwitched`, `CoaSwitched`, `TaskOrgSwitched`) only to the client
that made it, so the context reports what reaches this server and otherwise says "not observed";
name the COA to read with `STP_COA` or a tool's `poid`.

### Tools

- **One tool per read method of the contract** (`x-stpSafety: read`, and dispatched by the engine):
  `GetScenarioContent`, `GetCoaContent`, `GetTaskOrgContent`, `GetScenarioTaskOrgList`,
  `GetPoidObject`, `GetAllObjects`, `HasActiveScenario` and the rest - 16 with contract 0.9.1. Name,
  description, input schema and annotations come from `generateTools` unchanged; arguments are
  validated against that schema before anything is sent. Each answer is
  `{ answer, notes?, truncated?, provenance: { endpoint, session, answeredAt, contract: { version, ref } } }`.
  - `PrologTerm` fields (the engine's internal term form, STP-1085) are removed from every answer,
    and the provenance says how many were (`prologTermDropped`). The object-set and `GetAllObjects`
    answers are then thin (fsTYPE, poid, timestamps, version), as their descriptions say; the
    `*Content` methods carry the readable content.
  - Answers over 200 KB of JSON are truncated, with a note saying what was kept.
  - An empty answer (`null`, `[]`, an empty `object_set`) comes with a note on what it means, as
    does a call without a `poid` (the engine then answers for the whole session).
- **`live_status`** - endpoint, connected or not, session and whether it has an active scenario,
  the last error and when it happened, event count, reconnects, contract version. When
  disconnected it makes one connection attempt.
- **`live_context`** - the same document as the `stp-live://context` resource.

### Resources

| URI | Content |
|---|---|
| `stp-live://context` | `application/json`: the current COA, role and task org as observed; `lastAdded` per kind (symbol, task, COA, task org, task org unit) with poid, time, engine time and a one-line summary - this is "the unit I just added"; entity counts; a one-line summary per tracked object; the recent events (name, time, poid). Subscribable: `notifications/resources/updated` follows a change, coalesced to one per second. |
| `stp-live://symbol/{poid}`, `stp-live://task/{poid}`, `stp-live://coa/{poid}` | One tracked object: the last payload the engine sent (without PrologTerm), its summary, and which event set it when. Also subscribable. |

The context is built from events only: the server registers for every `x-stpEvents` name, and
`JoinScenarioSession` replays the existing objects (marked `source: "replay"`) before live traffic
arrives. It is a bounded working set - 500 objects (the least recently touched goes first, never the
current COA or task org or a `lastAdded` one) and 200 recent events - not a copy of the scenario;
the read tools are the source of truth. On a reconnect it is rebuilt from the engine's replay.

### Read-only

Only `read` methods become tools; no write or destructive method is listed (a test asserts it), and
calling one by name is refused with the reason. Methods the engine does not dispatch and
transport-layer messages are never exposed. Besides the tools' calls the server sends only
`Register`, `JoinScenarioSession` and `HasActiveScenario`. Write tools are for a later write mode
with per-call confirmation (STP-1065).

### Errors

Refuse or explain, never a silent failure. Every error is an `isError` result that names the
endpoint, session and time:

- engine not running or wrong host: `cannot reach STP at ws://...: ECONNREFUSED (nothing is
  listening on ...) - is the engine running and is STP_URL right?`; a port that answers but is not
  the bridge (or an engine still starting behind a Docker port mapping) is named as such;
- engine restarted or connection dropped: `the STP connection closed (engine restarted?) while
  waiting for <Method> ...; its outcome is unknown. The next call reconnects - retry it.` The next
  call makes one reconnect attempt and registers and joins again;
- no answer: `STP did not answer <Method> within N s ...`;
- `success:false`: `STP refused <Method>: <the engine's reason>`;
- arguments that do not match the contract schema are refused before anything is sent.

The connection is lazy (first tool call or resource read), with one attempt at startup that does not
stop the process. A session with no active scenario is noted in the status, not treated as a failure.

### Add it to Claude Code

```sh
npm run build
claude mcp add stp-live -e STP_URL=ws://localhost:9599 -e STP_SESSION=<session id> \
  -- node /path/to/stp-mcp/packages/live/dist/index.js
```

### Testing against an engine

The tests need no engine: a scripted fake engine covers the protocol, failures and reconnects, and
an integration test replays a wire session recorded from a real engine (`test/fixtures/session.jsonl`,
synthetic scenario, PrologTerm removed). With an engine running (e.g. `docker run -d --name stp-main
-p 9599:9599 stp-server:main`):

```sh
node packages/live/scripts/live-smoke.mjs ws://localhost:9599 stp-main      # acceptance run, restarts the container
node packages/live/scripts/record-session.mjs ws://localhost:9599           # re-record the fixture (fresh engine)
```

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
