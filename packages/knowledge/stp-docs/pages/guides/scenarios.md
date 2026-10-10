---
id: scenarios
title: Scenarios
sidebar_position: 5
---

# Scenarios

STP scenarios are collections of related objects. A scenario consists of a friendly and a hostile Course of Action (COA), each of which may include Symbols, Tasks, and Task Org/ORBATs.

STP supports **collaboration** — multiple UI apps connected to the Engine can share edits, observe each other's actions, and build upon each other's work. This shared context is a *scenario*.

:::note
Client apps should always load a scenario as the basis for interaction — a new blank one, one loaded from storage, or one joined from the Engine.
:::

## Creating a New Scenario

```javascript
await stpsdk.createNewScenario("MyApp");
```

Any previously loaded scenario is discarded. Connected clients may see delete events as the previous context is cleared.

## Joining an Active Scenario

If a scenario is already loaded in STP (from a previous run or another client), join it:

```javascript
if (await stpsdk.hasActiveScenario()) {
    await stpsdk.joinScenarioSession();
}
```

This replays symbol and task events locally (via your `onSymbolAdded`, `onTaskAdded`, etc. handlers) so your app can render the current state. **Events are not broadcast to other clients** — each client joins independently.

:::info
`hasActiveScenario()` checks for a "planning_scenario" object created by `createNewScenario()` or `loadNewScenario()`. If you receive `false` even though objects exist, use `getScenarioContent()` as a fallback.
:::

## Saving Scenarios

```javascript
if (await stpsdk.hasActiveScenario()) {
    let content = await stpsdk.getScenarioContent();
    // Save 'content' to persistent storage
}
```

The returned string is STP's native serialization format, ready for `loadNewScenario()`.

## Loading Scenarios

```javascript
await stpsdk.loadNewScenario(content);
```

Unlike `joinScenarioSession()`, load events **are propagated to all clients** in the session, updating everyone with the same content.

## Synchronizing Content

`syncScenarioSession()` is a **bidirectional** merge of local content with STP's state:

```javascript
await stpsdk.syncScenarioSession(content, 90);
```

This is useful when parts of a plan were developed offline and need to be reconciled with a collaborative session. Synchronization rules:

1. Objects only in the loaded content → **added** to the session
2. Objects in both → the **more recent** version (by timestamp) wins
3. Objects marked as deleted in the loaded content → **deleted** in the session (but not vice-versa)

:::caution
These rules are lenient and leave space for potential conflicts. Proper division of labor — so users know who "owns" which objects — is the primary conflict avoidance strategy.
:::

## Startup Pattern

A recommended startup sequence:

```javascript
map.load();

if (!(await stpsdk.hasActiveScenario())) {
    await stpsdk.createNewScenario(appName);
    log("New scenario created");
} else {
    log("Active scenario found — Join or Sync to display content");
}
```

## All Methods

| Method | Description |
|--------|-------------|
| `createNewScenario(name, timeout?)` | Create a blank scenario, discarding any previous one |
| `hasActiveScenario()` | Check if a scenario is loaded in STP |
| `joinScenarioSession(timeout?)` | Replay current scenario locally |
| `getScenarioContent(timeout?)` | Retrieve scenario as a serialized string |
| `loadNewScenario(content, timeout?)` | Load scenario from string (broadcasts to all clients) |
| `syncScenarioSession(content, timeout?)` | Bidirectional merge of content with session state |

All methods return Promises and accept an optional `timeout` in seconds (default: 30).

---

:::info Source & Samples
Full scenario management sample: [sketch-thru-plan-sdk-js/samples/scenario](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/scenario)
:::
