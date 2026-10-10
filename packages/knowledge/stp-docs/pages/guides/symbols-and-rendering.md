---
id: symbols-and-rendering
title: Symbols & Rendering
sidebar_position: 1
---

# Symbols & Rendering

This guide covers production-quality MIL-STD-2525 rendering, symbol properties, and programmatic symbol manipulation.

## Rendering with JMS

The quickstart uses placeholder shapes. For real applications, the **JMS Renderer** provides standard 2525 symbology:

- **Single-point SVG icons** via Spatial Illusions `milsymbol`
- **Multipoint tactical graphics** via Mission Command `mil-sym-js`

```javascript
const gj = new JmsRenderer(alternates[0], map.getBounds()).asGeoJSON();
map.addFeature(gj);
```

The renderer is included as a local bundle. See the [Renderers plugin](../plugins/renderers) for the full renderer contract.

## Map adapter selection

The basic sample supports both Google Maps and Leaflet adapters, switchable at runtime:

- **Dropdown** at the top of the page (reloads with your choice)
- **Querystring**: `?map=gmaps` or `?map=leaflet`

See the [Map Adapters plugin](../plugins/map-adapters) for the generic adapter API.

## Symbol Events

Wire these handlers to keep the map display in sync with STP:

```javascript
stpsdk.onSymbolAdded = (alternates, isUndo) => {
    const gj = new JmsRenderer(alternates[0], map.getBounds()).asGeoJSON();
    map.addFeature(gj);
};

stpsdk.onSymbolModified = (poid, symbol, isUndo) => {
    map.removeFeature(poid);
    const gj = new JmsRenderer(symbol, map.getBounds()).asGeoJSON();
    map.addFeature(gj);
};

stpsdk.onSymbolDeleted = (poid, isUndo) => {
    map.removeFeature(poid);
};
```

Each handler receives an `isUndo` flag that is `true` when the event results from an undo/redo operation.

## Programmatic Symbol Manipulation

The SDK exposes methods for programmatically adding, updating, and deleting symbols outside of the normal sketch-and-speech flow. All of these are **requests** — wait for the corresponding STP event before updating your own state.

| Method | Description |
|--------|-------------|
| `addSymbol(symbol)` | Request that a new symbol be added. STP responds with `onSymbolAdded`. |
| `updateSymbol(poid, symbol)` | Request that an existing symbol be modified. STP responds with `onSymbolModified`. |
| `deleteSymbol(poid)` | Request that a symbol be removed. STP responds with `onSymbolDeleted`. |
| `chooseAlternate(poid, nBestIndex)` | Select a different recognition alternate for a symbol. |

### Deleting on selection

A common pattern: clicking a symbol opens an info popup with a Delete button:

```javascript
map.onSelection = (symbol) => {
    map.displayInfo(
        buildInfo(symbol),
        symbol.location.centroid,
        [{
            selector: '#delButton',
            handler: () => stpsdk.deleteSymbol(symbol.poid),
            closeInfo: true,
        }]
    );
};
```

## Symbol Properties

STP provides a rich set of properties on each `StpSymbol`:

| Property | Description |
|----------|-------------|
| `fsTYPE` | Symbol type: `unit`, `mootw`, `equipment`, `tg`, `task` |
| `poid` | STP unique identifier |
| `parentCoa` | Unique id of the COA this symbol belongs to |
| `creatorRole` | Role that created the symbol: `S2`, `S3`, `S4`, `Eng`, `FSO` |
| `interval` | Symbol creation time interval |
| `confidence` | Recognition confidence score (1.0 = 100%) |
| `alt` | Rank among interpretation hypotheses |
| `sidc.partA` | Part A of the 2525D id |
| `sidc.partB` | Part B of the 2525D id |
| `sidc.partC` | Part C of the 2525D id |
| `sidc.symbolSet` | 2525D Symbol Set |
| `sidc.legacy` | 2525C SIDC |
| `location` | Location of the symbol (see below) |
| `shortDescription` | Essential distinguishing elements, e.g. designators |
| `description` | Name/type plus designators |
| `fullDescription` | Complete description including affiliation, status, all decorators |
| `affiliation` | `pending`, `unknown`, `assumedfriend`, `friend`, `neutral`, `suspected`, `hostile` |
| `echelon` | `none` through `command` |
| `parent` | Parent unit designator |
| `designator1` | Main designator |
| `designator2` | Additional designator |
| `status` | `present`, `anticipated` |
| `modifier` | HQ/Task Force: `none`, `dummy`, `hq`, `task_force`, etc. |
| `strength` | `none`, `reduced`, `reinforced`, `reduced_reinforced` |
| `branch` | `weapon`, `ground_unit`, `equipment`, `installation`, etc. |
| `timeFrom` / `timeTo` | Time window (e.g., Restricted Operations Zone) |
| `altitude` | Altitude, if applicable |
| `minAltitude` / `maxAltitude` | Altitude range, if supported |
| `toUnitPoid` | For symbols from a Task Org, the source Task Org Unit id |

### Location Properties

| Property | Description |
|----------|-------------|
| `fsTYPE` | `point`, `line`, `area` |
| `width` | Location width, if applicable |
| `shape` | Gesture type: `point`, `line`, `area`, `straightline`, `arrowthin`, `arrowfat`, `hook`, `ubend`, `vee`, `opencircle`, `multipoint` |
| `radius` | Radius of the containing area (0 for points) |
| `coords` | Array of `{ lat, lon }` coordinates |
| `centroid` | Location centroid `{ lat, lon }` |
| `candidatePoids` | Unique ids of symbols intersected by the gesture |

---

:::info Source & Samples
Full sample with rendering and symbol manipulation: [sketch-thru-plan-sdk-js/samples/basic](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/basic)
:::
