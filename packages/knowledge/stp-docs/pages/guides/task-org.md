---
id: task-org
title: Task Org / ORBAT
sidebar_position: 3
---

# Task Org / ORBAT

STP can employ pre-defined ORBATs or Task Orgs (TOs) defining unit organization and equipment. When loaded, TOs provide a streamlined ability to place units by just speaking their designators — sketching a point and saying "Alpha Three One" places an armored infantry company `A/3-1` if that unit is defined in the active TO.

## Structure

A TO is defined by three element types:

1. **Task Org** — properties of the TO (name, affiliation, update timestamp)
2. **Task Org Units** — unit definitions that are part of the TO
3. **Task Org Relationships** — hierarchy amongst the units

TO definitions are persisted in `.org` files by convention.

## Activation Rules

Multiple TOs can be loaded; one is selected as *active* (its unit language is what gets recognized). Selection is automatic based on these rules:

- **Role-less**: the last loaded TO is active
  - Load a friendly TO → it's active, default affiliation is friendly
  - Then load a hostile TO → the hostile TO is active, default affiliation is hostile
- **With roles**: switching role activates the TO matching that role's affiliation
  - Select S3 → friendly TO becomes active
  - Switch to S2 → hostile TO becomes active
- **Missing TO for a role**: if no TO matches the role's affiliation, the TO language is cleared (back to non-TO recognition)

## Lifecycle

- Multiple TOs can be loaded — they are **not active** until `setDefaultTaskOrg()` is called
- Setting a default triggers language model generation on the server (may take time for larger TOs — show progress indicators)
- Changes to TO elements are **not immediately applied** — call `setDefaultTaskOrg()` again after editing
- TOs should cover the units expected in a plan and should not include units never expected to appear

## Loading a TO

Use `importTaskOrgContent()` to load TO content, then `setDefaultTaskOrg()` to activate it:

```javascript
// Load from stored content (typically retrieved from persistent storage)
let toPoid = await stpsdk.importTaskOrgContent(content);

// Set as the default (triggers language model generation)
await stpsdk.setDefaultTaskOrg(toPoid);
```

## Saving a TO

Retrieve TO content for persistence with `getTaskOrgContent()`:

```javascript
let toContent = await stpsdk.getTaskOrgContent(toPoid);
// Save toContent to persistent storage
```

## Handling TO Switch Events

The `onTaskOrgSwitched` event fires whenever the active TO changes:

```javascript
stpsdk.onTaskOrgSwitched = (taskOrg) => {
    if (taskOrg) {
        console.log("Active TO:", taskOrg.name, taskOrg.affiliation);
    } else {
        console.log("TO was reset (no active TO)");
    }
};
```

:::info
When a TO is reset (e.g., switching to a role with no matching TO), the `taskOrg` parameter is `null`.
:::

## Entity Events

Subscribe to these events before connecting:

### Task Org events

```javascript
stpsdk.onTaskOrgAdded = (taskOrg, isUndo) => { /* ... */ };
stpsdk.onTaskOrgModified = (poid, taskOrg, isUndo) => { /* ... */ };
stpsdk.onTaskOrgDeleted = (poid, isUndo) => { /* ... */ };
```

### Task Org Unit events

```javascript
stpsdk.onTaskOrgUnitAdded = (toUnit, isUndo) => { /* ... */ };
stpsdk.onTaskOrgUnitModified = (poid, toUnit, isUndo) => { /* ... */ };
stpsdk.onTaskOrgUnitDeleted = (poid, isUndo) => { /* ... */ };
```

### Task Org Relationship events

```javascript
stpsdk.onTaskOrgRelationshipAdded = (toRel, isUndo) => { /* ... */ };
stpsdk.onTaskOrgRelationshipModified = (poid, toRel, isUndo) => { /* ... */ };
stpsdk.onTaskOrgRelationshipDeleted = (poid, isUndo) => { /* ... */ };
```

## Types

### StpTaskOrg

| Property | Description |
|----------|-------------|
| `fsTYPE` | `task_org` |
| `poid` | Unique identifier |
| `name` | TO name, e.g. `2-69` |
| `affiliation` | `friend` or `hostile` |
| `timestamp` | Update date |

### StpTaskOrgUnit

Extends `StpSymbol` with additional properties:

| Property | Description |
|----------|-------------|
| `fsTYPE` | `task_org_unit` |
| `unitType` | Function description, e.g. `MECHANIZED INFANTRY` |
| `info` | Additional information |
| `name` | Speech name pattern. Supports grouping `()`, alternatives `|`, and optionals `[]`. Example: `(ONE \| FIRST) [ROYAL] IRISH [GUARDS]` accepts "ONE IRISH", "FIRST ROYAL IRISH GUARDS", etc. |

Plus all standard `StpSymbol` properties (`sidc`, `affiliation`, `echelon`, `designator1`, etc.).

### StpTaskOrgRelationship

| Property | Description |
|----------|-------------|
| `fsTYPE` | `task_org_relationship` |
| `parent` | Parent Task Org Unit unique id |
| `child` | Child Task Org Unit unique id |
| `relationship` | `CommandRelationship` enum value |

### CommandRelationship Enum

| Value | Description |
|-------|-------------|
| `None` | No relationship |
| `Organic` | Organic |
| `Attached` | Attached |
| `Assigned` | Assigned |
| `AdCon` | Administrative Control |
| `OpCon` | Operational Control |
| `TaCon` | Tactical Control |
| `DirectSupport` | Direct Support |
| `Reinforcing` | Reinforcing |
| `GeneralSupportReinforcing` | General Support Reinforcing |
| `GeneralSupport` | General Support |

## Programmatic TO Manipulation

| Method | Description |
|--------|-------------|
| `addTaskOrg(taskOrg)` | Add a new TO to the scenario |
| `updateTaskOrg(poid, taskOrg)` | Update TO definition |
| `deleteTaskOrg(poid)` | Delete TO from scenario |
| `addTaskOrgUnit(toUnit)` | Add a unit to a TO |
| `updateTaskOrgUnit(poid, toUnit)` | Update a TO unit |
| `deleteTaskOrgUnit(poid)` | Delete a TO unit |
| `addTaskOrgRelationship(toRel)` | Add a relationship |
| `updateTaskOrgRelationship(poid, toRel)` | Update a relationship |
| `deleteTaskOrgRelationship(poid)` | Delete a relationship |

:::tip
Update your UI only in response to STP events, not immediately on user action, to keep all clients consistent.
:::

---

:::info Source & Samples
Full Task Org sample: [sketch-thru-plan-sdk-js/samples/to](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/to)
:::
