# Sketch-Thru-Plan MCP

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
| `packages/contract-tools` | The pinned OpenRPC contract (`contract/`, with `pin.json` naming its source commit) and the generator that turns it into MCP tool definitions. Methods the engine does not dispatch, and transport-layer messages, are excluded with their reason. Next to the contract, the pinned call-validation rules and their schema (`sketch-thru-plan-validations*.json`, `validations-pin.json`), loaded by `loadValidations`. |
| `packages/knowledge` | The knowledge server (`stp-mcp-knowledge`, stdio): the contract and the public STP docs as read-only tools and resources (below). The docs are pinned in `stp-docs/` (`pin.json` names the source commit and each page's git blob id); `eval/search-eval.json` is the retrieval evaluation set. |
| `packages/live` | The live-STP server (`stp-mcp-live`, stdio): the contract's read methods as tools against a running engine, a live context of recent STP events as resources, and - in write mode - the write methods, checked before and after each call (below). `src/validate.ts` is the call-validation evaluator. `test/fixtures/session.jsonl` and `write-session.jsonl` are recorded wire sessions the integration tests replay; `scripts/` holds the recorders and the live smoke tests, none run in CI. |

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

The hand-written pages of [hyssostech/sketch-thru-plan-sdk-docs](https://github.com/hyssostech/sketch-thru-plan-sdk--docs) (MIT):
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
| `STP_WRITE` | `0` | `1` turns write mode on: the contract's write methods are listed and can be called (see [Write mode](#write-mode)). Off, the server is read-only. |
| `STP_DESTRUCTIVE` | `0` | `1` (needs `STP_WRITE=1`, or the server does not start) also lists the destructive methods; every destructive call still needs the user's confirmation. |
| `STP_V10_TIMEOUT_S` | `8` | How long a write waits for the events that prove it was done (V10) before reporting what it saw. |
| `STP_ACTION_LOG` | (none) | A file every write or destructive call - refused ones too - is appended to, one JSON line each. It is opened at startup; a path that cannot be written stops the server. |

A switch takes `1`, `0`, `true` or `false`; write mode cannot be turned on by a tool call.

In read-only mode the server never calls `SetRole`, `SetCurrentCoa` or any other method that changes
engine state, so it has no role or COA configuration. STP keeps the role, current COA and current
task org per client and announces a change (`RoleSwitched`, `CoaSwitched`, `TaskOrgSwitched`) only to
the client that made it, so the context reports what reaches this server and otherwise says "not
observed"; name the COA to read with `STP_COA` or a tool's `poid`. In write mode the server is such a
client when the model calls `SetRole` or `SetCurrentCoa`, and then the context shows its own switch.

### Tools

- **One tool per read method of the contract** (`x-stpSafety: read`, and dispatched by the engine):
  `GetScenarioContent`, `GetCoaContent`, `GetTaskOrgContent`, `GetScenarioTaskOrgList`,
  `GetPoidObject`, `GetAllObjects`, `HasActiveScenario` and the rest - 16 with contract 0.9.7. Name,
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
- **In write mode, one tool per write method** (`x-stpSafety: write`) - `AddCoa`, `AddSymbol`,
  `AddTask`, `UpdateSymbol`, `SetCurrentCoa` and the rest - and with `STP_DESTRUCTIVE=1` one per
  destructive method (`DeleteSymbol`, `DeleteCoa`, `CreateNewScenario`, the imports...). Their
  definitions also come from `generateTools` unchanged, annotations included (`readOnlyHint: false`,
  `destructiveHint` true for destructive ones).
- **`live_status`** - endpoint, connected or not, session and whether it has an active scenario,
  the last error and when it happened, event count, reconnects, contract and validation-rule
  versions, `writeMode` (`off`, `write` or `destructive`), the V10 timeout and the action log. When
  disconnected it makes one connection attempt.
- **`live_context`** - the same document as the `stp-live://context` resource.

### Resources

| URI | Content |
|---|---|
| `stp-live://context` | `application/json`: the current COA, role and task org as observed; `lastAdded` per kind (symbol, task, COA, task org, task org unit) with poid, time, engine time and a one-line summary - this is "the unit I just added"; entity counts; a one-line summary per tracked object; the recent events (name, time, poid). Subscribable: `notifications/resources/updated` follows a change, coalesced to one per second. |
| `stp-live://symbol/{poid}`, `stp-live://task/{poid}`, `stp-live://coa/{poid}` | One tracked object: the last payload the engine sent (without PrologTerm), its summary, and which event set it when. Also subscribable. |
| `stp-live://actions` | `application/json`: the action log, newest first - every write or destructive call the server was asked to make, refused ones included (see [The action log](#the-action-log)). Subscribable. |

The context is built from events only: the server registers for every `x-stpEvents` name, and
`JoinScenarioSession` replays the existing objects (marked `source: "replay"`) before live traffic
arrives. It is a bounded working set - 500 objects (the least recently touched goes first, never the
current COA or task org or a `lastAdded` one) and 200 recent events - not a copy of the scenario;
the read tools are the source of truth. On a reconnect it is rebuilt from the engine's replay.

### Read-only by default

Unless `STP_WRITE=1`, only `read` methods become tools; no write or destructive method is listed (a
test asserts it), and calling one by name is refused with the reason (and logged). Methods the engine
does not dispatch and transport-layer messages are never exposed, in any mode. Besides the tools'
calls a read-only server sends only `Register`, `JoinScenarioSession` and `HasActiveScenario`.

### Write mode

Write mode (STP-1065) lets a model change the plan through the write tools, under a safety model of
three layers:

1. **Configuration, not a tool call, decides what is listed.** `STP_WRITE=1` lists the write tools;
   `STP_DESTRUCTIVE=1` also lists the destructive ones. A tool the mode does not list is refused by
   name, as in read-only mode.
2. **Every call is checked before it goes out** (STP-1064), and refused with the check's name and
   the fix when a check fails. Nothing is sent then.
3. **A destructive call needs the user's confirmation, every time** - asked by this server through
   MCP elicitation, so the model alone can never confirm (there is no argument or token it could
   pass; an extra `confirm` argument is refused by the schema).

Then **every write result says what the engine's events show** (V10), and every call, sent or
refused, goes to the action log.

The checks, in this order (each was kept because a recorded case shows STP failing silently without
it - see the STP-1064 notes):

| Check | Refuses when |
|---|---|
| `dispatchable` | the engine does not dispatch the method, or the pinned rules have no entry for it. |
| `params` | the arguments do not match the contract schema (enum values such as `StpRole` and the C2SIM option keys are checked by value), or a param the engine silently needs is missing (the rules' `required`, e.g. `UpdateSymbol` without `symbol`). |
| `writeMode` | the method's safety class is not enabled (`STP_WRITE`, `STP_DESTRUCTIVE`). |
| `confirmation` | (destructive only) the user did not confirm this call - or the MCP client cannot ask (below). |
| `context` | STP is unreachable, or the session has no active scenario (asked with `HasActiveScenario` right before the call). Without one the engine accepts writes and creates objects that belong to no scenario. `CreateNewScenario`, `LoadNewScenario` and `LoadNewScenarioFromObjectSet` need none. |
| `references` | a poid the call names (the rules' `references`: `poid` of an update or delete, `task.who`, `symbol.parentCoa`, `toUnit.parentTO`...) does not name an existing object of the right kind. The live context is asked first, then the engine with `GetPoidObject` (a read). Engines since STP-1091 also refuse a bad update target, a bad `task.who` or `toUnit.parentTO`, and a bad task org or COA selection themselves; older engines ignore an update of an unknown poid, turn `UpdateTask` on one into a new task, and apply a cross-type update to the wrong object. A delete of an unknown poid is still ignored. A deleted poid is named as deleted. When a kind can only be inferred (an fsTYPE this server does not know), the step says so. |

The rules come from the shared rule file `sketch-thru-plan-validations.json`, written next to the
contract in hyssostech/sketch-thru-plan-sdk-js and pinned here like the contract; its vocabulary is
documented in that repo's `json-api/README.md`, "Call validations". `src/validate.ts` evaluates it.

#### Confirmation

A destructive call is confirmed per call with MCP elicitation (`elicitation/create`, form mode): the
user sees the method, what it destroys (from the rule file: "Deletes the symbol idX from the
scenario."), the objects it names with their summaries, the arguments and the engine and session, and
checks `confirm`. Declining, cancelling or leaving `confirm` unchecked refuses the call. When the MCP
client did not declare the elicitation capability, the call is refused: "STP DeleteSymbol is
destructive and needs your confirmation, but this MCP client cannot ask you (no elicitation support);
run it from your STP client instead".

#### V10: did the call do what it asked?

The engine answers no fire-and-forget call (an inform): its outcome arrives only as events, and it
ignores a call it cannot apply without saying so. So after every write the server compares what the
call intended - the method, its params and the events the rule file expects (derived from the
contract's `x-stpEmits`) - with what the event stream showed, and reports one outcome:

| `v10.outcome` | Meaning | Tool result |
|---|---|---|
| `done` | every expected event arrived (e.g. `CoaAdded` with the requested name; `TaskAdded` for the requested unit). A request method that promises no event is done by the engine's answer. | success |
| `partial` | some expected events arrived, some did not - per item, on a multi-object call such as an object-set import. The summary leads with what is missing. | success |
| `not_done` | the engine refused (an answer with `success:false`, or a refusal `StpMessage` such as `'AddCoa' refused: ...`), or it acknowledged the call (e.g. `InkProcessed`) but the expected events never came. | error |
| `other` | the engine did something else (e.g. `TaskModified` instead of `TaskAdded`). An event on the object the call just made is a follow-on, not something else (`AddTask` sends `TaskAdded`, then `TaskModified`). | error |
| `unknown` | nothing came back at all - no answer, no event - within the wait: the outcome is unknown, never success. | error |
| `unverifiable` | the expected events are held back by a filed engine issue the contract still lists (STP-1089: task org relationship events; STP-1080: `TaskModified` after `UpdateTask`), or the call is an inform that promises no event. Says which, and suggests a read. | success |

The server waits up to `STP_V10_TIMEOUT_S` (8 s) and stops as soon as every expected event has
arrived or a refusal has; an inform that expects no event waits 1 s for a refusal. After a
destructive call it listens a moment longer and names other events it saw - deleting a unit also
deletes its tasks (`TaskDeleted`). Informs are sent as informs (`{method, params}`), as the SDKs do,
not wrapped in `Request`, whose immediate `success:true` says nothing about the outcome.

A write result is
`{ outcome, summary, sent: { method, wire, params }, engineAnswer? (request methods), v10: { outcome, summary, expected, observed, missing, unexpected, refusal?, knownIssue?, alsoSeen, ... }, validation: [steps], confirmation?, actionLogId, provenance }`;
an error result starts with the summary line. `v10.observed` gives the poids the engine assigned
(`AddCoa`'s new COA, `AddSymbol`'s unit), to use in the next call.

#### The action log

`stp-live://actions` (and, with `STP_ACTION_LOG`, one JSON line per entry in that file) records every
write or destructive call the server was asked to make, newest first, at most 500 in memory: the
time, the MCP client (`clientInfo` name and version from `initialize`), endpoint and session, the
method and its params (without PrologTerm), `status` (`sent`, or `refused` by a check), every
validation step passed or failed, the confirmation (accepted, declined, cancelled, unsupported), the
engine's answer and the V10 report. Refused calls are logged too.

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

With write mode (destructive calls then also need a client that supports elicitation; one that does
not gets them refused):

```sh
claude mcp add stp-live-write -e STP_URL=ws://localhost:9599 -e STP_SESSION=<session id> \
  -e STP_WRITE=1 -e STP_ACTION_LOG=$HOME/stp-actions.jsonl \
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
node packages/live/scripts/live-write-smoke.mjs ws://localhost:9599         # write mode, V10, confirmation, action log
node packages/live/scripts/live-write-smoke.mjs ws://localhost:9599 --record packages/live/test/fixtures/write-session.jsonl
```

The write smoke runs the STP-1065 acceptance against the engine: a write in a session with no
scenario is refused; in a scenario the user's app created, `AddCoa`, `AddSymbol` (a unit in that COA)
and `AddTask` (that unit) each come back with V10 `done`; a write naming an invented poid is refused;
`DeleteSymbol` is refused through an MCP client without elicitation and runs, logged, through one that
confirms. `write-session.jsonl` is that session recorded, and `test/write-replay.test.ts` replays it in CI.

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

The same script pins the call-validation rules and their schema (`contract/validations-pin.json`),
each file at the last commit that touched it; the rules name the contract version they were checked
against, and a re-pin where the two disagree stops. Without GitHub API access, pin from a local
clone instead (git only, no network):

```sh
node scripts/update-contract.mjs --from-git ../sketch-thru-plan-sdk-js --ref <branch|sha>
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

To pin a docs branch that is not on GitHub yet, or without access to github.com, pin from a local
clone instead (git only, no network). The pin still names `hyssostech/stp-docs` and the commit, so
re-pin from GitHub once that commit is merged:

```sh
node scripts/update-docs.mjs --from-git ../stp-docs --ref <branch|sha>
```

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
