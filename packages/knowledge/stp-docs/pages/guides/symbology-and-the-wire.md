---
sidebar_label: Symbology and the wire
sidebar_position: 10
---

# Symbology and the wire

STP describes every symbol twice - once in MIL-STD-2525C and once in 2525D -
and sends symbology attributes as **names**, not numbers. Both facts have
consequences that are easy to hit and hard to diagnose, because the failure is
silent: a value STP sends can arrive at your code as `null` with no error.

This page explains the contract so you can recognise the symptom.

## The two standards

A symbol carries both encodings at once. They are not alternatives; the engine
populates whichever it can derive.

| property | standard | example |
|---|---|---|
| `CharlieSIDC` | 2525C, 15-character legacy code | `SFGPUCI----E---` |
| `DeltaSIDC` | 2525D, 20 digits - `partA` + `partB` | `10031000151211000000` |
| `partA` / `partB` | the two halves of the 2525D code | `1003100015` / `1211000000` |
| `symbolSet` | 2525D symbol set | `10` |

Derive values through the SDK's accessors rather than by slicing the string.
Position-based indexing works until it meets a symbol whose encoding differs,
and then fails quietly.

:::caution `CharlieSIDC` can be null
Symbols that exist only in 2525D have no 2525C equivalent, so `CharlieSIDC` is
`null` for them. Code that assumes a legacy code is always present will break on
D-only symbols. Treat a null `CharlieSIDC` as "no 2525C representation", not as
an error.
:::

## Attribute names are the wire contract

Affiliation, echelon, modifier and related attributes travel as **strings**, and
those strings are the enum member names from the engine. The bridge serialises
them with `.ToString()`, so the member name *is* the protocol.

```json
{ "affiliation": "assumed_friend", "echelon": "company", "modifier": "none" }
```

This matters because it means an SDK whose enum names differ from the engine's
cannot represent what the engine sent - there is no numeric fallback.

### The current values

| attribute | values |
|---|---|
| `affiliation` | `pending`, `unknown`, `assumed_friend`, `friend`, `neutral`, `suspect`, `hostile` |
| `affiliation` (exercise) | `exercisepending`, `exerciseunknown`, `exerciseassumedfriend`, `exercisefriend`, `exerciseneutral`, `exercisesuspected`, `exercisehostile` |
| `echelon` | `none`, `team`, `squad`, `section`, `platoon`, `company`, `battery`, `troop`, `battalion`, `regiment`, `brigade`, `division`, `corps`, `army`, `army_group`, `region`, `command` |
| `modifier` | `none`, `feint_dummy`, `hq`, `feint_dummy_hq`, `task_force`, `feint_dummy_task_force`, `task_force_hq`, `feint_dummy_task_force_hq`, `installation` |

Note the inconsistency in the exercise affiliations: they retain the older
spellings (`exerciseassumedfriend`, `exercisesuspected`) while the base values
use `assumed_friend` and `suspect`. This is deliberate on the engine side.
Do not "correct" the exercise values to match the base ones - they would then
stop matching what STP sends.

## Version skew: the silent failure

Several attribute names were changed in 2026 so that they match the values the
engine's symbol tables have always authored:

| attribute | was | now |
|---|---|---|
| `affiliation` | `assumedfriend` | `assumed_friend` |
| `affiliation` | `suspected` | `suspect` |
| `echelon` | `armygroup` | `army_group` |
| `modifier` | `dummy` | `feint_dummy` |
| `modifier` | `dummy_hq` | `feint_dummy_hq` |
| `modifier` | `dummy_task_force` | `feint_dummy_task_force` |
| `modifier` | `dummytask_force_hq` | `feint_dummy_task_force_hq` |

If your SDK predates the rename, it does not recognise the new strings. **The
values do not raise an error - they arrive as `null`.** The SDKs decode these
attributes leniently so that one unknown value cannot fail an entire message,
which means an unrecognised name is discarded silently.

### Symptom

Symbols arrive with `affiliation`, `echelon` or `modifier` unset, while the same
symbols display correctly in other STP clients. Typically only *some* symbols
are affected - the ones carrying a renamed value - which makes it look like a
data problem rather than a version problem.

### What to check

1. Compare the attribute values in the table above against the enum your SDK
   declares. A mismatch on any single name means skew.
2. Upgrade to a version at or after the rename: **`sketch-thru-plan-sdk`
   0.6.14** (npm) or **`HyssosTech.Sdk.STP` 0.4.2-preview** (NuGet).
3. If you cannot upgrade, read the attribute from the raw message rather than
   the typed property, so an unknown name is preserved rather than dropped.

### Why it is silent by design

The lenient decoding is deliberate: a message carrying one attribute the SDK
does not know should still deliver the rest of the symbol. The cost is that
version skew looks like absent data. When an attribute you expect is missing,
suspect skew before suspecting the engine.

## Checking round-trip fidelity

The most reliable way to detect this class of problem - not just for symbology -
is to compare what you sent against what came back. Add a symbol, capture the
`SymbolAdded` event, and compare the attributes field by field. Anything the
engine derived, normalised or dropped shows up immediately, and the same
technique catches issues that no error message reports.

A stronger variant, useful when you suspect skew: send a symbol **without** the
attribute set and let the engine derive it from the SIDC. The value that comes
back is then unambiguously the engine's own, rather than an echo of yours.

## See also

- [Symbol Properties](../reference/symbol-properties.md) - the full property list
- [Symbols and Rendering](./symbols-and-rendering.md) - drawing symbols on a map
