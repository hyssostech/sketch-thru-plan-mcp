---
id: installation
title: Installation
sidebar_position: 2
---

# Installation

## npm

```bash
npm install --save sketch-thru-plan-sdk
```

## CDN (script tag)

Embed directly using [jsDelivr](https://www.jsdelivr.com/package/npm/sketch-thru-plan-sdk). It is recommended to pin a specific version rather than `@latest` to prevent breaking changes:

```html
<!-- Include _after_ external services such as Microsoft Cognitive Services Speech -->
<script src="https://cdn.jsdelivr.net/npm/sketch-thru-plan-sdk@latest/dist/sketch-thru-plan-sdk-bundle-min.js"></script>
```

## Referencing the SDK

The SDK is built as a **UMD** library, compatible with plain vanilla (IIFE), AMD, and CommonJS. An **ESM** bundle is also included (`sketch-thru-plan-sdk-bundle.esm.js`).

### Vanilla JavaScript (IIFE)

When used in vanilla JavaScript, access types via the `StpSDK` global:

```javascript
const stpsdk = new StpSDK.StpRecognizer(stpconn);
```

### TypeScript / ES Modules

Import the full namespace:

```typescript
import * as StpSDK from "sketch-thru-plan-sdk";
const stpsdk = new StpSDK.StpRecognizer(stpconn);
```

Or import individual types:

```typescript
import { StpWebSocketsConnector, StpRecognizer, StpSymbol } from "sketch-thru-plan-sdk";
const stpsdk = new StpRecognizer(stpconn);
```

## Plugins

The SDK uses a plugin architecture. Install the plugins you need for your application:

| Plugin | Purpose | Source |
|--------|---------|--------|
| WebSocket Connector | Communication with STP Engine | Built into SDK |
| Azure Speech Plugin | Microsoft Azure Speech-to-Text | [`@hyssostech/azurespeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech/azurespeech-plugin) |
| AWS Speech Plugin | Amazon Transcribe | [`@hyssostech/awsspeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/speech/awsspeech-plugin) |
| Google Maps Adapter | Sketching on Google Maps | [`plugins/maps/googlemaps`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/googlemaps) |
| Leaflet Adapter | Sketching on Leaflet maps | [`plugins/maps/leaflet`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/leaflet) |
| ArcGIS Adapter | Sketching on ArcGIS maps | [`plugins/maps/arcgis`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/maps/arcgis) |
| JMS Renderer | MIL-STD-2525 symbology (milsymbol + mil-sym-js) | [`plugins/renderers/milsymjs`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/renderers/milsymjs) |
| MilsymTs Renderer | MIL-STD-2525D/E via WebRenderer | [`plugins/renderers/milsymts`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/renderers/milsymts) |
