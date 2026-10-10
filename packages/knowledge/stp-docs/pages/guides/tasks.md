---
id: tasks
title: Tasks
sidebar_position: 2
---

# Tasks

STP automatically identifies **tasks** from multiple symbols. For example, when a Unit, an Objective, and a Main Attack symbol (starting at the Unit and ending inside the Objective) are placed on the map, STP detects a potential attack task.

When symbols of an identified task are modified or deleted, STP detects the changes and modifies or removes the affected task.

## Task Events

Subscribe to task event handlers **before connecting** to STP:

```javascript
// A new task has been recognized
stpsdk.onTaskAdded = (poid, alternates, taskPoids, isUndo) => {
    log("Task added: " + alternates[0].description);
};

// Task properties were modified
stpsdk.onTaskModified = (poid, alternates, taskPoids, isUndo) => {
    log("Task modified: " + poid + " " + alternates[0].description);
};

// A task was removed
stpsdk.onTaskDeleted = (poid, isUndo) => {
    log("Task removed: " + poid);
};
```

### Event parameters

| Parameter | Description |
|-----------|-------------|
| `poid` | Unique identifier assigned by STP |
| `alternates` | Ranked array of `StpTask` interpretations. An `Attack` often includes alternates for `Attack to Fix`, `Secure`, `Destroy`, etc. |
| `taskPoids` | Array of unique identifiers of all Tactical Graphics associated with the task |
| `isUndo` | `true` when the event results from undo/redo |

## StpTask Properties

| Property | Description |
|----------|-------------|
| `fsTYPE` | `task` |
| `poid` | Unique identifier |
| `parentCoa` | COA this task belongs to |
| `creatorRole` | Role that created the task |
| `confidence` | Recognition confidence (1.0 = 100%) |
| `alt` | Rank among interpretation hypotheses |
| `description` | Task description |
| `who` | Unique id of the executing unit |
| `supported` | Unique id of supported unit, if applicable |
| `tgs` | Tactical Graphics unique ids |
| `name` | Task name, e.g. `AssaultObjectiveOnAxis` |
| `how` | `TaskHow` enum value |
| `what` | `TaskWhat` enum value |
| `why` | `TaskWhy` enum value |
| `startTime` / `endTime` | Time slots |
| `speech` | Associated speech |
| `language` | Language describing the task |
| `taskStatus` | `implicit` (auto-detected) or `explicit` (manually created) |
| `uiStatus` | `confirming` or `confirmed` |
| `prob` | Interpretation likelihood |

## Task Enums

<details>
<summary><strong>TaskWhat</strong> — what action is being performed</summary>

`NotSpecified`, `Ambush`, `Block`, `Breach`, `Bypass`, `Clear`, `Defeat`, `Delay`, `Destroy`, `Disrupt`, `Fix`, `Follow`, `FollowAndAssume`, `FollowAndSupport`, `Halt`, `Move`, `Neutralize`, `Observe`, `Occupy`, `Patrol`, `Penetrate`, `Receive`, `Reinforce`, `Retain`, `Secure`, `Seize`, `Supply`, `Turn`, and many more domain-specific values.

</details>

<details>
<summary><strong>TaskHow</strong> — how the action is executed</summary>

`NotSpecified`, `AirAssault`, `AreaDefense`, `Assault`, `Attack`, `AttackInZone`, `AttackByFire`, `Counterattack`, `Cover`, `Defend`, `Guard`, `MobileDefense`, `Screen`, `SearchAndAttack`, `SupportByFire`, `Withdrawal`, and more.

</details>

<details>
<summary><strong>TaskWhy</strong> — purpose of the action</summary>

`Unknown`, `Allow`, `Cause`, `Create`, `Deceive`, `Deny`, `Divert`, `Enable`, `Envelop`, `Influence`, `Open`, `Prevent`, `Protect`, `Support`, `Surprise`.

</details>

## Programmatic Task Manipulation

Task edits performed via a client UI (e.g., a Task Editor or Sync Matrix) need to be communicated to STP for consistency and propagation to other connected clients.

| Method | Description |
|--------|-------------|
| `addTask(task)` | Request task addition. STP responds with `onTaskAdded`. |
| `updateTask(poid, alternates)` | Request task update. STP responds with `onTaskModified`. |
| `deleteTask(poid)` | Request task deletion. STP responds with `onTaskDeleted`. |
| `confirmTask(poid, nBestIndex)` | Confirm a specific alternate. STP responds with `onTaskModified` (`uiStatus: 'confirmed'`). |

:::tip Best practice
Update your UI only in response to STP events (not immediately on user action). This keeps all connected clients consistent with the Engine's state.
:::

## Cached State

STP caches symbols across connections to support collaboration. To start with a clean slate:

```javascript
await stpsdk.createNewScenario(appName);
```

See the [Scenarios guide](./scenarios) for full scenario management.

---

:::info Source & Samples
Full tasks sample: [sketch-thru-plan-sdk-js/samples/tasks](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/tasks)
:::
