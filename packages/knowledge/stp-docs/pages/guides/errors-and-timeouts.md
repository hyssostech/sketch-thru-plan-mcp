---
sidebar_label: Errors, refusals and timeouts
sidebar_position: 13
description: Which errors STP returns over the WebSocket API, why there are no JSON-RPC error codes, and how to tell a refused request from one that timed out.
---

# Errors, refusals and timeouts

This page answers three questions:

- Which error codes can STP return, and what does each mean?
- How do I tell a request STP **refused** from one that **timed out**?
- What does a timeout tell me about whether the operation happened?

It covers calls that fail visibly. Calls that succeed and still produce the
wrong result are covered in [Silent failures](./silent-failures.md) and
[Integration troubleshooting](./integration-troubleshooting.md).

## Does STP return JSON-RPC error codes?

No. The STP WebSocket API does not send JSON-RPC 2.0 `error` objects, and there
are no numeric error codes such as `-32601` to switch on. A failure is reported
in one of three ways:

| What you sent | How a failure is reported |
|---|---|
| A **request** (a call that returns a value or a promise) | A `RequestResponse` message with `success: false`. The `result` field carries the reason as text. |
| An **inform** (a fire-and-forget call such as `addSymbol` or `updateSymbol`) | No reply at all. Success shows up as an event (for example `SymbolModified`); a failure shows up as the absence of that event. |
| A message STP cannot parse | No reply at all. To your code this looks like a timeout. |

### What a request and its reply look like

The SDKs wrap every request in a `Request` message that carries a correlation
`cookie` and the timeout in seconds. The engine answers with a
`RequestResponse` that echoes the cookie. Both messages are listed in the
[OpenRPC contract](../reference/json-api.md#openrpc-schema) as transport
messages: an application that uses an SDK never sees them, but a client written
without an SDK has to implement them.

```json
{
  "method": "Request",
  "params": {
    "jsonRequest": "{\"method\":\"HasActiveScenario\",\"params\":null}",
    "cookie": 3,
    "timeout": 30
  }
}
```

A successful reply:

```json
{
  "method": "RequestResponse",
  "params": { "cookie": 3, "success": true, "result": true }
}
```

A refused reply, here for a misspelled method name:

```json
{
  "method": "RequestResponse",
  "params": {
    "cookie": 4,
    "success": false,
    "result": "No handler for method 'GetScenarioContents' - the WebSocketsBridge does not dispatch it"
  }
}
```

Older engines send `"result": null` in a refusal and give no reason. Recent
engines put the reason in `result`. When a method has no handler, they also
send an `StpMessage` event at `Warning` level with the same text, so a refused
inform can be seen too.

## What each failure looks like in the SDKs

| Situation | On the wire | JavaScript SDK | .NET SDK |
|---|---|---|---|
| The engine does not dispatch the method (request) | `success: false`, `result` = `No handler for method '...'` (`null` on older engines) | The promise rejects with an `Error` whose message is the reason. When there is no reason, the SDK supplies its own text (`STP refused the request and gave no reason...`). SDK versions before 0.6.15 reject with `null`. | Throws `StpException` with the reason as its message. Versions before 0.5.0 throw it with an empty message. |
| The engine does not dispatch the method (inform) | No reply. Recent engines send an `StpMessage` warning. | Nothing is returned. `onStpMessage` receives the warning if you set it. | Nothing is returned. `OnStpMessage` receives the warning if you subscribed. |
| The operation threw inside the engine's bridge | `success: false`, `result` = the exception message | Rejects with an `Error` carrying that message | Throws `StpException` carrying that message |
| No reply within the timeout | Nothing | Rejects with `Error('Operation timed out')` | Throws `TimeoutException` (`Request timed out after 30000ms`) |
| Not connected when you call | Not sent | Requests reject with `Failed to send request: connection is not open (...)`. Informs are not sent, and `onStpMessage` receives `Failed to send inform: connection is not open (...)` at `Error` level. | Throws `InvalidOperationException` (`Not connected to STP Engine`) |

The text in `result` is diagnostic, written for people. It is not a stable API,
so do not parse it. To find out ahead of time whether the engine dispatches a
method, check the method's entry in the contract: a method the engine does not
dispatch carries `"x-engineDispatch": "none"` (see
[A call throws with no useful message](./integration-troubleshooting.md#a-call-throws-with-no-useful-message)).

## How do I tell a refused request from one that timed out?

A refusal is an **answer**. STP received the request and replied that it could
not do it. A timeout means **no answer arrived** within the time you allowed.

JavaScript:

```typescript
try {
  const content = await stpsdk.getScenarioContent(20); // timeout in seconds
} catch (e) {
  if (e instanceof Error && e.message === 'Operation timed out') {
    // No answer in 20 s. The outcome is unknown - see "What a timeout means".
  } else if (e == null) {
    // Refused by an older SDK (before 0.6.15), which rejects with null
  } else {
    // STP answered and refused, or the operation failed: (e as Error).message
  }
}
```

.NET:

```csharp
try
{
    string content = await stp.GetScenarioContentAsync();
}
catch (TimeoutException)
{
    // No answer within 30 s. The outcome is unknown.
}
catch (StpException ex)
{
    // STP answered: refused or failed. ex.Message has the reason.
}
catch (InvalidOperationException)
{
    // Not connected - the request was never sent.
}
catch (OperationCanceledException)
{
    // Your own CancellationToken was cancelled.
}
```

What to do next depends on which case you hit:

- **Refused because the method is not dispatched:** do not retry. The call
  cannot succeed against this engine.
- **Failed with an exception message:** read the message. It may be transient,
  for example the engine connection dropping in the middle of the call.
- **Timed out:** assume nothing about the outcome until you have checked (next
  section).

## What a timeout means

A timeout tells you that no answer arrived in time. It does not tell you that
the operation did not happen.

- **Default timeouts.** The JavaScript SDK waits 30 seconds by default, and most
  request methods take an optional `timeout` argument in seconds. The .NET SDK
  waits a fixed 30 seconds per request. You can give up sooner with a
  `CancellationToken`, which throws `OperationCanceledException` instead of
  `TimeoutException`.
- **The engine is told the timeout too.** The SDK sends the timeout with the
  request, and the engine's bridge cancels its own work after the same number
  of seconds. That cancellation is cooperative, so the work may already have
  finished, or may stop part-way. For example, a scenario load cancelled
  part-way keeps the objects it had already applied.
- **Late replies are discarded.** If the answer arrives after the SDK has given
  up, both SDKs drop it silently.
- **Requests on one connection run one at a time, in order.** The client starts
  its timer when it sends the request, but the engine starts work only when it
  reaches that request. A short request queued behind a large load can time out
  on the client before the engine starts it, and the engine will still run it
  when its turn comes. Give long operations a longer timeout, and avoid sending
  other requests while a large load is in progress.
- **.NET: `Disconnect()` reports pending requests as timeouts.** A request still
  waiting when you call `Disconnect()` fails with `TimeoutException`.
- **Connection drops.** A request already sent when the connection drops is not
  failed early. It times out.

After a timeout on a call that changes state, read the state back
(`hasActiveScenario`, `getScenarioContent`, `getPoidObject`) before you retry.
A timed-out `loadNewScenario` is safe to repeat, because a load clears the
scenario before applying the content.

## Fire-and-forget calls never fail loudly

Calls such as `addSymbol`, `updateSymbol`, `deleteSymbol`, `chooseAlternate`,
`addTask`, `updateTask` and `confirmTask` are informs: they return as soon as
the message is sent. The only confirmation is the matching event
(`SymbolAdded`, `SymbolModified`, `SymbolDeleted`, `TaskModified`, and so on),
broadcast to every subscribed client in the session.

If the confirmation matters, wait for that event with a deadline, and treat a
missing event as "not applied, or not yet". [Event ordering and concurrent
edits](./events-and-ordering.md#two-clients-editing-the-same-symbol) describes
one case where the engine drops an update without telling the sender.

## See also

- [Connection lifecycle and reconnecting](./connection-lifecycle.md): what
  happens to requests and events while the connection is down
- [Silent failures](./silent-failures.md): calls that succeed with the wrong outcome
- [Integration troubleshooting](./integration-troubleshooting.md): the
  "no handler" refusal in detail
- [JSON-RPC API](../reference/json-api.md): message formats
