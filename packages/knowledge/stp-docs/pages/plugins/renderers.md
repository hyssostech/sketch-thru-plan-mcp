---
id: renderers
title: Renderers
sidebar_position: 4
---

# Rendering Plugins

Renderers convert STP symbols into visual representations — GeoJSON features with optional SVG icons for map display. Two implementations are provided:

## Available Renderers

### JmsRenderer (milsymjs)

Combines Spatial Illusions **milsymbol** for single-point SVG icons with the legacy Mission Command multipoint renderer. Produces high-fidelity GeoJSON for tactical graphics, plus enriched label overlays and anchors.

### MilsymTsRenderer (milsymts)

Uses Mission Command's modern TypeScript **WebRenderer** for MIL-STD-2525D and 2525E multipoint symbols. Points are returned as GeoJSON without SVG overlays.

## IStpRenderer Interface

All renderers implement a common contract so clients can swap implementations transparently.

### `asGeoJSON(): any`

Returns a GeoJSON Feature or FeatureCollection representing the symbol.

- Uses `[lon, lat]` coordinate order
- Preserves core STP properties (`poid`, `sidc`, `fsTYPE`, `affiliation`, etc.)
- May enrich `properties.rendering` with visualization payloads:
  - `type`: `'icon'` or `'label'`
  - `position`: `{ lat, lon }`
  - `svg`: Base64-encoded SVG string
  - `anchor`: `{ x, y }` pixel anchor within SVG
  - `shape`: array of points describing the clickable area
- For complex multipoints, may return a `GeometryCollection` or `FeatureCollection`

### `asSVG(): Array<any> | null`

Optional. Returns SVG renderings and metadata (common for single-point symbols). Returns `null` if not supported.

## Usage

```javascript
// With JmsRenderer
const gj = new JmsRenderer(symbol, map.getBounds()).asGeoJSON();
map.addFeature(gj);

// With MilsymTsRenderer
const gj = new MilsymTsRenderer(symbol).asGeoJSON();
map.addFeature(gj);
```

## Behavioral Notes

- **Error handling**: renderers throw when the symbol lacks sufficient location data (coords and centroid)
- **Bounds**: some renderers accept map bounds at construction time for label placement and geometry segmentation
- **Properties**: clients can rely on STP's standard properties (below) regardless of renderer

## STP Symbol Properties for Rendering

Map these properties to your renderer's inputs:

| Property | Description |
|----------|-------------|
| `fsTYPE` | `unit`, `mootw`, `equipment`, `tg`, `task` |
| `poid` | Unique identifier |
| `sidc.partA/B/C` | 2525D symbol identification |
| `sidc.symbolSet` | 2525D Symbol Set |
| `sidc.legacy` | 2525C SIDC |
| `affiliation` | `friend`, `hostile`, `neutral`, `unknown`, etc. |
| `echelon` | `team` through `command` |
| `status` | `present`, `anticipated` |
| `modifier` | `hq`, `task_force`, etc. |
| `strength` | `reduced`, `reinforced`, `reduced_reinforced` |
| `designator1/2` | Symbol designators |
| `shortDescription` | Brief description for labels |
| `description` | Full name/type |
| `fullDescription` | Complete description with all decorators |

### Location Properties

| Property | Description |
|----------|-------------|
| `fsTYPE` | `point`, `line`, `area` |
| `shape` | Gesture type: `point`, `line`, `area`, `straightline`, `arrowthin`, `arrowfat`, `hook`, `ubend`, `vee`, `opencircle`, `multipoint` |
| `coords` | Array of `{ lat, lon }` |
| `centroid` | Location centroid `{ lat, lon }` |
| `radius` | Area radius (0 for points) |
| `width` | Width, if applicable |
| `candidatePoids` | IDs of intersected symbols |

## Building a Custom Renderer

1. Implement `asGeoJSON()` returning valid GeoJSON with `[lon, lat]` coordinate order
2. Optionally implement `asSVG()` for single-point icon generation
3. Preserve STP properties on the returned features for downstream consumers
4. Throw on missing location data rather than returning invalid geometries

---

:::info Source & Samples
Renderer plugin source and documentation: [sketch-thru-plan-sdk-js/plugins/renderers](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/renderers)
:::
