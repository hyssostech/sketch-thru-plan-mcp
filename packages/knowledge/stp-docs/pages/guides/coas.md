---
sidebar_label: Courses of action (COAs)
sidebar_position: 17
description: How to create, rename, delete, switch, save and load courses of action (COAs) from an app with the JavaScript and .NET SDKs, which events answer each call, and who receives them.
---

# Courses of action (COAs)

This page answers these questions:

- What is a course of action (COA) in STP?
- How do I create, rename and delete a COA from my app?
- How do I switch between COAs, and how do I know which one is current?
- How do I save a COA and load it back?
- How do symbols and tasks become part of a COA?
- Can each COA have its own task organization?

The method and event names are those of the
[OpenRPC contract](../reference/json-api.md#openrpc-schema). The SDK method
that sends each one is listed in [Method summary](#method-summary).

## What a COA is

A course of action (COA) is an alternative plan for one affiliation, friendly
or hostile. A scenario holds COAs, symbols, tasks and task organizations. Each
symbol and each task belongs to one COA: its `parentCoa` property holds that
COA's poid (see [Symbols & Rendering](./symbols-and-rendering.md) and
[Tasks](./tasks.md)).

A COA object (`StpCoa`) has these properties:

| Property | Description |
|---|---|
| `fsTYPE` | `coa` |
| `poid` | Unique id of the COA, assigned by STP |
| `name` | COA name, for example `B2` |
| `affiliation` | `friend` or `hostile` |
| `creatorRole` | Role that created the COA: `S2`, `S3`, `S4`, `FSO` or `ENG` |

**Every client has its own current COA.** Sketch and speech recognition,
edits and imports apply to the current COA of the client that makes them, so
select the COA before you work on it (see
[Switching the current COA](#switching-the-current-coa)). Switching your COA
does not change the current COA of other clients in the session.

## Method summary

| Method | Kind | Answered by | JavaScript SDK | .NET SDK |
|---|---|---|---|---|
| `AddCoa` | inform | `CoaAdded` (every client) | `addCoa(coa)` | `AddCoa(coa)` |
| `UpdateCoa` | inform | `CoaModified` (every client) | `updateCoa(poid, coa)` | `UpdateCoa(poid, coa)` |
| `DeleteCoa` | inform | `CoaDeleted` (every client) | `deleteCoa(poid)` | `DeleteCoa(poid)`, or `DeleteCoaAsync(poid)` as a request |
| `SetCurrentCoa` | request | the reply; `CoaSwitched` (your client only) unless the COA was already current | `setCurrentCoa(poid, timeout?)` | `SetCoaAsync(poid)` |
| `GetCoaContent` | request | the reply (object-set text) | `getCoaContent(poid, timeout?)` | `GetCoaContentAsync(poid)`; 0.6.1 or later (see the caution below) |
| `ImportCoaContent` | request | the reply (the COA's poid); `CoaAdded`, `SymbolAdded`, `TaskAdded` per object | `importCoaContent(content, timeout?)` | `ImportCoaContentAsync(content)` |
| `SetCoaTaskOrg` | request | the reply; `TaskOrgSwitched` if your current task org changes | `setCoaTaskOrg(toPoid, coaPoid?, timeout?)` | `SetCoaTaskOrgAsync(toPoid, coaPoid?)` (0.6.1 or later); before that, `SetDefaultTaskOrgAsync(poid)` covers the form without `coaPoid` |
| `ResetCoaTaskOrg` | request | the reply; `TaskOrgSwitched` if your current task org changes | `resetCoaTaskOrg({ affiliation, coaPoid }, timeout?)` | `ResetCoaTaskOrgAsync(affiliation, coaPoid?)` (0.6.1 or later); before that, `ResetDefaultTaskOrgAsync(affiliation, token)` covers the form without `coaPoid` |

An **inform** is fire and forget: the call returns at once, and the event is
the only confirmation. A **request** returns a promise (JavaScript) or a task
(.NET) that completes when STP answers, and fails when STP refuses. See
[Errors, refusals and timeouts](./errors-and-timeouts.md).

All of these calls change state except `GetCoaContent`, which only reads it.
`DeleteCoa` and `ImportCoaContent` are classed as destructive: see
[Method safety classes](../reference/method-safety.md).

:::note Older engines and SDKs
Engines released before these methods were dispatched refuse all eight as
methods they have no handler for (see
[A call throws with no useful message](./integration-troubleshooting.md#a-call-throws-with-no-useful-message)).
In the JavaScript SDK, use 0.6.17 or later for `resetCoaTaskOrg`: earlier
versions sent `SetCoaTaskOrg` with the wrong parameters.
:::

## Receiving COA events

A client receives an event only if it registered for it when it connected.
The SDKs register the events you have attached a handler to, so **attach the
COA handlers before you connect**. If you attach one later, call
`refreshSubscriptions()` (JavaScript) or `RefreshSubscriptionsAsync()` (.NET).

| Event | Parameters | Who receives it |
|---|---|---|
| `CoaAdded` | `poid`, `coa`, `isUndo` | Every client in the session, including the one that added the COA |
| `CoaModified` | `poid`, `coa`, `isUndo` | Every client in the session |
| `CoaDeleted` | `poid`, `isUndo` | Every client in the session |
| `CoaSwitched` | `coa` | **Only the client whose current COA changed** |

`isUndo` is true when the event is the result of an undo.

`CoaSwitched` reaches only your own client. You receive it after your own
`SetCurrentCoa`, and also when your current COA changes for another reason:

- after `SetRole` or `ResetRole`, when your current COA changes with the role
  (see [Roles](./roles.md));
- when your client first registers in a session where it already has a current COA;
- after `CreateNewScenario`, `LoadNewScenario` or `ResetStpScenario`, which
  clear the current COA. That `CoaSwitched` carries no COA, so handle a missing
  `coa`.

The contract describes the `coa` payload of `CoaSwitched` as approximate: it
can carry more fields than `StpCoa` lists (timestamps, `dbVersion`,
`taskOrg`). Read only the fields you need.

JavaScript:

```javascript
// Before stpsdk.connect(...)
stpsdk.onCoaAdded = (poid, coa, isUndo) => {
    coas.set(poid, coa);            // your own map of the scenario's COAs
};
stpsdk.onCoaModified = (poid, coa, isUndo) => {
    coas.set(poid, coa);
};
stpsdk.onCoaDeleted = (poid, isUndo) => {
    coas.delete(poid);
};
stpsdk.onCoaSwitched = (coa) => {
    currentCoaPoid = coa ? coa.poid : null;
    showCurrentCoa(coa);            // update your UI only here
};
```

.NET:

```csharp
// Before ConnectAndRegisterAsync(...)
stp.OnCoaAdded += (poid, coa, isUndo) => coas[poid] = coa;
stp.OnCoaModified += (poid, coa, isUndo) => coas[poid] = coa;
stp.OnCoaDeleted += (poid, isUndo) => coas.Remove(poid);
stp.OnCoaSwitched += coa => currentCoaPoid = coa?.Poid;
```

.NET raises events on a background thread; see the
[.NET quickstart](../getting-started-dotnet.md).

### Listing the COAs of a scenario

The API has no method that returns just the list of COAs. To learn the COAs
of a scenario that already exists, call `joinScenarioSession()`
(`JoinScenarioSessionAsync()` in .NET) after connecting: STP replays one
`CoaAdded` per live COA to your client only, together with the symbols, tasks
and task-organization units. After that, keep your list up to
date from `CoaAdded`, `CoaModified` and `CoaDeleted`. `getScenarioContent()`
also includes the COAs, as object-set text.

## Creating, renaming and deleting a COA

### Creating a COA: `AddCoa`

Send the COA definition: `name`, `affiliation` and `creatorRole`. STP assigns
the poid and announces the new COA with `CoaAdded` to every client. Use the
poid from that event in later calls.

```javascript
stpsdk.addCoa(Object.assign(new StpSDK.StpCoa(), {
    fsTYPE: 'coa',
    name: 'B2',
    affiliation: 'friend',
    creatorRole: 'S3',
}));
// The poid arrives in onCoaAdded
```

```csharp
stp.AddCoa(new StpCoa { Name = "B2", Affiliation = "friend", CreatorRole = "S3" });
// The poid arrives in OnCoaAdded
```

Because `AddCoa` returns nothing, recognize your own COA in `CoaAdded` by its
name. Create or load a scenario first: without an active scenario STP still
creates the COA, but `hasActiveScenario()` stays false.

If the `coa` parameter is missing, STP refuses the call with an `StpMessage`
warning (`'AddCoa' refused: ...`), which you receive through `onStpMessage` /
`OnStpMessage`. A `coa` that is not an object is ignored without any message.

### Renaming a COA: `UpdateCoa`

`UpdateCoa` changes the COA object itself (for example its name), not its
symbols or tasks, which have their own update methods. Send the poid and the
new definition. Every client receives `CoaModified` with the new state.

```javascript
stpsdk.updateCoa(poid, Object.assign(new StpSDK.StpCoa(), {
    fsTYPE: 'coa', poid, name: 'B2 (revised)', affiliation: 'friend', creatorRole: 'S3',
}));
```

A missing `poid` or `coa` is refused with an `StpMessage` warning, and so is
a poid that names no COA: an unknown one, a deleted COA, or an object of
another type. Engines before STP-1091 ignore an unknown poid without any
message, so with them, if no `CoaModified` arrives, check the poid.

### Deleting a COA: `DeleteCoa`

Every client receives `CoaDeleted`. STP waits up to 10 seconds to confirm the
delete:

- an unknown poid is refused after that wait, with an `StpMessage` warning
  (`'DeleteCoa' refused: DeleteCoa: the engine did not confirm within 10 s`);
- a missing poid is refused at once.

In JavaScript `deleteCoa(poid)` is an inform: watch `onCoaDeleted` and
`onStpMessage`. The .NET SDK has both forms. `DeleteCoa(poid)` is the inform.
`DeleteCoaAsync(poid)` sends it as a request, which completes once STP has
confirmed the delete and throws `StpException` with the reason when STP
refuses it.

```csharp
try
{
    await stp.DeleteCoaAsync(coaPoid);
}
catch (StpException ex)
{
    Console.WriteLine($"Delete refused: {ex.Message}");
}
```

## Switching the current COA

`SetCurrentCoa` makes a COA the current one for your client. It is a request:

- **Success** answers `null`. If the COA was not already current, STP also
  sends `CoaSwitched` with the newly current COA, to your client only. It may
  also send `TaskOrgSwitched` if your current task organization changes.
- **Already current:** the call succeeds at once and no event follows.
- **Refused:** a missing or blank poid, or one that names no COA (an unknown
  poid, a deleted COA, an object of another type), is refused at once, for
  example "SetCurrentCoa: 'poid' idNOSUCHCOA1091 names no object in this
  session - send the poid of an existing COA". Engines before STP-1091 refuse
  an unknown poid only after about 10 seconds, with "the engine did not
  confirm within 10 s".

JavaScript:

```javascript
try {
    await stpsdk.setCurrentCoa(poid);
    // Done. onCoaSwitched follows, unless the COA was already current.
} catch (e) {
    console.warn('COA switch refused:', e instanceof Error ? e.message : e);
}
```

.NET:

```csharp
try
{
    await stp.SetCoaAsync(coaPoid);   // sends SetCurrentCoa
}
catch (StpException ex)
{
    Console.WriteLine($"COA switch refused: {ex.Message}");
}
```

On current engines the reply does not depend on which events your client
registered: `setCurrentCoa` is answered even if you have no `onCoaSwitched`
handler. You still need the handler to learn about switches you did not ask
for, such as the ones that follow a role change.

:::tip Robust UI pattern
As with roles, show the new current COA in your UI from `onCoaSwitched` (or
after the request succeeds), not when the user clicks. The switch can be
refused.
:::

## How symbols and tasks join a COA

- **Recognized from sketch and speech:** they go into your client's current
  COA. Call `setCurrentCoa` before the user starts drawing for a different COA.
- **Loaded with `ImportCoaContent`:** they come in with the COA in the content
  (next section).
- **Added by your code** with `addSymbol` or `addTask`: set `parentCoa` on the
  symbol or task to the poid of an existing COA, the one it belongs to.

To find which symbols and tasks belong to a COA, read the COA with
`getCoaContent()`. Do not rely on `parentCoa` in `SymbolAdded` or `TaskAdded`:
the event payloads captured in the contract do not include it.

## Saving and loading a COA

### Saving: `GetCoaContent`

`GetCoaContent` returns one COA, with its units, tactical graphics and tasks,
as STP object-set text (`object_set([...])`), ready to be stored and loaded
back with `ImportCoaContent`. It only reads: nothing changes and no event
follows.

- The text does **not** include task-organization units or relationships.
  Save those separately with `getTaskOrgContent()`.
- An unknown poid returns an empty `object_set([])`.
- **A missing poid returns the whole scenario**, not an error. Always send one.

```javascript
const content = await stpsdk.getCoaContent(poid);
// store content
```

:::caution .NET SDK 0.6.0: `GetCoaContentAsync` throws on real content
In HyssosTech.Sdk.STP 0.6.0 and earlier, `GetCoaContentAsync` passes STP's
answer to a JSON parser. Object-set text is not JSON, so it throws
`JsonReaderException` ("Unexpected character encountered while parsing value:
o") for every answer STP gives. `GetTaskOrgContentAsync` has the same defect.
0.6.1 returns the text unchanged as a `string`, ready for
`ImportCoaContentAsync`. With 0.6.0, use the JavaScript SDK to export a COA,
or export the whole scenario with `GetScenarioContentAsync()`.
:::

### Loading: `ImportCoaContent`

`ImportCoaContent` loads a COA and its units, graphics and tasks from
object-set text, typically produced by `GetCoaContent`, into the active
scenario. It returns the poid of the imported COA. Use it with
`setCurrentCoa` to work on that COA.

```javascript
const coaPoid = await stpsdk.importCoaContent(content);
await stpsdk.setCurrentCoa(coaPoid);
```

```csharp
string coaPoid = await stp.ImportCoaContentAsync(content);
await stp.SetCoaAsync(coaPoid);
```

Know what an import does before you use it:

- **Poids are kept exactly as they are in the content.** The content is not a
  template, and no new ids are generated. Importing the same content twice
  does not create a second copy.
- **An object whose poid already exists in the scenario is replaced** by the
  one in the content. Its previous version stays in the undo history. Objects
  not in the content are left alone. An object that carries the deletion
  version (`fsdb_version 0`) deletes that poid. This is why the import is
  classed as destructive.
- Every client receives one `CoaAdded` per COA in the content, one
  `SymbolAdded` per symbol and one `TaskAdded` per task. A replaced object is
  reported as added (`CoaAdded`, never `CoaModified`). Deleted objects are
  reported as `CoaDeleted`, `SymbolDeleted` or `TaskDeleted`.
- Content without a `coa` object answers `null`, and blank content imports
  nothing. Malformed content is refused with the parse error.
- Task organizations are not part of COA content. Load them with
  `importTaskOrgContent()`.

`GetCoaObjectSet` and `ImportCoaFromObjectSet` are the JSON-array forms of
the same pair: send the objects exactly as `GetCoaObjectSet` returned them.
Each object's `PrologTerm` holds its content as STP text, so an object without
it is refused before anything is applied. Engines before STP-1090 cannot import
that array back; with them, use the text forms to save and load a COA.

## A task organization per COA

`SetCoaTaskOrg` and `ResetCoaTaskOrg` choose which task organization (TO) a
COA uses.

**Without `coaPoid`** they work on the default TO of an affiliation:

- `SetCoaTaskOrg(toPoid)` makes the TO the default for its affiliation,
  exactly as `SetDefaultTaskOrg` does.
- `ResetCoaTaskOrg(affiliation)` unsets the default TO for that affiliation,
  exactly as `ResetDefaultTaskOrg` does. The TO itself is not deleted.
  `affiliation` is required, and must be `friend`, `hostile` or `any`.

**With `coaPoid`** the contract describes a TO tied to one COA:
`SetCoaTaskOrg(toPoid, coaPoid)` makes that COA use the TO, instead of the
affiliation default, while it is current; `ResetCoaTaskOrg` with `coaPoid`
removes the tie, for one affiliation or for all of them when `affiliation` is
omitted, and the COA falls back to the affiliation default.

:::caution Engines before STP-1077 refuse `coaPoid`
On engines before STP-1077, a call with `coaPoid` is refused with
`success: false` and "per-COA task org is not supported yet", and changes
nothing. Handle the refusal and fall back to the affiliation default.
:::

Both answer `null` on success. If your current TO changes as a result, your
client receives `TaskOrgSwitched`. A `toPoid` that names no task org is
refused with the reason. Engines before STP-1091 do not check `toPoid`: an
unknown one answers success and changes nothing. Take the poid from
`getScenarioTaskOrgList()`, `onTaskOrgAdded` or `importTaskOrgContent()`.

```javascript
// The default friendly TO
await stpsdk.setCoaTaskOrg(friendlyToPoid);

// A TO for one COA: refused by engines before STP-1077
try {
    await stpsdk.setCoaTaskOrg(toPoid, coaPoid);
} catch (e) {
    console.warn('Per-COA task org not available:', e instanceof Error ? e.message : e);
}

// Clear the friendly default
await stpsdk.resetCoaTaskOrg({ affiliation: 'friend' });
```

In .NET, use `SetCoaTaskOrgAsync(toPoid, coaPoid)` and
`ResetCoaTaskOrgAsync(affiliation, coaPoid)` (HyssosTech.Sdk.STP 0.6.1 or
later; leave `coaPoid` null for the default TO). Before 0.6.1, use
`SetDefaultTaskOrgAsync(poid)` and `ResetDefaultTaskOrgAsync(affiliation,
token)` for the default TO. See [Task Org / ORBAT](./task-org.md) for how the
active TO is chosen.

## Methods the engine does not dispatch

The .NET SDK still has COA methods whose wire methods are not in the contract
and that STP answers with "No handler": `CreateCoaAsync`,
`CreateDefaultCoaAsync`, `RequestActiveCoasAsync`, `GetScenarioCoasAsync`,
`GetCoaObjectsAsync`, `GetCurrentCoaPoidAsync`, `SwitchRoleAndCoa` and
`SwitchRoleAndCoaAsync`. Use the methods on this page instead: `AddCoa` to
create a COA, the replay of `JoinScenarioSessionAsync` to list COAs,
`OnCoaSwitched` to learn the current COA, and `SetRoleAsync` followed by
`SetCoaAsync` to switch role and COA.

## See also

- [Roles](./roles.md): a role change can change your current COA and TO
- [Task Org / ORBAT](./task-org.md): loading TOs and how the active TO is chosen
- [Scenarios](./scenarios.md): create, load, join and save the whole scenario
- [Method safety classes](../reference/method-safety.md): which calls read,
  write or destroy
- [Errors, refusals and timeouts](./errors-and-timeouts.md): how a refused
  request is reported
