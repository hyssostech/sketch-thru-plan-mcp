---
sidebar_label: Connection lifecycle and reconnecting
sidebar_position: 15
description: What happens when the WebSocket connection to STP drops, what each SDK does automatically, and how an app should reconnect and resynchronize.
---

# Connection lifecycle and reconnecting

This page explains what happens when the WebSocket connection to STP drops and
how your app should recover.

## What survives a disconnect

| Lives in | What | After a disconnect |
|---|---|---|
| The engine session | The scenario: symbols, tasks, task organizations | Survives. Other clients keep working on it. |
| Your connection | Your event subscriptions (the registration) | Lost. Every new WebSocket connection has to register again. |
| Your connection | Requests sent but not yet answered | Not answered. They fail with a timeout. |
| Nowhere | Events raised while you were disconnected | Lost. STP does not queue events for a disconnected client. |

Per-client settings, such as the active role or task organization, are not
guaranteed to survive a reconnect. Apply them again after reconnecting.

So recovering takes three steps: **reconnect**, **register again**, and
**resynchronize** the state you missed.

## JavaScript SDK

What `StpWebSocketsConnector` does on its own:

- **One automatic reconnect attempt.** When the socket closes, the connector
  makes one attempt to reconnect, using the service name, subscriptions,
  machine id and session id from the original `connect()`. If the attempt
  succeeds, the registration is sent again, so you stay in the same session.
  The attempt allows 30 seconds.
- **If that attempt fails**, `onStpMessage` receives `Lost connection to STP.
  Check that the service is running and refresh page to retry` at
  `StpMessageLevel.Error`. The connector makes no further attempts.
- **A socket error** is reported through `onStpMessage` as `Error connecting to
  STP. Check that the service is running and refresh page to retry`.
- **Nothing reports a successful reconnect.** Check `isConnected` on the
  connector.
- **While disconnected**, requests reject immediately with `Failed to send
  request: connection is not open (...)`. Informs are not sent, and
  `onStpMessage` receives `Failed to send inform: connection is not open (...)`.
- **Requests in flight when the socket dropped** are not failed early. They
  time out (30 seconds by default).
- Closing the socket yourself also triggers the automatic reconnect attempt.

Even when the automatic attempt succeeds, you missed every event raised while
the socket was closed, so you still need to resynchronize. Every successful
connection, automatic or not, replaces the connector's `socket` object. Comparing
that object catches even a short interruption that a periodic `isConnected`
check would miss:

```typescript
const stpconn = new StpSDK.StpWebSocketsConnector(webSocketUrl);
const stpsdk = new StpSDK.StpRecognizer(stpconn);
// ... assign stpsdk.on* handlers here, before connecting ...

let sessionId = await stpsdk.connect(appName, 10, machineId, requestedSession);
let lastSocket = stpconn.socket;

setInterval(async () => {
  if (!stpconn.isConnected && !stpconn.isConnecting) {
    try {
      // A fresh connect() registers the handlers that are assigned now
      sessionId = await stpsdk.connect(appName, 10, machineId, sessionId);
    } catch {
      return; // still down - try again on the next tick
    }
  }
  if (stpconn.isConnected && stpconn.socket !== lastSocket) {
    lastSocket = stpconn.socket; // a new connection: events were missed
    await resync();
  }
}, 5000);

async function resync() {
  map.clearAll(); // drop everything rendered from events
  if (await stpsdk.hasActiveScenario()) {
    await stpsdk.joinScenarioSession(); // replays current content to this client
  }
  // re-apply per-client settings, e.g. role, here
}
```

## .NET SDK

What `StpJsonRpcConnector` does on its own:

- **The socket reconnects automatically.** The connector uses a WebSocket
  client with reconnection enabled. The client also reconnects when no message
  has arrived from the server for 30 seconds.
- **`OnConnectionError` fires for errors and lost connections**, and when the
  initial connect fails. It does not fire for a reconnect caused by 30 seconds
  without messages, and no event reports a completed reconnect.
- **The SDK does not register again after an automatic reconnect.** The new
  socket is open and `IsConnected` is `true`, but the engine sends no events
  until you register again. Call `RefreshSubscriptionsAsync()`, which
  re-registers with the same name, machine id, session and current handlers.
  It only works when you connected with `ConnectAndRegisterAsync` or
  `RegisterAsync`.
- **`Disconnect()` cancels pending requests.** They fail with
  `TimeoutException`.
- **Bound the first connect.** With `secondsToRetry: 0` (the default),
  `ConnectAndRegisterAsync` has no time limit, and against an unreachable
  engine the client keeps retrying. Pass a positive `secondsToRetry`. If the
  connection fails, the method throws `StpCommunicationException`, or returns
  `null` when `exitAppIfNoConnection` is `false`.

A simple, robust approach is to tear the connection down and rebuild it
whenever `OnConnectionError` fires, then resynchronize. A failed connect
raises `OnConnectionError` too, so guard against running two reconnects at
once:

```csharp
int reconnecting = 0;

stp.OnConnectionError += (message, stpDisabled, ex) =>
{
    if (Interlocked.Exchange(ref reconnecting, 1) == 1) return; // already on it
    _ = Task.Run(async () =>
    {
        try
        {
            while (true)
            {
                try
                {
                    stp.Disconnect();
                    string session = await stp.ConnectAndRegisterAsync(
                        "MyApp", session: mySession,
                        exitAppIfNoConnection: false, secondsToRetry: 10);
                    if (session is not null) break;
                }
                catch (Exception) { /* registration failed or timed out */ }
                await Task.Delay(TimeSpan.FromSeconds(5));
            }

            ClearLocalState();
            if (await stp.HasActiveScenarioAsync())
                await stp.JoinScenarioSessionAsync();
        }
        finally
        {
            Interlocked.Exchange(ref reconnecting, 0);
        }
    });
};
```

If your client can sit idle with no STP traffic for more than 30 seconds and
events stop arriving while `IsConnected` is `true`, call
`RefreshSubscriptionsAsync()` and resynchronize.

## Resynchronizing after a gap

After any interruption:

1. **Discard local state built from events.** You cannot tell which events you
   missed.
2. **Replay the current state.** `joinScenarioSession()` replays the session
   content to your client only (see [Event ordering](./events-and-ordering.md#after-joinscenariosession)
   for what it includes and skips). Alternatively, take a snapshot with
   `getScenarioContent()`.
3. **Re-check unconfirmed commands.** A fire-and-forget call (`addSymbol`,
   `updateSymbol` and so on) whose confirming event you never saw may or may
   not have been applied. Look for it in the replayed state before you send it
   again.
4. **Re-apply per-client settings**, such as role and task organization.

Clients of the REST connector use the server-sent event stream instead. It has
its own gap detection; see [REST connector](../reference/rest-connector.md#event-stream).

## See also

- [Sessions](./sessions.md): how the session id is chosen
- [Errors, refusals and timeouts](./errors-and-timeouts.md)
- [Integration troubleshooting](./integration-troubleshooting.md#events-never-arrive-although-isconnected-is-true-net):
  handlers attached after connecting
