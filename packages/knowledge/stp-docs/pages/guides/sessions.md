---
id: sessions
title: Sessions
sidebar_position: 6
---

# Sessions

A single STP Engine (v5.9+) supports **multiple sessions**. Sessions are isolated contexts — edits and task interpretation within a session do not affect other sessions.

## Key Properties

- **Isolation**: each session contains one scenario at a time; edits are scoped to that session
- **Independent roles**: apps sharing a session can each set their own role without affecting others
- **Independent TOs**: different TO/ORBATs can be active in each app instance, even within the same session
- **Collaboration**: clients joined to the same session receive notifications of edits made by others

## Specifying a Session

Sessions can be specified in two ways:

### 1. WebSocket URL suffix

Append a session ID to the connection URL:

```
wss://stp.hyssos.com/ws/12349876
wss://stp.hyssos.com/ws/98761234
```

Instances connecting with the same suffix share a session. IDs are arbitrary alphanumeric sequences.

### 2. `connect()` parameter

```javascript
let assignedSession = await stpsdk.connect(
    "MyApp",     // service name
    10,          // timeout
    machineId,   // optional machine id
    "mySession"  // session id
);
```

### Resolution order

If multiple sources are available, the session ID is resolved in this order:

1. Explicit `sessionId` parameter in `connect()`
2. Suffix from the WebSocket connection string
3. The `machineId` parameter
4. A randomly generated unique ID

The assigned session is returned by `connect()`.

## Session Startup Pattern

```javascript
const sessionId = await stpsdk.connect(appName, 10, machineId, session);
map.load();

if (!(await stpsdk.hasActiveScenario())) {
    await stpsdk.createNewScenario(appName);
} else {
    log("Active scenario found — Join or Sync to display content");
}
```

## Roles and TOs within Sessions

Roles and TO selection are per-app-instance, not per-session:

- Two browser tabs can share edits on a common session while one is set to S2 and the other to S3
- TOs loaded by any client are available to all clients in the session, but only become active when explicitly selected by each instance

## MachineId in Browser Apps

`machineId` is intended to represent a shared ID for all apps on a particular machine (useful for pairing with external speech recognizers). Since JavaScript has no hardware access, you can inject it via querystring:

```batch
rem Extract machine serial number (Windows)
for /f "tokens=2 delims==" %%a in ('wmic os get serialnumber /format:value') do set SERIALNUMBER=%%a
```

If `machineId` is not provided, STP assigns a random unique ID.

---

:::info Source & Samples
Full sessions sample: [sketch-thru-plan-sdk-js/samples/session](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/session)
:::
