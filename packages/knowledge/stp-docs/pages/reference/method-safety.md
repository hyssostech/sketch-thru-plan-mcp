---
sidebar_label: Method safety classes
sidebar_position: 2
description: Which STP API methods only read state, which modify the scenario and which can delete or overwrite it, as the OpenRPC contract classifies them (x-stpSafety), and the other per-method metadata the contract carries - x-stpInform, x-stpEmits, x-stpKnownIssues, x-stpEdgeCases and examples.
---

# Method safety classes

This page answers these questions:

- Which API methods only read state, and which ones modify or delete the
  scenario?
- Which calls get a reply, and which are confirmed only by events?
- Where do I find the events that follow a call, its known issues, and what
  it does with bad input?

Each method in the
[OpenRPC contract](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/json-api/sketch-thru-plan-api.json)
carries this information in extension fields whose names start with `x-`. The
tables below are generated from contract version 0.9.6. They leave out the
two transport messages, `Register` and `Request` (marked `"x-layer":
"transport"`), which the SDK connectors send for you.

| Field | On | What it says |
|---|---|---|
| `x-stpSafety` | every method | `read`, `write` or `destructive`: what the call can do to state |
| `x-stpInform` | fire-and-forget methods | The engine sends no reply; the outcome arrives as events |
| `x-stpEmits` | every method | The events that follow a call, when, and who receives them |
| `x-stpKnownIssues` | some methods | Filed engine issues that affect the method, by ticket key |
| `x-stpEdgeCases` | every method | What the engine did with bad or unusual input, on a live capture |
| `examples` | every method | One call captured from a live engine, with the events it produced |
| `x-stpOpenWorld` | `PullC2SIMInitialization`, `PushC2SIMContent` | The call reaches a system outside STP (the C2SIM server) |

## Safety classes: `x-stpSafety`

Every method has one of three classes:

- **`read`** changes nothing on the server: queries, conversions, and
  replaying the scenario to the caller (`JoinScenarioSession`).
- **`write`** changes the scenario or the session in the way the call names:
  add, update, select, recognize, session settings, undo.
- **`destructive`** can remove or overwrite data that the call does not name
  one by one: deletes, creating or loading a scenario (which replaces it),
  resetting it, every import and sync (an imported object **replaces** a
  resident object with the same poid), and pushing to an external C2SIM
  server (which can reset that server).

Contract 0.9.6 has 16 read, 35 write and 19 destructive methods.

A client that must not change anything calls only `read` methods. A client
that acts for a user, such as an AI agent, should ask the user before every
`destructive` call. MCP tool annotations map from the class: `read` becomes
`readOnlyHint`, `destructive` becomes `destructiveHint`.

### Read methods

These 16 methods change nothing. `JoinScenarioSession` is the only one that
produces events: it replays the current scenario to your client only.

| Method | Returns | Known issues |
|---|---|---|
| `GetScenarioContent` | `content` (string) |  |
| `JoinScenarioSession` | `null` |  |
| `HasActiveScenario` | `active` (boolean) |  |
| `GetTaskOrgContent` | `content` (string) |  |
| `GetCoaContent` | `content` (string) |  |
| `ConvertC2SIMContent` | `content` (string) |  |
| `GetC2SIMContent` | `content` (string) |  |
| `GetCoaObjectSet` | `objects` (array) |  |
| `GetScenarioObjectSet` | `objects` (array) |  |
| `GetTaskOrgObjectSet` | `objects` (array) |  |
| `GetActiveScenarioDescription` | `scenario` (object) |  |
| `GetAllObjects` | `objects` (array) |  |
| `GetDeletedObjects` | `objects` (array) |  |
| `GetPoidObject` | `object` (object) |  |
| `GetScenarioTaskOrgList` | `taskOrgs` (array) |  |
| `GetTaskOrgObjects` | `objects` (array) |  |

### Write methods

These 35 methods change the scenario or the session. "Call" says whether the
method is a request (it gets a reply) or an inform (fire and forget), and for
an inform which event always confirms it. An event the contract lists but a
known issue holds back is marked "intended, not sent yet": read the state back
instead. No method in contract 0.9.6 has one.

| Method | Call | Known issues |
|---|---|---|
| `SendPenDown` | inform; no event |  |
| `SendInk` | inform; events depend on the outcome |  |
| `SendSpeechRecognition` | inform; confirmed by `SpeechParsed` |  |
| `SendSimulatedSpeechRecognition` | inform; confirmed by `SpeechParsed` |  |
| `AddSymbol` | inform; confirmed by `InkProcessed`, `SymbolAdded` |  |
| `UpdateSymbol` | inform; confirmed by `SymbolModified` |  |
| `ChooseAlternate` | inform; events depend on the outcome |  |
| `SetDefaultTaskOrg` | request |  |
| `ResetDefaultTaskOrg` | request |  |
| `AddTaskOrg` | inform; confirmed by `TaskOrgAdded` |  |
| `UpdateTaskOrg` | inform; confirmed by `TaskOrgModified` |  |
| `AddTaskOrgUnit` | inform; confirmed by `TaskOrgUnitAdded` |  |
| `UpdateTaskOrgUnit` | inform; confirmed by `TaskOrgUnitModified` |  |
| `AddTaskOrgRelationship` | inform; confirmed by `TaskOrgRelationshipAdded` |  |
| `UpdateTaskOrgRelationship` | inform; confirmed by `TaskOrgRelationshipModified` |  |
| `AddTask` | inform; confirmed by `TaskAdded` |  |
| `UpdateTask` | inform; events depend on the outcome |  |
| `ConfirmTask` | inform; events depend on the outcome |  |
| `SetCoaTaskOrg` | request |  |
| `ResetCoaTaskOrg` | request |  |
| `SetCurrentCoa` | request |  |
| `AddCoa` | inform; confirmed by `CoaAdded` |  |
| `UpdateCoa` | inform; confirmed by `CoaModified` |  |
| `SetRole` | request |  |
| `PullC2SIMInitialization` | request |  |
| `ChangeTimeOut` | inform; no event |  |
| `ResetSegmentationTimeout` | inform; no event |  |
| `SetSpeechListening` | inform; no event |  |
| `RecognizeNow` | inform; events depend on the outcome |  |
| `SendListen` | inform; no event |  |
| `SendAudioCaptureState` | inform; no event |  |
| `AdvertiseViewport` | inform; no event |  |
| `SetAutoTasking` | inform; no event |  |
| `ResetRole` | inform; events depend on the outcome |  |
| `UndoLastOp` | inform; events depend on the outcome |  |

### Destructive methods

These 19 methods can delete or overwrite data:
`CreateNewScenario`, `LoadNewScenario`, `ImportPlanData`, `SyncScenarioSession`, `DeleteSymbol`, `ImportTaskOrgContent`, `DeleteTaskOrg`, `DeleteTaskOrgUnit`, `DeleteTaskOrgRelationship`, `DeleteTask`, `ImportCoaContent`, `DeleteCoa`, `ImportCoaFromObjectSet`, `ImportPlanDataFromObjectSet`, `ImportTaskOrgFromObjectSet`, `LoadNewScenarioFromObjectSet`, `PushC2SIMContent`, `SyncScenarioSessionFromObjectSet` and `ResetStpScenario`.

The third column is the confirmation text from the shared call-validation
rules ([`sketch-thru-plan-validations.json`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/json-api/sketch-thru-plan-validations.json)),
which a client can show the user before the call.

| Method | Call | What it can remove or overwrite | Known issues |
|---|---|---|---|
| `CreateNewScenario` | request | Replaces the session's current scenario, and every object in it, with a new empty scenario named `name`. |  |
| `LoadNewScenario` | request | Replaces the session's current scenario, and every object in it, with the scenario in the content. |  |
| `ImportPlanData` | request | Imports the content into the current scenario; an imported object REPLACES a resident one with the same poid. |  |
| `SyncScenarioSession` | request | Merges the content into the current scenario; an object in the content REPLACES a resident one with the same poid. |  |
| `DeleteSymbol` | inform; confirmed by `SymbolDeleted` | Deletes the symbol `poid` from the scenario. |  |
| `ImportTaskOrgContent` | request | Imports task org content; an imported object REPLACES a resident one with the same poid. |  |
| `DeleteTaskOrg` | inform; confirmed by `TaskOrgDeleted` | Deletes the task org `poid`. |  |
| `DeleteTaskOrgUnit` | inform; confirmed by `TaskOrgUnitDeleted` | Deletes the task org unit `poid`. |  |
| `DeleteTaskOrgRelationship` | inform; confirmed by `TaskOrgRelationshipDeleted` | Deletes the task org relationship `poid`. |  |
| `DeleteTask` | inform; confirmed by `TaskDeleted` | Deletes the task `poid`. |  |
| `ImportCoaContent` | request | Imports COA content; an imported object REPLACES a resident one with the same poid. |  |
| `DeleteCoa` | inform; confirmed by `CoaDeleted` | Deletes the COA `poid`. |  |
| `ImportCoaFromObjectSet` | request | Imports the objects given; an imported object REPLACES a resident one with the same poid. |  |
| `ImportPlanDataFromObjectSet` | request | Imports the objects given into the current scenario; an imported object REPLACES a resident one with the same poid. |  |
| `ImportTaskOrgFromObjectSet` | request | Imports the task org objects given; an imported object REPLACES a resident one with the same poid. |  |
| `LoadNewScenarioFromObjectSet` | request | Replaces the session's current scenario, and every object in it, with the objects given. |  |
| `PushC2SIMContent` | request | Sends C2SIM content of type `dataType` to the external C2SIM server, which can reset that server's state. |  |
| `SyncScenarioSessionFromObjectSet` | request | Merges the objects given into the current scenario; an object given REPLACES a resident one with the same poid. |  |
| `ResetStpScenario` | inform; events depend on the outcome | Discards the session's current scenario and every object in it. |  |

Two points are easy to miss:

- **Every import is destructive**, not only the deletes. `ImportCoaContent`,
  `ImportTaskOrgContent`, `ImportPlanData`, `SyncScenarioSession` and their
  object-set forms keep the poids in the content, so an object whose poid
  already exists in the scenario is replaced.
- **`PushC2SIMContent` changes a system outside STP.** It imports nothing
  into STP, but it can reset the C2SIM server's state.

## Safety classes in the STP MCP live server

The STP MCP live server, which lets an AI agent query a running STP, uses
these classes:

- By default it exposes **only the read methods** as tools. Write methods are
  listed only when the server is started in write mode, and destructive
  methods only when destructive calls are also enabled. A tool call cannot
  turn either mode on.
- **Every destructive call needs the user's confirmation**, asked by the
  server for that call. When the MCP client cannot ask the user, the call is
  refused.

## Requests and informs: `x-stpInform`

A method marked `"x-stpInform": true` is fire and forget: the engine sends no
reply, and the outcome arrives only as events. For example `AddCoa` is
confirmed by `CoaAdded`, and `DeleteSymbol` by `SymbolDeleted`. Every other
method has a `result` and gets a reply, which is `success: false` with the
reason when STP refuses the call. Contract 0.9.6 has 35 informs.

An inform that STP cannot apply is often ignored without a message. When the
confirming event does not arrive, read the state back, for example with
`GetPoidObject`. See [Errors, refusals and timeouts](../guides/errors-and-timeouts.md).

## Events that follow a call: `x-stpEmits`

`x-stpEmits` lists the events that follow a call, so a client knows what to
wait for. Each entry has:

- `event`: an event name from the contract's `x-stpEvents`;
- `when`: `always` (follows every successful call), `if` (follows when
  `condition` holds, for example only on a real change) or `may` (depends on
  the content or on recognition: an import sends one event per object, a
  sketch may produce several events or none);
- `condition`: when it is sent, present unless `when` is `always`;
- `to`: `caller` (only the client that made the call) or `session` (every
  client in the session, the caller included unless `condition` says
  otherwise).

For example, `SetCurrentCoa`:

```json
"x-stpEmits": [
  { "event": "CoaSwitched", "when": "if", "condition": "the COA was not already current", "to": "caller" },
  { "event": "TaskOrgSwitched", "when": "if", "condition": "the switch changes the caller's current task org", "to": "caller" },
  { "event": "StpMessage", "when": "if", "condition": "the call is refused", "to": "caller" }
]
```

An empty list means the call produces no event. That is true of every read
method except `JoinScenarioSession`.

:::caution You receive only the events you registered
A client receives an event only if it registered the event's name when it
connected. The SDKs register the events your application has handlers for, so
attach handlers before connecting. An `x-stpEmits` entry is not a promise to a
client that did not register the event.
:::

`RequestResponse` (the reply to every request) is not listed, and neither are
general `StpMessage` warnings. `StpMessage` is listed only on the methods that
also announce a refusal with it.

## Known issues: `x-stpKnownIssues`

`x-stpKnownIssues` lists filed engine issues, by ticket key, that make
today's engine behave differently from the method's description or its
`x-stpEmits`: an event that never arrives, or a call accepted although its
target does not exist. While a key is listed, the method's description says
what to do in the meantime. A key is removed from the contract once the fix
ships, and the description then says how engines before the fix behave: STP-1080
and STP-1089 were removed in contract 0.9.2, STP-1090 in 0.9.3, STP-1091 in 0.9.4, STP-1077 in 0.9.5.

No method in contract 0.9.6 lists a known issue, so the "Known issues" columns
of the tables above are empty.

## Bad input: `x-stpEdgeCases`

`x-stpEdgeCases` records what the engine did, on a live capture, with bad or
unusual input: a missing or unknown poid, no active scenario, malformed
content, an inform sent through `Request`, and so on. Contract 0.9.6 has 258
cases. Each case has:

- `when`: the input;
- `outcome`: `refused` (answered `success: false` with `message`),
  `announced` (an `StpMessage` carrying `message`), `ignored` (nothing came
  back, so check the result another way) or `accepted` (the call went through,
  and `note` says what it returned or sent);
- `message` and `note`, as above;
- `wire`: present when the case was sent differently from the method's usual
  path, for example `request` for an inform sent through `Request`.

For example, `DeleteCoa`:

```json
"x-stpEdgeCases": [
  { "when": "missing poid", "outcome": "announced",
    "message": "'DeleteCoa' refused: DeleteCoa: missing 'poid' - name the COA to delete" },
  { "when": "unknown poid", "outcome": "announced",
    "message": "'DeleteCoa' refused: DeleteCoa: the engine did not confirm within 10 s" },
  { "when": "sent through Request (unknown poid)", "outcome": "refused",
    "message": "DeleteCoa: the engine did not confirm within 10 s", "wire": "request" }
]
```

These cases record behaviour, not intent. An `ignored` case, or a surprising
`accepted` one, is often a filed defect, and the method then lists it in
`x-stpKnownIssues`. The message texts are diagnostic, written for people; do
not parse them.

## Captured calls: `examples`

Every method has one OpenRPC example taken from a live engine, not written by
hand. `params` and `result` are what went over the wire; a fire-and-forget
method's example has no `result`. `x-stpEventsObserved` lists the events the
call produced, as `{ event, params }`. Long values are shortened, and the
example's `description` says so. An example whose name ends in `(captured, not
completed)` could not complete the call, for example because it needs an
external server; its `description` says what came back.

## Other markers

- **`x-engineDispatch: "none"`** marks a method listed in the contract that
  the engine does not dispatch. No method carries it since contract 0.6.0.
  A method that is not in the contract at all is answered with "No handler"
  (see [Integration troubleshooting](../guides/integration-troubleshooting.md#a-call-throws-with-no-useful-message)).
- **`x-layer: "transport"`** marks `Register`, `Request` and the
  `RequestResponse` event. The SDKs send and handle them; a client written
  without an SDK must implement them.
- **`x-descriptionStatus: "draft"`** marks a description that was generated
  from the engine source rather than written by hand; treat its prose as a
  best-effort reading.

## See also

- [JSON-RPC API](./json-api.md): message formats, requests and replies
- [Errors, refusals and timeouts](../guides/errors-and-timeouts.md): how a
  refusal or a missing event shows up in each SDK
- [Courses of action (COAs)](../guides/coas.md): the COA methods in detail
- The contract's own notes on these fields:
  [`json-api/README.md`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/json-api/README.md)
