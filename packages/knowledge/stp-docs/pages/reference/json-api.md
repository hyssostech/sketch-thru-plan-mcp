---
id: json-api
title: JSON-RPC API
sidebar_position: 1
---

# JSON-RPC API

STP provides a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) API for accessing services using languages where an SDK may not be available. The JavaScript and .NET SDKs are thin layers over this JSON API.

## Communication Model

Communication with STP is **bidirectional**:

- **Client → STP**: user events like sketches and speech (via WebSocket or other mechanism)
- **STP → Client**: recognition results, symbol events, system messages

On connection, a component declares its **solvables** — the message types it handles or wants to receive. STP's pub/sub system routes matching messages accordingly.

## Message Types

### Informs (fire-and-forget)

Update system state without expecting a response. The state change may (or may not) trigger other components to generate messages.

### Requests (RPC-style)

Always produce a response. Equivalent to a remote procedure call, even though the mechanism is asynchronous.

## Outgoing Message Format

```json
{
    "jsonrpc": "2.0",
    "method": "SendPenDown",
    "params": {
        "location": {
            "lat": 58.9565,
            "lon": 11.1759
        },
        "timestamp": "2020-10-27T20:50:30.584Z"
    }
}
```

- `method` — event name (same as the SDK method name)
- `params` — event parameters (same order and types as the SDK)

## Response Format

### Successful request

```json
{
    "id": 1,
    "jsonrpc": "2.0",
    "result": [
        {
            "fsTYPE": "coa",
            "poid": "id7J5ZJ1GVNQUNE",
            "name": "R1",
            "type": "hostile",
            "creator_role": "s2"
        }
    ]
}
```

### Error response

```json
{
    "jsonrpc": "2.0",
    "id": "5",
    "error": {
        "code": -32601,
        "message": "Invalid argument: expected a numeric id"
    }
}
```

## Incoming Message Format

STP components are both consumers and producers of events. Incoming messages follow the same format:

```json
{
    "jsonrpc": "2.0",
    "method": "SymbolAdded",
    "params": {
        "symbol": {
            "fsTYPE": "unit",
            "poid": "idDS6X03AGXT68E",
            "creatorRole": "s3",
            "confidence": 0.82,
            "alt": 0,
            "sidc": {
                "partA": "1003100015",
                "partB": "1205010000",
                "symbolSet": "10",
                "legacy": "SFGPUCRVA--E---"
            },
            "location": {
                "fsTYPE": "unit",
                "shape": "point",
                "coords": [{ "lon": 11.164, "lat": 58.948 }],
                "width": 0.0,
                "altitude": 0.0,
                "radius": 0.0,
                "candidatePoids": []
            },
            "shortDescription": "A/3-1",
            "description": "ARMORED CAVALRY RECON COMPANY",
            "fullDescription": "FRIENDLY ARMORED CAVALRY RECON COMPANY A/3-1",
            "affiliation": "friend",
            "echelon": "company",
            "parent": "3-1",
            "designator1": "A",
            "status": "present",
            "modifier": "none",
            "strength": "none"
        },
        "isUndo": false
    }
}
```

In the SDK, incoming messages correspond to event handlers prefixed with `on` (e.g., `onSymbolAdded`).

## Simulated Speech

For testing or accessibility workflows where a microphone is not available, the SDK provides a `sendSimulatedSpeechRecognition()` method that accepts typed text and submits it to STP as if it were a speech recognition result:

```javascript
stpsdk.sendSimulatedSpeechRecognition("infantry platoon");
```

The text is sent as a single hypothesis with confidence `1.0`. Timing is derived from the most recent sketch stroke.

## OpenRPC Schema

A formal [OpenRPC](https://github.com/open-rpc) definition of the API is available:

**[`sketch-thru-plan-api.json`](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/json-api/sketch-thru-plan-api.json)**

---

:::info Source & Samples
JSON API documentation and OpenRPC schema: [sketch-thru-plan-sdk-js/json-api](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/json-api)
:::
