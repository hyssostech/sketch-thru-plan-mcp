---
sidebar_label: Silent failures
sidebar_position: 11
---

# Silent failures and how to detect them

Most integration problems with STP announce themselves - a connection is
refused, a request returns 400, an exception is thrown. This page is about the
minority that do not, because those are the ones that cost days.

The common shape: **the call succeeds, and the outcome is not what you asked
for.** No error is raised, nothing appears in a log you are watching, and the
discrepancy only surfaces later as missing data.

## The general technique

Before reaching for any specific remedy, adopt one habit:

> **Compare what you sent against what came back.**

Add the symbol, capture the resulting event, and compare the object field by
field with the one you submitted. STP normalises, derives and occasionally
discards values, and a field-by-field comparison makes all three visible at the
point they happen rather than an hour later.

This single technique catches the specific cases below *and* the ones not yet
documented, which is why it is worth building into your integration harness
rather than applying only when something looks wrong.

A stronger variant, when you suspect a value is being misinterpreted: send the
object with that field **unset** and let STP derive it. What comes back is then
unambiguously STP's own value rather than an echo of yours.

## An empty payload wipes the scenario

Posting a scenario with no objects to the [REST connector](../reference/rest-connector.md)
is not a no-op. Unless the post says `?append=true`, it is treated as a request
to clear, and STP performs a full wipe - the same operation as an explicit
`?replace=true`.

```
POST /api/v1/scenario   # payload contains no objects
-> scenario cleared via new_scenario
```

The REST connector logs it:

> `Empty scenario payload received - clearing STP via full wipe (new_scenario).`

This matters because an empty payload is rarely deliberate. It is usually the
result of an upstream filter that matched nothing, a failed export, or a
serialisation that produced an empty collection. The request returns success,
and the scenario is gone.

:::danger Guard the empty case in your own code
Check for an empty object set **before** posting and decide explicitly whether
you meant to clear the scenario. Do not rely on STP treating "nothing" as
"do nothing" - it does not.
:::

## Replace, append, and the default

Three behaviours, and only one of them is additive:

| request | effect |
|---|---|
| `?replace=true` | **wipes** the resident scenario and reloads it from the payload |
| `?append=true` | adds the payload to the resident scenario |
| neither | reconciles the payload against what is resident |
| empty payload, without `append=true` | **wipes** (see above) |
| empty payload, with `append=true` | nothing is applied |

`append=true` and `replace=true` together are rejected with a 400 - they ask for
opposite things, and honouring both would make the result depend on evaluation
order.

The distinction to hold onto is that **the default is not "add"**. If you expect
your objects to be added to what is already loaded, say `append=true`; otherwise
you get a reconcile, which may remove resident objects your payload does not
mention.

A post that asserts no symbols, tasks or ORBAT at all - a time-only update,
say - removes nothing, behaving like an append. So the risk is not "reconcile
deletes everything"; it is that a payload describing *some* units implicitly
asserts the *complete* set of units, and residents missing from it are removed.
The assertion covers more than the kinds you sent: once a post carries any
symbols, tasks or ORBAT, resident symbols, tasks and task-organization objects
it does not mention are all candidates for removal - a symbols-only post also
removes the resident tasks. Use `?mode=dryrun` to see what a post would delete
before applying it.

## Symbology values arriving as null

If symbols arrive with `affiliation`, `echelon` or `modifier` unset while the
same symbols look correct in other STP clients, the usual cause is **version
skew**, not missing data. Symbology attributes travel as enum member names, and
an SDK that does not recognise a name discards it silently rather than failing
the whole message.

[Symbology and the wire](./symbology-and-the-wire.md) covers the detection steps
and the versions that carry the fix.

## When something "did not work"

A checklist for the case where a call succeeded and the result is wrong:

1. **Compare sent against returned.** Field by field. Most of the answer is
   here.
2. **Check for an empty payload** anywhere in the chain - it is a wipe, not a
   no-op.
3. **Check which load mode you used.** The default reconciles; it does not
   append.
4. **Check for null attributes** that should have values - suspect version skew
   before suspecting the engine.
5. **Read the connector log rather than only your own.** Rejections are
   frequently logged with the offending payload attached, so the evidence you
   need often already exists on disk.

## See also

- [Scenarios](./scenarios.md) - loading and managing scenarios
- [Symbology and the wire](./symbology-and-the-wire.md) - the version-skew case
