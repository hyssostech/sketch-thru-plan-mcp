---
sidebar_label: Event ordering and concurrent edits
sidebar_position: 14
description: In what order STP events arrive after loading, joining or syncing a scenario, what ordering is guaranteed, and what happens when two clients edit the same symbol.
---

# Event ordering and concurrent edits

STP reports changes as events. A request such as `loadNewScenario` tells you
when the engine has finished, but the content arrives as `NewScenario`,
`SymbolAdded`, `TaskAdded` and the task-organization events. This page covers:

- what ordering you can rely on, and what you cannot;
- the sequence of events after a load, a create, a join and a sync;
- what happens when two clients edit the same symbol at the same time.

## What ordering is guaranteed

**One connection is one ordered stream.** The engine writes events and request
replies to your WebSocket through a single queue, and both SDKs handle incoming
messages one at a time, in arrival order:

- JavaScript: handlers such as `onSymbolAdded` run synchronously, one message at
  a time.
- .NET: events are raised one at a time on a background worker, not on your UI
  thread. Marshal to the UI thread yourself (for example `Control.Invoke` or
  `Dispatcher.Invoke`).

**Your own messages are processed in the order you send them.** Requests and
informs on one connection are handled one at a time.

**No order is promised beyond that.** In particular:

- STP does not promise a global order across event kinds. Events you did not
  cause directly, such as `StpMessage`, `RoleSwitched` and `TaskOrgSwitched`,
  can arrive between content events.
- There is no ordering between connections. STP does not guarantee when a
  change made by another client reaches you relative to your own requests and
  their replies.
- A task refers to symbols by poid (`who`, `tgs`). Write handlers that cope
  with a reference to a poid they have not seen yet: buffer the task, or
  render it once the referenced symbols arrive.

## After `loadNewScenario`

A load replaces the scenario in the session. Every client in the session that
has subscribed to the events receives them. On current engines the sequence is:

1. **`NewScenario`.** The engine clears the previous content before it applies
   any of the new content. Treat `NewScenario` as "discard everything you
   hold for this scenario". As noted in [Scenarios](./scenarios.md), clients may
   also see delete events while the previous content is cleared.
2. **One "added" event per object**, in the order the objects are applied:
   `SymbolAdded` for units, tactical graphics and other symbols, `TaskAdded` for
   tasks, and `TaskOrgAdded` / `TaskOrgUnitAdded` / `TaskOrgRelationshipAdded`
   for task-organization content.
   - `loadNewScenario(content)` applies objects in the order they appear in
     `content`.
   - `loadNewScenarioFromObjectSet(objects)` sorts the objects first so that
     referenced objects come before the objects that reference them: COAs,
     task organizations, task-organization units, task-organization
     relationships, units, tactical graphics, other symbols, then tasks.
     Objects of the same kind are ordered by creation time.
3. **No inferred tasks during the load.** Current engines suspend automatic
   task inference while a load runs and restore it afterwards. The `TaskAdded`
   events you see during a load are for tasks contained in the content.

The promise returned by `loadNewScenario` resolves once the engine has applied
every object. STP does not guarantee that every "added" event has reached you
by then. Drive rendering from the events, not from the promise.

## After `createNewScenario`

`createNewScenario` clears the session and starts an empty scenario. You
receive `NewScenario`. Because the new scenario contains no symbols or tasks,
no `SymbolAdded` or `TaskAdded` events follow for it.

## After `joinScenarioSession`

A join does not change the scenario. The engine replays the current content
**to the joining client only**, using the same handlers as live events. Other
clients see nothing.

- **No `NewScenario`** is sent.
- **Replay order**: task-organization units, task-organization relationships,
  units, tactical graphics, other symbols, then tasks. Objects of the same kind
  are ordered by creation time.
- **Deleted objects are skipped.**
- **Not replayed: task organizations themselves (`TaskOrgAdded`).** Call
  `getScenarioTaskOrgList()` to get them.
- **Every replayed event has `isUndo: false`.**
- On current engines the replay is sent before the reply to the join request,
  so your handlers have run by the time `joinScenarioSession()` resolves.

## After `syncScenarioSession`

A sync is a join followed by a merge:

1. The current session content is replayed to you, exactly as in a join.
2. Your local content is merged into the session. Scenario-level and transient
   objects (the planning scenario itself, system state, ink, speech and similar)
   are dropped first, and the rest is applied in dependency order. Each change
   is applied like a normal edit and broadcast to every client in the session
   as an added, modified or deleted event.

The merge rules (which version wins, how deletions propagate) are in
[Scenarios: Synchronizing content](./scenarios.md#synchronizing-content).

## Undo

Events caused by an undo (`undoLastOp`) are ordinary added, modified or deleted
events with `isUndo: true`.

## Two clients editing the same symbol

What happens when two clients edit the same symbol at the same time:

- **There is no locking.** Neither client can reserve a symbol, and STP sends
  no conflict event.
- **Updates are applied one at a time**, in the order they reach the engine.
  The order depends on arrival at the engine, not on the clients' clocks.
- **Each applied update is broadcast.** Every subscribed client in the session,
  including the sender, receives `SymbolModified` with the complete resulting
  symbol. Clients that apply events in order end up with the same state.
- **An update overlays the attributes it carries** onto the current symbol.
  Attributes the update does not carry keep their current values. If two
  clients change different attributes, both changes survive. If they change
  the same attribute, the update applied last wins.

### Stale versions: an update can be dropped silently

Symbols arrive with a `dbVersion`, an opaque identifier that changes on every
write. If the symbol you pass to `updateSymbol` still carries a `dbVersion`, as
it does when you modify and send back an object you received from STP, current
engines apply the update only while that version is still current. If another
client changed the symbol in the meantime, your update is rejected. Because
`updateSymbol` is fire-and-forget, you get no error and no `SymbolModified`.

In effect this is optimistic concurrency without a failure notice. (The
contract currently describes `dbVersion` as ignored on input. On the update
path, current engines do compare it.)

To handle it:

- Build each update from the most recent `SymbolModified` or `SymbolAdded` you
  received for that poid, not from an older copy.
- After sending, wait a bounded time for `SymbolModified` with that poid. If
  none arrives, read the current symbol with `getPoidObject(poid)` and decide
  whether to re-apply your change.
- If you want last-writer-wins instead, leave `dbVersion` out of the object you
  send.
- Do not change local state optimistically. Render the change when
  `SymbolModified` arrives, as the SDK documentation for `updateSymbol`
  advises.

### Other cases

- **Sessions isolate edits.** Clients in different sessions never conflict
  (see [Sessions](./sessions.md)).
- **Offline work merged with `syncScenarioSession`** follows the sync rules: of
  two versions of the same object, the more recent one wins (see
  [Scenarios](./scenarios.md#synchronizing-content)).
- **Dividing the work** so that each user owns a known set of objects remains
  the main way to avoid conflicts. STP does not enforce ownership.

## See also

- [Scenarios](./scenarios.md): load, join and sync
- [Connection lifecycle and reconnecting](./connection-lifecycle.md): events
  missed while disconnected
- [Errors, refusals and timeouts](./errors-and-timeouts.md): fire-and-forget
  calls and timeouts
