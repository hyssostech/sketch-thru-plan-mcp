---
sidebar_label: Integration troubleshooting
sidebar_position: 12
---

# Integration troubleshooting

This page is for the case where a JSON-RPC or REST call to STP returns
successfully - no exception, no error status - and the result is still wrong:
absent, incomplete, or not what the payload described. It complements
[Silent failures](./silent-failures.md), which covers the wipe/replace/append
mechanics and the version-skew case for symbology attributes; this page does
not repeat those and links to them where relevant.

Each entry below states the symptom you would actually see, the real cause,
and the check that tells you which one you are looking at.

## A call throws with no useful message

**Symptom.** A JSON-RPC call throws `StpException` with an empty message on
the .NET SDK. On the JavaScript SDK the returned promise rejects with `null` -
no `Error` object, no text - or, for the fire-and-forget calls such as
`AddCoa`, simply nothing happens. The call is well-formed - the same shape
that works for other methods - and there is nothing in your own code to fix.

**Cause.** The method has no handler in the engine's WebSocketsBridge
dispatcher. A request for a method the dispatcher does not recognize still
gets a reply - `RequestResponse` with `success:false` and `result:null` - it
is simply refused rather than acted on. Both SDKs build their failure from
the `result` payload, and it is null: .NET wraps it in an `StpException` with
an empty message, JavaScript rejects the promise with it as-is.

On current releases, this is not method-specific noise; it is a fixed list.
The methods below are dispatched by the SDK but never reach the engine:

.NET SDK (`HyssosTech.Sdk.STP`):

```
CreateCoa, CreateDefaultCoa, DeleteCoa, GetActiveCoaList,
GetActiveScenarioDescription, GetAllObjects, GetCoaContent, GetCoaObjects,
GetCurrentCoaPoid, GetDeletedObjects, GetPoidObject, GetScenarioCoaList,
GetScenarioTaskOrgList, GetTaskOrgObjects, ImportCoaContent,
ResetStpScenario, SetCurrentCoa, SwitchRoleAndCoa, SwitchTaskConfirmation
```

JavaScript SDK (`sketch-thru-plan-sdk`):

```
AddCoa, UpdateCoa, DeleteCoa, SetCurrentCoa, GetCoaContent,
ImportCoaContent, SetCoaTaskOrg
```

These calls cannot succeed on current releases. Most of them are the COA
(course of action) surface - if your integration switches or manages COAs
through the SDK rather than through the STP client UI, expect to hit this
list.

**How to tell.** Two independent checks, either is sufficient:

1. The engine's own log records the refusal as `No handler for <message>` at
   warning level, at the moment the call was made.
2. In the JSON-RPC contract (`json-api/sketch-thru-plan-api.json`, mirrored in
   [the JSON API reference](../reference/json-api.md)), a method the engine
   does not dispatch carries `"x-engineDispatch": "none"`. If you can inspect
   the contract entry for the method you called, this settles it without
   needing engine log access.

**What to do.** There is no client-side workaround for a method the engine
will not dispatch - do not retry, and do not treat the empty message as a
transient error. If your integration depends on one of these calls, route
around it: for COA management specifically, that usually means driving the
change through the STP client rather than the SDK, or restructuring the
integration so it does not need the call.

## `GetScenarioObjectSetContentAsync` / `GetTaskOrgObjectSetAsync` / `GetCoaObjectSetAsync` throw a deserialization exception (.NET)

**Symptom.** One of these three ObjectSet getters throws a
`JsonSerializationException` complaining that a JSON array cannot be
deserialized into `ObjectSet`. The call reaches the engine and gets a
response - this is not the "no handler" case above.

**Cause.** The engine replies to these three methods with a bare JSON array.
The SDK's typed contract expects an `ObjectSet` object (with an `objects`
property wrapping the array). The mismatch is on the wire shape, not the
data - the engine is not withholding anything, the SDK just cannot parse what
comes back.

**How to tell.** The exception is specifically a `JsonSerializationException`
raised while deserializing to `ObjectSet`, and it is unconditional - it
happens on every call to these three methods, not intermittently.

**What to do.** Fixed in the .NET SDK after 0.4.2-preview: the getters now
accept the bare array (and still accept the wrapped form). On 0.4.2-preview
or earlier, do not call the typed `ObjectSet` methods for these three; send
the underlying request through the connector directly and deserialize the
response yourself as `List<StpObject>`.

## Events never arrive although `IsConnected` is true (.NET)

**Symptom.** You connect, `IsConnected` reports true, and calls succeed, but
an event handler you attached - `OnSymbolAdded`, `OnTaskOrgUnitAdded`, or any
other - never fires, even though the corresponding action definitely
happened (you can see the effect with a `Get*` call).

**Cause.** `Register` tells the engine which events to route to you by
sending a list of solvables, and that list is built once, from whichever
handlers are already attached at the moment you call `ConnectAndRegisterAsync`
(or `RegisterAsync`). A handler attached *after* that call is invisible to the
engine - it was never asked to send that event, so it does not, silently.
`IsConnected` only reflects the transport; it has nothing to say about which
events were registered.

**How to tell.** If the handler was attached after the connect/register call
in your code, this is almost certainly it. This was reproduced
deterministically across repeated runs: subscribe after connecting, and the
event is dropped every time, not occasionally.

**What to do.** Attach every event handler you need *before* calling
`ConnectAndRegisterAsync` (or before `RegisterAsync`, if you connect and
register separately) - either via the constructor/hooks parameter the SDK
exposes for this, or with `+=` ahead of the connect call. Adding a handler
later requires disconnecting and reconnecting to re-register.

## Indexing into `params` throws on `InkProcessed`, `SpeechDiscarded`, `NewScenario`

**Symptom.** Code that reads the parameters of one of these three events -
for example indexing into an array it expects to be there - throws, even
though the event itself clearly fired.

**Cause.** These three events carry no parameters, and the engine represents
"no parameters" by omitting the `params` key from the message entirely, not
by sending an empty array. Code written on the assumption that `params` is
always present (even as `[]`) will throw when it is not there at all.

**How to tell.** This is documented in the JSON-RPC contract itself: each of
these three events is listed with an empty `params` schema and a note that
the key is absent on the wire. If your handler assumes an array and the
failure is a missing-property or undefined-index error rather than a value
error, this is the cause.

**What to do.** Treat these three events as parameterless. Do not index into
`params` for them; check for its presence before reading anything out of it
if your event-handling code is generic across event types.

## A deleted symbol still shows up in `GetScenarioContent`

**Symptom.** You call `DeleteSymbol` (or the equivalent delete), the call
succeeds, and the poid still appears when you fetch the scenario content
afterward.

**Cause.** STP deletes are soft deletes. A deleted object is not removed; it
is marked with a tombstone version rather than physically purged, and
`GetScenarioContent` (unlike a live-only fetch) includes tombstoned records.
This was reproduced directly: after a delete, the poid is still present in
the scenario content, and re-adding a symbol at the same poid succeeds and
comes back with a new version rather than being rejected as a duplicate.

**How to tell.** Look at the version field on the record. By convention a
tombstone carries version `v0`; a live object carries an opaque version
string (for example `v15R34UNA8BPRGYFMT185HFJ2MA`) that changes on every
write - versions are identifiers, not counters, so do not expect them to
increment. A `v0` record for a poid you deleted is the tombstone, not a live
object that survived the delete.

**What to do.** Do not treat presence in `GetScenarioContent` as proof an
object is live - filter on the version/status marker and treat a tombstoned
record as deleted for your integration's purposes. Do not build logic that
assumes a deleted poid can never be reused: re-adding at the same poid is a
supported, ordinary operation, not an error condition.

## A symbol added through the API never joins the task organization

**Symptom.** A symbol you add through the SDK or REST connector appears on
the map, and shows up as its own root rather than under the parent unit you
intended - both in your own client and, if you export or bridge the
scenario, in the exported task organization.

**Cause.** STP does not infer task-organization membership from a symbol's
identity, name, or location. A symbol added without an explicit
linkage to a task-org unit is not auto-homed; it becomes a parentless root.
This was confirmed directly: adding a symbol with no linkage argument comes
back with the parent/task-org linkage fields null, and produces no
task-org-side events at all - the engine is not silently doing the linking
somewhere you cannot see, it genuinely is not linking it.

**What is not settled here:** whether the current REST connector exposes a
linkage argument on the add call, and what it is named, was not confirmed
while writing this page - the picture on that point has changed release to
release. Check the current API reference for the add-symbol operation for a
task-org linkage parameter before assuming it does or does not exist.

**How to tell.** After adding a symbol, check whether its parent/task-org
linkage fields are populated. If they are null and you did not set them
explicitly, the symbol is an orphan root regardless of how it looks in a UI
that renders the map and the task-org tree separately - a UI that reads only
the task-org tables can look correct while the two populations are actually
disjoint.

**What to do.** See [Task organization](./task-org.md) for how the task-org
tree is structured, and supply the linkage explicitly at add time rather than
relying on any automatic association - there is none.

## A POSTed symbol returns success but vanishes from the scenario

**Symptom.** A POST to add a symbol returns 200/201. The symbol never
appears in a subsequent `GetScenarioContent` or `/scenario` fetch - not as an
error, just absent.

**Cause.** `fsTYPE` is the field STP uses to determine the object's class
(unit, tactical graphic, activity, and so on) - it is not the symbol set and
not derived from the SIDC by every code path that touches it. If `fsTYPE` is
never bound for a given symbol - typically because the client sending it
cannot classify the SIDC it was given - the engine has nothing to dispatch
the object on, and it is stored without becoming queryable through any of the
normal consumers, which all filter by resolved type.

**How to tell.** This shows up specifically for symbols whose SIDC comes from
a symbol set or standard the sending client does not know how to classify.
A 200/201 response is not evidence the symbol was fully processed - only that
it was accepted for processing.

**What to do.** Confirm the symbol you are sending has a well-formed SIDC
that the client-side classification logic actually recognizes, rather than
assuming any valid-looking SIDC will resolve correctly end to end.
[Symbology and the wire](./symbology-and-the-wire.md) covers the two
symbology standards and how to derive their values correctly.

## "Coordinates are undefined" on a reconcile

**Symptom.** After a scenario reload, session switch, or reconcile, a symbol
fails to render with an error along the lines of "Coordinates are undefined
or empty" - even though the symbol clearly has a location, and rendered
correctly before.

**Cause.** The message is misleading: coordinates are present. What is
missing is the location's type/shape classification field, which is required
for the geometry to be interpreted. This happens specifically when a symbol
is re-added at a poid that currently exists only as a tombstone (see the
deleted-symbol entry above) - the add-over-tombstone path can store the raw
location without deriving that classification field, leaving a location that
has coordinates but nothing that says what shape they describe. Consumers
that require the classification field to interpret the coordinates then
report them as absent.

**How to tell.** This is specific to symbols that were deleted and then
re-added at the same poid - most commonly through a reconcile, since a
reconcile's deterministic poid derivation is exactly what causes a re-add to
land on a prior tombstone rather than a fresh poid. If the affected symbols
were all previously deleted (by you or by a prior reconcile) and then
reappeared in the payload, this is almost certainly it.

**What to do.** This has been fixed in current releases, both on the engine
side (the add-over-tombstone path now derives the location's classification
before storing it) and defensively in the JavaScript SDK (which infers the
classification from the coordinates when it is missing, rather than treating
the location as absent). If you still see this on a current release, capture
whether the affected poids were previously deleted, since that is the
precondition the fix addresses.

## Zero units appear after a push through the ArcGIS Pro add-in

This one is scoped narrowly on purpose: it is not an STP wire trap, and it
does not apply if your integration talks to STP directly through the SDK or
REST connector rather than through the ArcGIS Pro add-in's map layer.

**Symptom.** After pushing units through the ArcGIS Pro add-in - commonly
following a `?replace=true` load, but not only then - none of the units
appear on the Pro map, friendly or hostile, while other object types
(tactical graphics, for instance) in the same push draw normally. STP's own
scenario content holds every unit that was sent; the loss is entirely
downstream of STP, inside the add-in.

**Cause.** STP is not the source of this limit. The 2525C military overlay
geodatabase that the ArcGIS Pro add-in writes to has a
`Units.uniquedesignation` field of `String(30)`, and the add-in writes STP's
`designator` into that field without truncating it. The add-in flushes each
layer as a single atomic edit operation, so one designator over 30
characters fails that entire geodatabase write, not just the offending row.
STP itself holds the full, untruncated designator with no such width limit.

**How to tell.** Check the length of every designator in the batch against
30 characters, and confirm independently - by querying STP directly, not by
looking at the Pro map - that STP actually holds the units. If STP has the
data and the Pro map does not draw it, the geodatabase field width in the
add-in is the near-certain cause, not a loss in STP or in transit.

**What to do.** Keep designators at 30 characters or fewer when your
integration writes through the ArcGIS Pro add-in's overlay geodatabase. This
constraint is specific to that integration path.

## A SitaWare push returns 500

**Symptom.** A push to a SitaWare-connected consumer returns HTTP 500.

**Cause.** Most commonly, an element name (task-org or ORBAT element) exceeds
the 100-character limit that consumer enforces; SitaWare rejects the payload
and the rejection reaches you as a 500.

**How to tell.** The connector already logs the exact payload it sent at the
point of rejection - the rejected body is written to the connector log at
warning level alongside the response code, so you do not need to reconstruct
what was sent. Check the lengths of the element names in that logged body
first; that is the common signature for this failure.

**What to do.** Read the connector log's rejection line before forming a
hypothesis about the cause - the exact payload that failed is already on
disk, which is faster and more reliable than guessing from the response code
alone. If the names are within limits, treat the 500 as a genuine unexplained
rejection rather than assuming the name-length cause.

## General technique

Every entry above is a specific case of one habit:
[Silent failures](./silent-failures.md) explains it in full, but the
short version is to compare what you sent against what came back, field by
field, rather than trusting a success response as proof the outcome matched
your intent. That page also covers the wipe/replace/append/reconcile
mechanics and the symbology version-skew case, which are the other major
source of "it succeeded, but..." reports and are not repeated here.
