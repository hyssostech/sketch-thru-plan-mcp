---
id: intro
title: Overview
sidebar_position: 1
slug: /intro
---

# Sketch-thru-Plan SDK

Sketch-thru-Plan (STP) is a **Natural Language Planning Engine** that analyzes combined speech and sketches and produces interpretations of user intentions in terms of military symbols placed on a map, and higher-level constructs that correlate multiple symbols into intended actions (tasks).

## Multimodal Recognition

STP is a *multimodal* system — it produces interpretations based on multiple kinds of user input, most commonly **speech** and **sketch**. The interpretations fuse these modalities:

- **Location from sketch**: a user draws a line on the map
- **Semantics from speech**: the user says "phase line blue"
- **Mutual disambiguation**: if STP has high confidence the user sketched an area (not a line), speech hypotheses known to refer to areas are ranked higher, even if they scored lower independently

This approach makes the recognizer more robust than either modality alone.

## Military Planning Focus

The primary area of application is military planning, supporting fast creation of **Courses of Action (COAs)** using the MIL-STD-2525D symbology standard. STP enhances user cognition by letting them focus on the creative aspect of planning — keeping focus on the **task, not the tool**.

Plans designed in STP are executable with little additional user intervention other than the symbol laydown using speech and sketch. The resulting plans are ready to be sent to **simulators** for adjudication and to **Command and Control (C2)** systems.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Symbol** | A military symbol (unit, equipment, tactical graphic) placed on the map via combined speech and sketch |
| **Task** | A higher-level construct STP auto-detects from multiple symbols (e.g., an Attack from a Unit + Objective + Axis of Advance) |
| **Task Org / ORBAT** | Pre-defined unit organizations that enable streamlined symbol placement by name/designator |
| **Scenario** | A collection of COAs, symbols, tasks, and task orgs representing a plan |
| **Session** | An isolated context in STP that supports multi-user collaboration |
| **Role** | A planning role (S2, S3, S4, Eng, FSO) that affects default affiliation and active task org |
| **Plugin** | Swappable components for connectors, speech, maps, and rendering |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Browser App │◄───►│  STP SDK     │◄───►│  STP Engine   │
│  (Map + UI)  │     │  (JS/TS)     │     │  (Server)     │
└─────────────┘     └──────────────┘     └──────────────┘
       │                    │
       ▼                    ▼
 ┌───────────┐     ┌───────────────┐
 │ Map Plugin │     │ Speech Plugin │
 │ (Leaflet,  │     │ (Azure, AWS)  │
 │  Google,   │     └───────────────┘
 │  ArcGIS)   │
 └───────────┘
```

The SDK communicates with the STP Engine via a **connector plugin** (WebSocket by default). Map presentation and speech recognition are handled by replaceable plugins.

## Prerequisites

- **STP Engine** (v5.9.9+) running on an accessible Windows server (or localhost for development)
- A PC or Mac with a working **microphone**, mouse or stylus
- A subscription key for a speech service (e.g., [Microsoft Azure Speech](https://docs.microsoft.com/azure/cognitive-services/speech-service/get-started)) if using speech input

## Next Steps

- [Installation](./installation) — install the SDK via npm or CDN
- [Getting Started](./getting-started) — build your first STP-enabled app step by step
- [Guides](./guides/symbols-and-rendering) — deeper topics: tasks, task orgs, roles, scenarios, sessions, and more
