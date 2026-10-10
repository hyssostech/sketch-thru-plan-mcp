---
sidebar_label: Timing and synchronization
sidebar_position: 16
description: How STP represents time on tasks (time slots) and symbols (time windows), how to set them, and how slots turn into clock time for C2SIM and the REST connector.
---

# Timing and synchronization

This page explains how to set the time of a task or the time window of a
symbol, and how STP's time slots turn into clock times, for example in C2SIM
orders.

## Two kinds of time

| Object | Fields | Type | Meaning |
|---|---|---|---|
| Task (`StpTask`) | `startTime`, `endTime` | integer | **Time slot indexes**, not clock times. Slot `0` is the first slot. |
| Symbol (`StpSymbol`) | `timeFrom`, `timeTo` | ISO 8601 date-time, UTC | A **time window** for time-bounded symbols, for example a Restricted Operations Zone. Optional. |

STP stores task times as bare slot numbers. It has no named phases and does
not convert slots to clock time by itself. What a slot is worth is decided
where the plan leaves STP. See [Turning slots into clock
time](#turning-slots-into-clock-time).

## Setting a task's time slots

Tasks are updated as a whole list of alternates. The first alternate is the
current interpretation. Change `startTime` and `endTime` on the alternate you
want, send the full list back with `updateTask`, and wait for `onTaskModified`
to confirm:

```typescript
const tasks = new Map<string, StpTask[]>();
stpsdk.onTaskAdded = (poid, alternates) => tasks.set(poid, alternates);
stpsdk.onTaskModified = (poid, alternates) => tasks.set(poid, alternates);

function setTaskSlots(poid: string, start: number, end: number) {
  const alternates = tasks.get(poid);
  if (!alternates) return;
  alternates[0].startTime = start;
  alternates[0].endTime = end;      // keep end >= start
  stpsdk.updateTask(poid, alternates); // confirmed by onTaskModified
}
```

In .NET, use `UpdateTask(poid, alternates)` with the full `List<StpTask>`. The
single-task overload `UpdateTask(poid, task)` sends only that one alternate.

## Setting a symbol's time window

Set `timeFrom` and `timeTo` and send the symbol with `updateSymbol`. In the
JavaScript SDK these are `Date` values, which serialize as UTC ISO 8601
strings. In .NET they are ISO 8601 strings.

```typescript
symbol.timeFrom = new Date('2029-01-18T20:00:00Z');
symbol.timeTo = new Date('2029-01-19T02:00:00Z');
stpsdk.updateSymbol(symbol.poid!, symbol); // confirmed by onSymbolModified
```

If the symbol object came from STP it carries a `dbVersion`, and the engine
drops the update when another client changed the symbol in between. See
[Event ordering and concurrent edits](./events-and-ordering.md#stale-versions-an-update-can-be-dropped-silently).

## Turning slots into clock time

### C2SIM export: `phaseDuration`

When the plan is exported to C2SIM (see [C2SIM](./c2sim.md)), the
`phaseDuration` option gives the length of one slot in minutes. If you do not
pass it, the engine's configured value is used. In the generated orders:

- A task lasts `(endTime - startTime) × phaseDuration` minutes.
- A unit's tasks are taken in order of `startTime`. The first one starts
  `startTime × phaseDuration` minutes after the start of the simulation.
- Each later task of the same unit is linked to the previous one. It starts
  `(startTime - previous endTime) × phaseDuration` minutes after the previous
  task ends.

Task start times are written relative to the start of the simulation, not as
calendar dates. On current engines the `startDate` option does not shift them.

### REST connector: the scenario `time` block

The [REST connector](../reference/rest-connector.md) accepts a scenario-level
time definition that clients can use to label a timeline or compute clock
times:

```json
{
  "time": {
    "h_hour": "2029-01-18T20:00:00Z",
    "slot_duration_minutes": 240,
    "slot_count": 6,
    "rationale": "4-hour slots"
  },
  "tasks": [
    { "who": "u1", "task_type": "<TASK_TYPE>", "when": { "start_time": 0, "end_time": 2 } }
  ]
}
```

| Field | Rules |
|---|---|
| `h_hour` | Optional. Clock time of slot `0`, ISO 8601 with an explicit UTC offset. Anything else is the error `TIME_HHOUR_INVALID`. |
| `slot_duration_minutes` | Required when `time` is present. From 1 to 43200 (30 days). Anything else is the error `TIME_SLOT_DURATION_INVALID`. |
| `slot_count` | Optional and advisory. If it is smaller than the highest `end_time` + 1, you get the warning `TIME_SLOT_COUNT_INCONSISTENT`. |
| `rationale` | Optional free text. |

The connector stores this block with the scenario and returns it from
`GET /api/v1/scenario`. A client computes the clock time of slot *n* as
`h_hour + n × slot_duration_minutes`.

The REST `time` block and C2SIM's `phaseDuration` are independent. C2SIM
export does not read `slot_duration_minutes`. If you use both, set them to the
same value.

Task times in a REST payload go in `when.start_time` and `when.end_time`:

- An `end_time` earlier than `start_time` is the error `TASK_TIME_ORDER`. In
  strict mode the request is rejected. In the default permissive mode the task
  is applied with `end_time` raised to `start_time`.
- An `end_time` equal to `start_time` is the warning `TASK_DURATION_ZERO`.
- `when.phase_name` is accepted but not stored. It reads back empty.

## "Synchronization" elsewhere in STP

Two other features share the name and are unrelated to task timing:

- **Session synchronization** (`syncScenarioSession`) merges offline content
  into a live session. It compares the objects' storage timestamps, not
  `startTime` or `timeFrom`. See [Scenarios](./scenarios.md#synchronizing-content).
- **Ordering of live events** is covered in [Event ordering and concurrent
  edits](./events-and-ordering.md).

## See also

- [Tasks](./tasks.md): task properties
- [Symbols and rendering](./symbols-and-rendering.md): symbol properties
- [C2SIM](./c2sim.md): export options
