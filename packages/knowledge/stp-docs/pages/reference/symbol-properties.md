---
id: symbol-properties
title: Symbol Properties
sidebar_position: 2
---

# Symbol Properties

Complete reference for the properties available on `StpSymbol` objects returned by the SDK.

## Core Properties

| Property | Type | Description |
|---|---|---|
| `poid` | `string` | Unique identifier assigned by STP to this symbol |
| `fsTYPE` | `string` | Symbol type: `"unit"`, `"mootw"`, `"equipment"`, `"installation"`, `"tg"` (tactical graphic), `"coa"` (COA shape), `"task"` |
| `confidence` | `number` | Recognition confidence score (0 – 1) |
| `alt` | `number` | Zero-based index in the N-best alternates list |
| `creatorRole` | `string` | Role of the user who created the symbol (e.g., `"s2"`, `"s3"`) |

## Identity / Classification

| Property | Type | Description |
|---|---|---|
| `sidc.partA` | `string` | APP-6D SIDC Part A (10 digits) |
| `sidc.partB` | `string` | APP-6D SIDC Part B (10 digits) |
| `sidc.symbolSet` | `string` | APP-6D Symbol Set code |
| `sidc.legacy` | `string` | MIL-STD-2525C / APP-6B 15-character SIDC |
| `shortDescription` | `string` | Short label, typically `designator/parent` (e.g., `"A/3-1"`) |
| `description` | `string` | Symbol type description (e.g., `"ARMORED CAVALRY RECON COMPANY"`) |
| `fullDescription` | `string` | Complete human-readable description including affiliation, type, and unit designation |
| `affiliation` | `string` | `"friend"`, `"hostile"`, `"neutral"`, `"unknown"` |

## Military Attributes

| Property | Type | Description |
|---|---|---|
| `echelon` | `string` | Echelon level: `"team"`, `"squad"`, `"section"`, `"platoon"`, `"company"`, `"battalion"`, `"regiment"`, `"brigade"`, `"division"`, `"corps"`, `"army"`, `"none"` |
| `parent` | `string` | Parent unit designator (e.g., `"3-1"` for 3rd Battalion, 1st Regiment) |
| `designator1` | `string` | Primary designator (e.g., company letter `"A"`) |
| `designator2` | `string` | Secondary designator (less common) |
| `status` | `string` | `"present"` or `"anticipated"` |
| `modifier` | `string` | Modifier: `"none"`, `"reinforced"`, `"reduced"`, `"reinforced_reduced"` |
| `strength` | `string` | Strength indicator: `"none"`, `"full"`, `"degraded"`, `"reduced"`, `"destroyed"` |

## Location Properties

The `location` property on a symbol provides spatial information.

| Property | Type | Description |
|---|---|---|
| `fsTYPE` | `string` | Location type — mirrors the parent symbol type |
| `shape` | `string` | Geometry type: `"point"`, `"line"`, `"area"`, `"corridor"`, `"orbit"`, `"multipoint"` |
| `coords` | `LatLon[]` | Array of `{ lat, lon }` objects defining the geometry |
| `width` | `number` | Width in meters (corridors and similar graphics) |
| `altitude` | `number` | Altitude in meters (0 if not applicable) |
| `radius` | `number` | Radius in meters (circular areas) |
| `candidatePoids` | `string[]` | POIDs of symbols the gesture intersected — used for spatial references (e.g., "attack **from** A **to** B") |

## SIDC Structure (APP-6D)

The `sidc` object encodes the full military symbol identification code:

| Field | Digits | Example | Meaning |
|---|---|---|---|
| `partA` (1–2) | Version | `10` | MIL-STD-2525D / APP-6D |
| `partA` (3–4) | Standard Identity | `03` | Friend |
| `partA` (5–6) | Symbol Set | `10` | Land Unit |
| `partA` (7–8) | Status | `00` | Present |
| `partA` (9–10) | HQ/TF/Dummy | `15` | Task Force HQ |
| `partB` (1–6) | Entity/Type/Subtype | `120501` | Armored Cavalry Recon |
| `partB` (7–8) | Sector 1 Modifier | `00` | None |
| `partB` (9–10) | Sector 2 Modifier | `00` | None |

## N-Best Alternates

When STP is uncertain, it returns a ranked list of candidate interpretations. Each alternate is an independent `StpSymbol` with:

- A unique `poid`
- A `confidence` score
- A zero-based `alt` index

Use `chooseAlternate(symbol)` on the `StpRecognizer` to confirm a specific interpretation when the top result (`alt === 0`) is not the intended one.

## Extensions

The `extensions` property on `StpItem` (and by inheritance on `StpSymbol`, `StpTask`, `StpTaskOrg`, and `StpTaskOrgRelationship`) lets client applications attach arbitrary custom data to items. The data roundtrips through STP — whatever is set on `extensions` before sending is returned unchanged on the corresponding events.

| Property | Type | Description |
|---|---|---|
| `extensions` | `Record<string, any> \| undefined` | Optional bag of custom key/value pairs that roundtrip through STP |

## Task-Specific Properties

Recognised tasks have additional properties beyond the core symbol fields. See the [Tasks guide](../guides/tasks.md) for details on `StpTask` and its enumerations.
