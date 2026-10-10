---
id: getting-started
title: Getting Started
sidebar_position: 3
---

# Getting Started

This tutorial walks through building a browser app that uses the STP SDK to create military symbols via combined speech and sketch on a Leaflet map. By the end you will have a working app that:

1. Connects to an STP Engine
2. Collects strokes (sketches) from the user
3. Activates speech recognition while sketching
4. Displays recognized military symbols on the map

## Prerequisites

- **STP Engine** (v5.9.9+) running on an accessible server
- A subscription key for Microsoft Azure [Speech service](https://docs.microsoft.com/azure/cognitive-services/speech-service/get-started)
- A PC or Mac with a working microphone
- A way to serve the page over HTTPS (for microphone access)

## Configuration

The SDK and samples rely on three categories of configuration:

1. **Map**: the mapping provider API credential, initial center (lat/lon in decimal degrees), and zoom level
2. **Speech**: the service subscription key, region, recognition language, and optional custom endpoint
3. **STP Engine**: the WebSocket endpoint for the STP Engine (hostname and port, or a reverse-proxy URL)

### Provide via querystring

```
https://your-host/quickstart/ts/dist/index.html?stpurl=ws://localhost:9599&lat=58.96&lon=11.19&zoom=13&azkey=YOUR_KEY&azregion=eastus&azlang=en-US
```

| Parameter | Description |
|-----------|-------------|
| `stpurl` | STP WebSocket URL |
| `lat`, `lon` | Map center (decimal degrees) |
| `zoom` | Initial zoom level |
| `azkey` | Azure Speech subscription key |
| `azregion` | Azure Speech service region |
| `azlang` | Recognition language (default `en-US`) |
| `azendp` | Optional custom speech model endpoint |
| `mapkey` | Google Maps API key (if using Google Maps) |

### Provide via code

```javascript
const webSocketUrl = "ws://<STP server>:<STP port>"; // e.g., ws://localhost:9599
const azureSubscriptionKey = "<YOUR_AZURE_SPEECH_KEY>";
const azureServiceRegion = "<YOUR_AZURE_REGION>";     // e.g., eastus
const azureLanguage = "en-US";
const mapCenter = { lat: 58.967774948, lng: 11.196062412 };
const zoomLevel = 13;
```

## Step 1: Create the Connector

The connector provides communication services to STP. The built-in WebSocket connector talks to STP's native Publish/Subscribe system:

```javascript
const stpconn = new StpSDK.StpWebSocketsConnector(webSocketUrl);
```

## Step 2: Initialize the Recognizer

The `StpRecognizer` takes the connector (and optional speech plugins) as parameters:

```javascript
const stpsdk = new StpSDK.StpRecognizer(stpconn);
```

## Step 3: Subscribe to Events

**Subscribe before connecting** — the SDK uses your subscriptions to tell STP which events to send.

```typescript
// A new symbol has been recognized and added
stpsdk.onSymbolAdded = (alternates: StpSymbol[], isUndo: boolean) => {
    let gj = new BasicRenderer(alternates[0]).asGeoJSON();
    map.addFeature(gj);
};

// An existing symbol was modified
stpsdk.onSymbolModified = (poid: string, symbol: StpSymbol, isUndo: boolean) => {
    map.removeFeature(poid);
    let gj = new BasicRenderer(symbol).asGeoJSON();
    map.addFeature(gj);
};

// A symbol was deleted
stpsdk.onSymbolDeleted = (poid: string, isUndo: boolean) => {
    map.removeFeature(poid);
};

// Processed ink can be cleared
stpsdk.onInkProcessed = () => {
    map.clearInk();
};

// Speech feedback
stpsdk.onSpeechRecognized = (phrases: string[]) => {
    if (phrases && phrases.length > 0) {
        log(phrases[0]);
    }
};

// STP system messages
stpsdk.onStpMessage = (msg: string, level: StpMessageLevel) => {
    log(msg, level, true);
};
```

### Event summary

| Event | Triggered when... |
|-------|-------------------|
| `onSymbolAdded` | A new symbol is created from speech + sketch |
| `onSymbolModified` | A symbol's properties are changed |
| `onSymbolDeleted` | A symbol is removed |
| `onInkProcessed` | Strokes have been processed (clear the ink) |
| `onSpeechRecognized` | Speech-to-text results are available (for display) |
| `onStpMessage` | STP has a system message for the user |

## Step 4: Connect to STP

```typescript
try {
    await stpsdk.connect("MyApp", 10);
} catch (error) {
    console.error("Failed to connect:", error);
}
```

## Step 5: Send Sketch Events

STP needs two events from the user's sketching:

### Pen down — stroke start

```typescript
map.onStrokeStart = (location: LatLon, timestamp: string) => {
    // Notify STP
    stpsdk.sendPenDown(location, timestamp);
    // Start speech recognition (async)
    recognizeSpeech();
};
```

### Stroke completed — pen up

```typescript
map.onStrokeCompleted = (
    pixelBoundsWindow: Size,
    topLeftGeoMap: LatLon,
    bottomRightGeoMap: LatLon,
    strokePoints: LatLon[],
    timeStrokeStart: string,
    timeStrokeEnd: string,
    intersectedPoids: string[]
) => {
    stpsdk.sendInk(
        pixelBoundsWindow,
        topLeftGeoMap,
        bottomRightGeoMap,
        strokePoints,
        timeStrokeStart,
        timeStrokeEnd,
        intersectedPoids
    );
};
```

:::info Intersected Symbols
`intersectedPoids` should contain the unique identifiers of symbols that the stroke crosses. This enables edit-by-sketch operations (e.g., "delete this", "move here"). Pass an empty array if you do not compute hit-testing.
:::

## Step 6: Collect Speech

Speech is collected via a speech plugin. The simplest strategy activates the microphone at stroke start:

```typescript
async function recognizeSpeech() {
    try {
        const speechreco = new StpSDK.AzureSpeechRecognizer(
            azureSubscriptionKey, azureServiceRegion
        );
        let recoResult = await speechreco.recognizeOnce();
        if (recoResult) {
            stpsdk.sendSpeechRecognition(
                recoResult.results, recoResult.startTime, recoResult.endTime
            );
        }
    } catch (e) {
        console.error("Speech error:", e.message);
    }
}
```

## Step 7: Handle Feature Selection

When a user clicks a rendered symbol, display info and enable actions:

```typescript
map.onSelection = (symbol: StpSymbol) => {
    let contentString = buildInfo(symbol);
    if (contentString && symbol.poid && symbol.location?.centroid) {
        map.displayInfo(contentString, symbol.location.centroid, [
            {
                selector: '#delButton',
                handler: () => stpsdk.deleteSymbol(symbol.poid!),
                closeInfo: true,
            },
        ]);
    }
};
```

## Try It

Once running, enter symbols by sketching and speaking:

| Sketch | Speak | Result |
|--------|-------|--------|
| Point (or small line) | "Infantry Company" | Unit symbol |
| Point | "Recon Platoon" | Unit symbol |
| Line | "Phase Line Blue" | Tactical graphic |
| Line | "Main Attack Boston" | Tactical graphic |
| Area | "Objective Bravo" | Tactical graphic |
| Area | "Assembly Area" | Tactical graphic |

:::tip Pan and zoom
Hold the **Ctrl** key while dragging to pan and zoom the map.
:::

## Next Steps

- [Symbols & Rendering](./guides/symbols-and-rendering) — production-quality MIL-STD-2525 rendering and symbol properties
- [Tasks](./guides/tasks) — auto-detected tasks from multiple symbols
- [Task Org / ORBAT](./guides/task-org) — pre-defined unit organizations
- [Speech Plugin](./plugins/speech) — recognition strategies and alternative services

---

:::info Source & Samples
Quickstart source code and working examples: [sketch-thru-plan-sdk-js/quickstart](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/quickstart)
:::
