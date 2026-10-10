---
sidebar_label: .NET quickstart
sidebar_position: 4
description: Connect to STP from C# with the HyssosTech.Sdk.STP package and receive symbol events.
---

# .NET quickstart

This page shows how to connect to an STP Engine from C# with the .NET SDK,
receive symbol events, and show the current scenario. The guides elsewhere on
this site use the JavaScript SDK. The .NET SDK has the same concepts (connector,
recognizer, events, requests), and its API reference is under
[.NET API](/docs/category/net-api).

## Install

```bash
dotnet add package HyssosTech.Sdk.STP
```

The package targets .NET 10 and .NET Standard 2.0. Versions `0.4.0-preview`
and later are the JSON-RPC SDK described here. Earlier versions are a
different, larger API. The namespace is `StpSDK`.

## Connect and receive symbol events

```csharp
using StpSDK;

var connector = new StpJsonRpcConnector(logger: null, url: "ws://localhost:9599");
var stp = new StpRecognizer(connector);

// 1. Attach handlers BEFORE connecting. Registration sends the engine the list
//    of events that have a handler at that moment.
stp.OnSymbolAdded += (poid, item, isUndo) =>
{
    // item is the best interpretation; item.Alternates holds the other hypotheses
    if (item is StpSymbol symbol)
        Console.WriteLine($"Added {poid}: {symbol.FullDescription}");
};
stp.OnSymbolModified += (poid, item, isUndo) =>
    Console.WriteLine($"Modified {poid}: {item.FullDescription}");
stp.OnSymbolDeleted += (poid, isUndo) =>
    Console.WriteLine($"Deleted {poid}");
stp.OnStpMessage += (level, message) =>
    Console.WriteLine($"[{level}] {message}");
stp.OnConnectionError += (message, stpDisabled, ex) =>
    Console.WriteLine($"Connection problem: {message}");

// 2. Connect and register. Bound the connect: with secondsToRetry 0 (the default)
//    the client keeps retrying an unreachable engine with no time limit.
string session = await stp.ConnectAndRegisterAsync(
    "MyDotNetApp",
    session: "mySession",   // share a session with other clients by name
    secondsToRetry: 10);
Console.WriteLine($"Connected, session {session}");

// 3. Show what is already there, or start a blank scenario
if (await stp.HasActiveScenarioAsync())
    await stp.JoinScenarioSessionAsync();   // replays current content as OnSymbolAdded etc.
else
    await stp.CreateNewScenarioAsync("MyDotNetApp");

Console.ReadLine();   // keep the process alive while events arrive
stp.Disconnect();
```

`ConnectAndRegisterAsync` throws `StpCommunicationException` when it cannot
connect. Pass `exitAppIfNoConnection: false` to get `null` back instead.

## Things that differ from the JavaScript SDK

- **Events arrive on a background thread.** The SDK raises events one at a time,
  in arrival order, on a worker thread. In WinForms or WPF, marshal to the UI
  thread before touching controls.
- **Add a handler after connecting? Refresh the registration.** Call
  `RefreshSubscriptionsAsync()` after attaching it, or the engine never sends
  that event (see [Integration troubleshooting](./guides/integration-troubleshooting.md#events-never-arrive-although-isconnected-is-true-net)).
- **The session id is always sent.** Without a `session` argument the SDK
  registers under the machine id, which is derived from the machine's network
  adapters (or its host name). A session suffix on the WebSocket URL (`ws://host:9599/mySession`) is
  therefore not used by .NET clients. To share a session with JavaScript
  clients, pass the same `session` explicitly. See [Sessions](./guides/sessions.md).
- **Requests use a fixed 30-second timeout.** Request methods (`...Async`) throw
  `TimeoutException` when no answer arrives, `StpException` when STP refuses
  or fails the request, and `InvalidOperationException` when not connected.
  Pass a `CancellationToken` to give up sooner. See
  [Errors, refusals and timeouts](./guides/errors-and-timeouts.md).
- **Commands are fire-and-forget.** `AddSymbol`, `UpdateSymbol`, `DeleteSymbol`,
  `AddTask`, `UpdateTask` and similar return immediately. The confirming event
  (`OnSymbolAdded`, `OnSymbolModified`, ...) is the result.
- **Reconnection does not re-register.** The underlying socket reconnects by
  itself, but the SDK does not register again afterwards. See
  [Connection lifecycle and reconnecting](./guides/connection-lifecycle.md#net-sdk).

## Known limitations (HyssosTech.Sdk.STP 0.6.1)

- **`OnNewScenario`, `OnInkProcessed` and `OnSpeechDiscarded` are not raised**
  when connected through the engine's WebSockets bridge. The engine sends these
  three events without a `params` key, and the SDK drops any event message that
  has none. Do not rely on them. For example, after your own
  `CreateNewScenarioAsync` or `LoadNewScenarioAsync`, reset your local state
  yourself.
- **`OnSketchIntegrated` and `OnSketchDiscarded` are never raised over the
  WebSockets bridge.** The bridge reports both outcomes as `InkProcessed`
  (affected by the previous item).
- **Course-of-action (COA) methods** may be refused by the engine. See
  [Integration troubleshooting](./guides/integration-troubleshooting.md#a-call-throws-with-no-useful-message).

## Next steps

- [Scenarios](./guides/scenarios.md): create, load, join and save
- [Event ordering and concurrent edits](./guides/events-and-ordering.md)
- The SDK repository's [quickstart and samples](https://github.com/hyssostech/sketch-thru-plan-sdk-net):
  a WinForms sketch-and-speech quickstart plus samples for scenarios, sessions,
  roles, task organizations, tasking and C2SIM
