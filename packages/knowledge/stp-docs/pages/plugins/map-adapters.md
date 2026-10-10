---
id: map-adapters
title: Map Adapters
sidebar_position: 3
---

# Map Adapters

STP is **map-agnostic** — any mapping library can serve as the sketching surface as long as lat/lon coordinates (decimal degrees) are available for user input and feature placement. Adapters wire common sketching and selection events and render STP features on the chosen map provider.

## Available Adapters

| Adapter | Folder |
|---------|--------|
| Google Maps | [`plugins/maps/googlemaps`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/googlemaps) |
| Leaflet | [`plugins/maps/leaflet`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/leaflet) |
| ArcGIS | [`plugins/maps/arcgis`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/arcgis) |

The [basic sample](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/basic) demonstrates switching between Google Maps and Leaflet at runtime.

## Core Responsibilities

Any adapter must support:

1. **Pen-down event** — fired at gesture start with location and timestamp
2. **Stroke-completed event** — fired on pen-up with viewport info and full stroke
3. **Selection event** — fired when a rendered feature is clicked
4. **Feature rendering** — add/remove STP features as GeoJSON; display info; clear ink

## Generic API

### Pen down (stroke start)

```javascript
map.onStrokeStart = (location, timestamp) => {
    stpsdk.sendPenDown(location, timestamp);
    recognizeSpeech(); // start speech async
};
```

### Stroke completed (pen up)

```javascript
map.onStrokeCompleted = (
    pixelBoundsWindow,
    topLeftGeoMap,
    bottomRightGeoMap,
    strokePoints,
    timeStrokeStart,
    timeStrokeEnd,
    intersectedPoids
) => {
    stpsdk.sendInk(
        pixelBoundsWindow, topLeftGeoMap, bottomRightGeoMap,
        strokePoints, timeStrokeStart, timeStrokeEnd,
        intersectedPoids
    );
};
```

#### Intersected features (`intersectedPoids`)

This array is critical for **edit-by-sketch** workflows ("delete this", "move here"). It should contain the `poid` values of all displayed features that the stroke crosses.

- Use hit-shape polygons from renderers (if available) for precise intersection
- For multipoint features, segment intersection tests suffice
- Pass an empty array if you cannot compute hit-testing (edit commands will be disabled)

### Feature selection

```javascript
map.onSelection = (symbol) => {
    // Display info, enable delete, etc.
};
```

### Load the map

```javascript
map.load();
```

### Add / remove features

```javascript
map.addFeature(symbolGeoJSON);
map.removeFeature(poid);
```

### Display contextual info

```javascript
map.displayInfo(html, { lat, lon }, [
    { selector: '#delete', handler: () => { /* ... */ }, closeInfo: true }
]);
```

### Clear sketch ink

```javascript
map.clearInk();
```

## Building a Custom Adapter

Implement the same event contract and methods described above. The adapter should:

1. Initialize the chosen mapping library (API keys, CSS/JS, etc.)
2. Capture mouse/pen/touch events to produce stroke data
3. Convert pixel coordinates to lat/lon decimal degrees
4. Render GeoJSON features from STP on the map
5. Fire `onStrokeStart`, `onStrokeCompleted`, and `onSelection` with the documented parameters

See the existing adapter source code for reference implementations.

---

:::info Source & Samples
Map adapter plugin source and documentation: [sketch-thru-plan-sdk-js/plugins/maps](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps)
:::
