---
id: c2sim
title: C2SIM Interoperability
sidebar_position: 8
---

# C2SIM Interoperability

Command and Control Systems to Simulation Systems Interoperation ([C2SIM](https://github.com/OpenC2SIM/OpenC2SIM.github.io)) is defined in SISO-STD-019-2020 as a standard for expressing and exchanging C2 information among C2 systems, simulation systems, and robotic/autonomous systems.

C2SIM provides a standardized representation of:

1. **Plan Initialization** — initial entity state (units, equipment, etc.)
2. **Plan Orders** — tasking of entities in the initialization
3. **Reports** — entity updates from simulation/C2 execution

:::note Prerequisites
This feature requires an STP deployment with a **C2SIM Connector** component configured to interact with a C2SIM Server. Contact Hyssos for configuration details.
:::

## Creating a C2SIM Proxy

All C2SIM interaction goes through a proxy created by the SDK:

```javascript
const c2simProxy = stpsdk.createC2SIMProxy();
```

With options to override defaults:

```javascript
const c2simProxy = stpsdk.createC2SIMProxy({
    restUrl: 'http://mydomain.com:8080/C2SIMServer',
    stompUrl: 'http://mydomain.com:61613/topic/C2SIM',
    systemName: 'MySystemName',
});
```

### StpC2SIMOptions

| Option | Description |
|--------|-------------|
| `restUrl` | Full C2SIM server endpoint (host:port/path) |
| `restPassword` | REST endpoint password |
| `stompUrl` | Full STOMP service endpoint |
| `serverProtocol` | Protocol version: `"1.0.0"`, `"1.0.1"`, `"1.0.2"` |
| `systemName` | SystemName element in the C2SIM Initialization document |
| `resetBeforeInitialize` | Force transition to Uninitialized before pushing |
| `runAfterInitialize` | Force transition to Running after pushing |
| `fullTO` | Include full TO in Initialization/Order (vs. only placed elements) |
| `schemaVersion` | C2SIM schema version for compatibility |
| `includeMapGraphicId` | Add TG MapGraphicID elements |
| `entityNameCharLimit` | Max characters for entity names (0 = no limit) |
| `rulesOfEngagement` | `'ROEHold'`, `'ROEFree'`, or `'ROETight'` |
| `exportFileDir` | Folder to write export JSON files |
| `startDate` | Scenario start date |
| `phaseDuration` | Minutes per STP phase |

## Export to C2SIM Server

Push the current scenario to C2 and simulators:

```javascript
await c2simProxy.exportPlanDataToC2SIMServer(
    'ScenarioName',   // label
    'initialization', // or 'order'
    'friend'          // or 'hostile' or 'all'
);
```

Parameters:

| Parameter | Description |
|-----------|-------------|
| `name` | Scenario label |
| `dataType` | `'initialization'` or `'order'` |
| `affiliation` | Filter: `'friend'`, `'hostile'`, or `'all'` |
| `coaPoids` | Optional COA filter |
| `timeout` | Optional timeout in seconds |

Internally, `exportPlanDataToC2SIMServer` calls:
1. `getC2SIMContent()` — retrieve C2SIM XML
2. `pushC2SIMContent()` — push to the server

## Import from C2SIM Server

Import Initialization data to populate a baseline scenario:

```javascript
if (!(await stpsdk.hasActiveScenario())) {
    await stpsdk.createNewScenario(appName);
}
await c2simProxy.importInitializationFromC2SIMServer();
```

Internally, this:
1. `pullC2SIMInitialization()` — retrieve from the server
2. `convertC2SIMContent()` — convert C2SIM XML to STP native format
3. `syncScenarioSession()` — load into the current scenario

## Report Events

Simulators and C2 systems may update entity properties (location, status). The `onSymbolReport` event fires for these updates:

```javascript
c2simProxy.onSymbolReport = (poid, symbol) => {
    map.removeFeature(poid);
    const gj = new JmsRenderer(symbol, map.getBounds()).asGeoJSON();
    map.addFeature(gj);
};
```

:::tip
Some reports may contain unchanged properties. For large numbers of entities, check for actual changes before re-rendering.
:::

## Lower-Level Methods

| Method | Description |
|--------|-------------|
| `getC2SIMContent(name, dataType, affiliation?, coaPoids?, timeout?)` | Get C2SIM XML for current scenario |
| `pushC2SIMContent(content, dataType, timeout?)` | Push XML to C2SIM server |
| `pullC2SIMInitialization(timeout?)` | Retrieve Initialization from server |
| `convertC2SIMContent(content, timeout?)` | Convert C2SIM XML to STP native format |

See the [C2SIM Overview](https://github.com/hyssostech/OpenC2SIM.github.io/blob/master/Reference/C2SIM-Overview1.pdf) and the [OpenC2SIM repository](https://github.com/OpenC2SIM/OpenC2SIM.github.io) for full C2SIM documentation.

---

:::info Source & Samples
Full C2SIM sample: [sketch-thru-plan-sdk-js/samples/c2sim](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/c2sim)
:::
