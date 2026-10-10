---
id: custom-commands
title: Custom Commands
sidebar_position: 7
---

# Custom Commands

STP supports custom natural language commands that extend its baseline capabilities for domain- or application-specific needs. Commands define the expected speech language and the corresponding gesture (point, line, or area) providing geo-location.

While STP performs interpretation and ranking, the **implementation of behavior** rests with client apps — achieving UI effects or commanding other systems requires local capabilities.

## Example Use Cases

- **Imagery**: mark an area and speak "add imagery"
- **Autonomous tasking**: sketch a tick on an object and speak "track and follow"
- **App actions**: touch anywhere and speak "save project"

## Defining Commands in STP Configuration

Commands are defined in `<STP install folder>\MilTables\AuxiliaryTables\Edits.txt`, a tab-separated file.

| Column | Name | Description |
|--------|------|-------------|
| A | SIC Fragment | Non-2525 symbol id starting with `ED`, following the 9-char pattern |
| B | Features | `type`, `operation`, and `geometry` (see below) |
| C | Symbol Sets | Set to `[adapx10,mcwl14]` |
| D | — | Leave empty |
| E | Speech | Natural language pattern with operators |
| F | Comments | Optional notes |

### Feature properties

- **type**: determines which event fires
  - `edit` → `onSymbolEdited` (local to originating client)
  - `map` → `onMapOperation` (local to originating client)
  - `command` → `onCommand` (propagated to **all** connected clients)
- **operation**: name included in notification events so apps can identify the action
- **geometry**: `point`, `line`, or `area` — the gesture the user sketches alongside speech

### Speech language operators

| Operator | Meaning | Example |
|----------|---------|---------|
| `[]` | Optional | `[THIS]` — "this" is optional |
| `\|` | Alternative | `AREA \| REGION` |
| `()` | Grouping | `(AREA \| REGION)` |

Example: `SEARCH [THIS] (AREA | REGION)` matches "SEARCH AREA", "SEARCH THIS REGION", etc.

:::warning
Avoid language that overlaps with standard military symbol definitions, as it may introduce ambiguity.
:::

## Handling Command Events

### onSymbolEdited

Fired for `type: edit` operations. **Local to the originating client only.**

```javascript
stpsdk.onSymbolEdited = (operation, location) => {
    console.log("Edit:", operation, "gesture:", location.shape);
    // location.candidatePoids contains ids of overlapped symbols
};
```

### onMapOperation

Fired for `type: map` operations. **Local to the originating client only.**

```javascript
stpsdk.onMapOperation = (operation, location) => {
    console.log("Map op:", operation, "gesture:", location.shape);
};
```

### onCommand

Fired for `type: command` operations. **Propagated to all connected clients.**

```javascript
stpsdk.onCommand = (operation, location) => {
    console.log("Command:", operation, "gesture:", location.shape);
};
```

:::caution
Since `onCommand` fires on all clients, take care to avoid multiple clients executing system-wide operations that could clash.
:::

### Location properties in command events

| Property | Description |
|----------|-------------|
| `fsTYPE` | `point`, `line`, or `area` |
| `shape` | Gesture type |
| `coords` | Array of `{ lat, lon }` |
| `centroid` | Centroid of the gesture |
| `candidatePoids` | IDs of symbols the gesture overlaps (requires hit-testing in `sendInk`) |
| `radius` | Radius of the containing area |
| `width` | Width, if applicable |

---

:::info Source & Samples
Full custom commands sample: [sketch-thru-plan-sdk-js/samples/commands](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/commands)
:::
