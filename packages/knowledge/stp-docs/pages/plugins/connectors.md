---
id: connectors
title: Connectors
sidebar_position: 1
---

# Connection Plugins

The STP recognizer requires a **connector** to send and receive messages to/from the STP Engine. The connector services are mostly used internally by the SDK, but understanding the interface is important for developers creating custom connectors.

## Built-in WebSocket Connector

The SDK includes a WebSocket connector that talks to STP's native OAA Publish/Subscribe system:

```javascript
const stpconn = new StpSDK.StpWebSocketsConnector(webSocketUrl);
const stpsdk = new StpSDK.StpRecognizer(stpconn);
```

## IStpConnector Interface

Custom connectors (e.g., REST-based, or backed by a message queue) must implement the `IStpConnector` interface:

```typescript
export interface IStpConnector {
    /** Name of the connected service */
    baseName: string;
    /** Unique instance name (if multiple concurrent instances) */
    name: string;
    /** True if the connection is open */
    isConnected: boolean;

    /** Connect and register subscriptions */
    connect(serviceName: string, solvables: string[], timeout?: number): Promise<void>;
    /** Disconnect from STP */
    disconnect(timeout?: number): Promise<void>;

    /** Send a fire-and-forget message to STP */
    inform(message: string, timeout?: number): Promise<void>;
    /** Make an RPC-style request to STP */
    request(message: string, timeout?: number): Promise<string[]>;

    /** Handler invoked when STP sends a subscribed message */
    onInform: (message: string) => void;
    /** Handler invoked when STP makes a request this connector handles */
    onRequest: (message: string) => string;
    /** Handler invoked on connection errors */
    onError: (error: string) => void;
}
```

### Key concepts

- **`inform`** — asynchronous, fire-and-forget messages (no return data)
- **`request`** — RPC-style queries that return results
- **`solvables`** — on connection, the component declares which message types it handles or wants to receive. The routing system uses this to deliver matching messages via `onInform` / `onRequest`.

```javascript
let solvables = [
    "SpeechRecognized", "PenDown", "InkProcessed",
    "SymbolAdded", "SymbolModified", "SymbolDeleted", "StpMessage"
];
```

## Securing WebSocket Connections

The browser `WebSocket` API does not support custom HTTP headers, so `Authorization` header-based auth is not available. The recommended approach is a **reverse proxy with authentication**.

### Architecture

```
Browser ──wss://proxy.example.com/stp?token=abc──► Reverse Proxy ──ws://stp-server:port──► STP
                                                       │
                                                       ├─ Validates token
                                                       ├─ Rejects if invalid (401/403)
                                                       └─ Forwards if valid
```

### Proxy options

| Proxy | Auth Mechanisms |
|-------|-----------------|
| **nginx** | Querystring token via Lua/njs, or `auth_request` |
| **Azure API Management** | Subscription keys, OAuth 2.0, JWT validation |
| **AWS API Gateway** | IAM auth, Lambda authorizers, Cognito |
| **Caddy** | JWT middleware, forward_auth |

**Benefits**: TLS termination gives you `wss://` for free; token validation can be simple or sophisticated; the STP server stays on a private network.

---

:::info Source & Samples
Connector plugin source and documentation: [sketch-thru-plan-sdk-js/plugins/connectors](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/plugins/connectors)
:::
