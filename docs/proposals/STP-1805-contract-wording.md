# STP-1805: proposed contract wording

Tool descriptions for STP methods come from the contract (`json-api/sketch-thru-plan-api.json` in
hyssostech/sketch-thru-plan-sdk-js), pinned here at 0.9.11. This repo does not edit them (CLAUDE.md). These are
the changes proposed upstream, so that a model that loads a tool reads the same routing rule that the stp-live
instructions now state: **codes come from data or from STP, never from the model; words go to recognition,
structured data passes through as given, and a mixed request does both** (STP-1476, comments 15340, 15346 and 17312).

Each proposal is tied to the cases in `packages/live/eval/tool-choice-eval.json` that it closes. Those cases are
gaps today (the eval prints `GAP ... [proposal: <Method>]`). After the contract re-pin (`npm run contract:update`,
then `npx vitest run -u`), raise `PASS_FLOOR` in `packages/live/test/tool-choice-eval.test.ts` to the new score.
At 0.9.11 the score is 11/15. With all three proposals it is 15/15.

What these proposals leave out, because comment 15346 withdrew it: refusing a 2525C-only `AddSymbol`, a general
"describe, don't encode" rule, and pointing integrator input to recognition. The wording sends input to a path
by its kind. It never sends data to recognition.

## AddSymbol

**Current** (first sentence):

> Create one symbol (a unit, tactical graphic or other 2525/APP-6 object) directly from a full definition, with no
> sketch or speech recognition - use it when the program already knows the symbol's sidc and location; to
> recognize what a user draws and says, use SendInk with speech instead.

**Proposed:**

> Create one symbol (a unit, tactical graphic or other 2525/APP-6 object) directly from a full definition, with no
> sketch or speech recognition. Use it when the sidc comes from the user's data, a file or STP (an existing object,
> SearchSymbol): a feed, rows with SIDCs, a copied symbol. Pass that sidc as given and do not compose one. For a
> symbol described in words ("a recon platoon at the bridge"), use SendSimulatedSpeechRecognition with SendPenDown
> and SendInk, and STP produces the code.

The rest of the description stays unchanged.

**Why:** "already knows the symbol's sidc" invites guessing, because a model always believes it knows the code
(comment 15340). In the 2026-11-02 session, AddSymbol was chosen for "place ... company" and the model wrote the
SIDC itself. The old pointer to SendInk was framed as "what a user draws and says", so the model discounted it.
The new text says where the input comes from, not what the caller knows.
Cases: `place-recon-words` (facts `addsymbol-input-source`, `addsymbol-names-recognition`) and `place-recon-data`
(`addsymbol-input-source`). The data case is kept faithful too: "pass that sidc as given".

**Open, not wording:** comment 15346 says a 2525C-only `AddSymbol` that the engine ignores is an engine gap.
Until the engine is fixed, the outcome should explain the limitation. Once a capture shows what the engine does,
an `x-stpEdgeCases` entry for "2525C-only sidc" would let V10 name it. That needs evidence first.

## SendSimulatedSpeechRecognition

**Current** (first sentence):

> Send typed text as if a speech recognizer had heard it - the simplest way for a program to 'say' a phrase such as
> 'infantry platoon', with a SendInk stroke or on its own.

**Proposed** (add a second sentence):

> Send typed text as if a speech recognizer had heard it - the simplest way for a program to 'say' a phrase such as
> 'infantry platoon', with a SendInk stroke or on its own. Use it when a symbol or task is described in words: send
> the phrase with SendPenDown and SendInk strokes for its place (a point, a line or an area outline), and STP
> produces the code and properties. For a symbol whose code is already in the user's data, use AddSymbol.

**Why:** this is the recognition path that the instructions now point words to. Today its description reads as a
developer convenience ("for a program to 'say'"), so a model looking for "place a unit" does not see it as the
tool for that. The added sentence names the input it serves and its counterpart.
Cases: `place-recon-words`, `objective-words` (fact `simspeech-for-words`).

## SearchSymbol

Two known gaps. A third change, the codes note, keeps a model from editing a template into a finished code.

### 1. The bridge's `/symbol-index.json` route

**Current:**

> Answered by the SDK itself from the symbol index it loads (sketch-thru-plan-symbol-index.schema.json; the index
> ships with STP, by default in its installation directory) - the engine never receives it, so it works offline and
> costs no round trip.

**Proposed:**

> Answered by the SDK itself from the symbol index it loads (sketch-thru-plan-symbol-index.schema.json). The index
> ships with STP, by default in its installation directory. A running STP's WebSockets bridge also serves it over
> HTTP at `/symbol-index.json` on the bridge's host and port (https for wss), and a client without a local install
> loads it from there. The engine never receives the call, so it costs no round trip.

**Why:** stp-live loads the index from the bridge route (README, "SearchSymbol"). The contract names only the
installation directory, so a model or integrator who reads it cannot see where a remote client gets the index.
"Works offline" holds only for the local file.
Case: `code-lookup` (fact `searchsymbol-bridge-route`).

### 2. The edge case says `<path>` where the HTTP case has a URL

**Current** (`x-stpEdgeCases`):

```json
{"when": "the SDK has no symbol index (not installed, or the configured path does not exist or does not parse)",
 "outcome": "refused", "message": "symbol index not available: <path> (<reason>)",
 "note": "an error, never an empty result - [] would read as 'nothing matches'"}
```

**Proposed:**

```json
{"when": "the SDK has no symbol index (not installed; the configured path or URL does not exist, cannot be fetched or does not parse)",
 "outcome": "refused", "message": "symbol index not available: <source> (<reason>)",
 "note": "<source> is the path or URL the index was read from. An error, never an empty result - [] would read as 'nothing matches'"}
```

**Why:** stp-live's refusal is `symbol index not available: http://<host>:<port>/symbol-index.json (<reason>)`
(`SymbolIndexUnavailableError` in `packages/live/src/symbolsearch.ts`). The contract's `<path>` describes the SDKs'
file case only.
Case: `code-lookup` (fact `searchsymbol-edge-source`).

### 3. What the codes are

**Proposed** (add after "Each result names the gesture ..."):

> The codes are the symbol type's template (deltaSidc, and charlieSidc where a 2525C code exists, empty
> otherwise) with its default affiliation. They are not a finished symbol to complete by hand. To place a symbol
> described in words, use recognition (SendSimulatedSpeechRecognition with SendInk).

**Why:** SearchSymbol is the one STP source of codes for a name. Without this note, a model takes its template
and changes digits for affiliation or echelon, which is composing a code by another route. An empty charlieSidc
also has to read as "no 2525C code", or a model will make one up from the 2525D code (doctrine: C to D only).
Case: `code-lookup` (fact `searchsymbol-templates-contract`).
**To check before adopting:** whether the shipped index's deltaSidc carries an echelon. The test fixture's
entries do not, but they are synthetic.

## Not proposed: an MCP-side description overlay

`generateTools` copies `method.description` unchanged (`packages/contract-tools/src/generate.ts`, `toolFromMethod`).
An overlay could append MCP-owned sentences to a description without hand-writing a schema: a map from method
name to an appended text, applied in `exposedTools`, with a test that every key is a contract method and that no
schema changes. It would close the gaps above before the re-pin. It would also fork the wording the SDKs show
integrators, which the plan (comment 17312) sends upstream instead. It is not built. It is an open decision for
the operator.
