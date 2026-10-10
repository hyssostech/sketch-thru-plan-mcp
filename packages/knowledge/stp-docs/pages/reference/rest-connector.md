---
sidebar_label: REST connector
sidebar_position: 2
description: Endpoints of the STP REST connector, how to post symbols and whole scenarios, the response envelope, status codes and the server-sent event stream.
---

# REST connector

The REST connector is an HTTP front end to STP for integrations that cannot
hold a WebSocket open or do not use an SDK. It accepts scenarios, symbols,
tasks and task organizations as JSON, and it streams changes made by other
clients as server-sent events.

## Base URL and API description

- **Base URL:** `http://<host>:9575/api/v1`. The port is the connector's
  `Port` setting, 9575 by default. By default the connector listens on the
  loopback address only. Its `ListenAddress` setting (`any`) makes it
  reachable from other machines.
- **OpenAPI document:** a running connector always serves its OpenAPI
  (Swagger) description at `/swagger/v1/swagger.json`. Use it for the complete
  schema of every payload. The interactive Swagger UI is enabled only in
  development and Docker deployments.

## Endpoints

| Method and path | Purpose |
|---|---|
| `POST /api/v1/scenario` | Apply a whole scenario: symbols, tasks, ORBAT and time. See [Posting a scenario](#posting-a-scenario). |
| `GET /api/v1/scenario` | Read the current scenario in the same shape. `?include_named_locations=true` also returns named-location symbols. |
| `POST /api/v0/scenario` | Legacy form of the scenario post. A symbol's `label` is used as `unit_designation` when the latter is missing. |
| `POST /api/v1/orbat` | Load a task organization (ORBAT) tree on its own |
| `POST /api/v1/symbol` | Add one symbol |
| `GET /api/v1/symbol` | List the live symbols |
| `GET /api/v1/symbol/{poid}` | Read one symbol |
| `PUT /api/v1/symbol/{poid}` | Update one symbol, or create it if there is no live symbol with that poid |
| `DELETE /api/v1/symbol/{poid}` | Delete one symbol |
| `POST /api/v1/task`, `GET /api/v1/task`, `GET`/`PUT`/`DELETE /api/v1/task/{poid}` | The same operations for tasks, with one difference: `PUT` replaces the task, deleting the old one and creating a new one. The response gives `previousPoid` and the new `poid`. |
| `POST /api/v1/speechandsketch`, `POST /api/v1/speechandsketch/multi` | Recognition requests. The payloads are in the OpenAPI document. |
| `GET /api/v1/events` | Server-sent event stream of changes. See [Event stream](#event-stream). |
| `GET /api/v1/health` | `200` when the connector is connected to STP, `408` when it is not |

For symbols, `{poid}` can be the poid returned when the symbol was created
(with or without its `uuid` prefix) or the `id` the symbol was given in a
scenario post. For tasks, it is the task's poid.

## Posting one symbol

```http
POST /api/v1/symbol
Content-Type: application/json

{
  "sidc": "SFGPUCI----E---",
  "designator": "A/1-23",
  "anchor_points": [[34.532, -116.648]]
}
```

- **`sidc`** is a 15-character MIL-STD-2525C code or a 20-digit 2525D code.
  Instead of `sidc` you can send a 2525D code split into parts (`sidcParts`).
  See [Symbology and the wire](../guides/symbology-and-the-wire.md).
- **`anchor_points`** is a list of `[latitude, longitude]` pairs: latitude
  first. (The `400` message of this endpoint says `[longitude, latitude]`, but
  the connector reads the first number as latitude.) A point symbol has one
  pair. A line or area has several.
- **Optional fields** include `designator`, `unit_designation`,
  `parent_designator`, `description` and `metadata` (a free-form object
  returned as is). See the OpenAPI document for the full list.

A successful response is `201 Created`:

```json
{
  "success": true,
  "poid": "0f8e5c1e-...",
  "id": "...",
  "designator": "A/1-23",
  "sidc": "SFGPUCI----E---",
  "sidcParts": { "...": "..." },
  "warnings": []
}
```

A request without `sidc` (or `sidcParts`), or without usable anchor points, is
answered with `400` and a problem description.

## Posting a scenario

`POST /api/v1/scenario` takes the whole picture in one request:

```json
{
  "name": "Exercise North",
  "symbols": [
    {
      "id": "u1",
      "sidc": "SFGPUCI----E---",
      "designator": "A/1-23",
      "anchor_points": [[34.532, -116.648]]
    }
  ],
  "tasks": [
    { "who": "u1", "task_type": "<TASK_TYPE>", "when": { "start_time": 0, "end_time": 1 } }
  ],
  "orbat": { "friendly": { "id": "bde", "sidc": "...", "children": [] } },
  "time": { "h_hour": "2029-01-18T20:00:00Z", "slot_duration_minutes": 240 }
}
```

- **`id` gives a symbol a stable identity.** The connector derives the
  symbol's poid from it, so posting the same `id` again updates that symbol
  instead of adding a second one. Tasks name symbols by these ids in `who` and
  `tgs`. A missing or duplicated `id` is reported as an error.
- **`task_type`** must be a task name STP knows. An unknown value is reported in
  the response. Task times are slot indexes. See [Timing and
  synchronization](../guides/timing-and-synchronization.md#rest-connector-the-scenario-time-block).
- **`orbat`** holds a `friendly` tree and a `threat` (or `enemy`) tree of units
  with nested `children`. The same trees can be posted alone to
  `POST /api/v1/orbat`.

### Query parameters and headers

| Parameter | Effect |
|---|---|
| *(none)* | **Reconcile.** Make the scenario match the payload. If the payload contains any symbols, tasks or ORBAT, then resident symbols, tasks and task-organization objects that it does not contain are removed, whichever of those kinds it contains. A payload that carries only `time` removes nothing. |
| `?append=true` | Add or update what the payload contains and leave everything else alone. Tasks may refer to symbols that are already in STP. |
| `?replace=true` | Wipe the scenario and load the payload |
| `?mode=strict` | Reject the whole request (`400`) if validation finds any error. The default, permissive mode, applies what it can and reports the rest. |
| `?mode=dryrun` | Validate and report as a permissive post would, but apply nothing. Answers `200` instead of `201`, and `details.wouldDelete` gives the number of resident objects the post would remove (`total`, `byType`). |
| `X-Scenario-Seq` header | Optional positive, increasing number. A post whose number is not greater than the last one applied is rejected with `409`, so a slow, older request cannot overwrite a newer one. |

`append=true` together with `replace=true` is rejected with `400`. **An empty
payload without `append=true` wipes the scenario.** Read
[Silent failures](../guides/silent-failures.md) before relying on the default
mode.

### The response envelope

A scenario post answers with a validation envelope:

```json
{
  "schema": "stp.validation.issue.v1",
  "version": "v1",
  "processingMode": "permissive",
  "partial": false,
  "summary": {
    "symbolsAdded": 1, "symbolsRejected": 0,
    "tasksAdded": 1, "tasksRejected": 0,
    "errorCount": 0, "warnCount": 0
  },
  "issues": [],
  "details": { "deleted": { "total": 0, "byType": {} } },
  "dryRun": false
}
```

Each entry in `issues` has a `code` (for example `SYMBOL_ID_MISSING` or
`TASK_WHO_UNRESOLVED`), a `severity` (`error`, `warning` or `info`), the
`entityType`, `entityId` and `index` it refers to, a `jsonPointer` into your
payload, a `message`, and often a `suggestion` describing the fix. `partial:
true` means a permissive post found errors and applied what it could.
`details` carries counters for the post (tasks attempted, ORBAT units
created and so on) and, after a reconcile or an append, `deleted`: how many
resident objects were removed, by type.

Responses that read or change the scenario carry an `X-Scenario-Generation`
header and a matching weak `ETag`. The number increases each time a change is
applied through the connector. It does not count changes made by other
clients.

### Status codes

| Status | When |
|---|---|
| `201 Created` | The post was applied (check `issues` and `partial`) |
| `200 OK` | Dry run (`?mode=dryrun`) |
| `400 Bad Request` | Strict-mode validation errors, conflicting `append` and `replace`, a malformed `X-Scenario-Seq` |
| `409 Conflict` | `X-Scenario-Seq` not newer than the last applied post |
| `408 Request Timeout` | The connector could not connect to STP |
| `503 Service Unavailable` | Another request held the scenario too long (comes with `Retry-After: 5`), or communication with STP failed while the post was being applied |
| `500 Internal Server Error` | Unexpected failure while processing |

Errors other than the validation envelope are returned as problem details
(`title`, `detail`, `status`). Requests that change the scenario are applied
one at a time.

## Event stream

`GET /api/v1/events` is a server-sent event stream:

```
retry: 3000

event: heartbeat
data: {"action":"heartbeat","lastSeq":41,"engineConnected":true}

id: 42
event: symbol
data: {"action":"modified","poid":"...","entityType":"unit","item":{...},"seq":42}
```

- **Data events:** `symbol`, `task`, `taskorg`, `taskorgunits` and
  `relationship`, with `action` set to `created`, `modified` or `deleted`. Use
  `?types=symbol,task` to receive only some of them.
- **Control events** are always sent, whatever the filter: `heartbeat` about
  every 10 seconds (and as soon as you subscribe), `status` when the engine
  connection goes up or down (`engine-connected` / `engine-disconnected`), and
  `scenario` with `action: "new"` when the scenario is wiped or replaced.
- **Changes made through the REST connector itself are not echoed.** The stream
  carries changes from other clients, such as STP's own UI and SDK clients.
- **Detecting gaps:** each data event has an increasing `id` (`seq`). If you see
  a gap, or a heartbeat's `lastSeq` is ahead of the last `id` you received,
  events were lost. The connector also drops the oldest events for a client
  that falls too far behind. On a gap, or on a `scenario` event, fetch
  `GET /api/v1/scenario` again and rebuild your state from it.

## See also

- [Silent failures](../guides/silent-failures.md): the replace, append and
  reconcile modes, and the empty-payload wipe
- [Integration troubleshooting](../guides/integration-troubleshooting.md):
  symbols that are accepted but never appear, and symbols that do not join the
  task organization
- [Timing and synchronization](../guides/timing-and-synchronization.md)
