# stp-mcp - rules every session in this repo follows

- **Public material only.** This repo is MIT, like the STP SDKs. Everything here, and everything a
  server serves, must already be public: the OpenRPC contract (hyssostech/sketch-thru-plan-sdk-js) and
  the STP docs (hyssostech/stp-docs). Never copy in STP engine source or internals, stp-data,
  customer scenarios or plans, doctrine tables, or the GenSTP system prompt. Proprietary additions go
  in a separate private package that depends on this one.
- **The contract is the source of tool definitions.** Never hand-write a tool list or a param schema
  for an STP method; change the contract upstream, re-pin it (`npm run contract:update`), regenerate
  the snapshot (`npx vitest run -u`) and review the diff.
- **The docs corpus is a verbatim pin.** `packages/knowledge/stp-docs` is copied from hyssostech/stp-docs by
  `npm run docs:update`; never hand-edit it (normalization happens at load time in `src/docs.ts`). The
  generated API reference (`docs/api`, `docs/api-net`) stays out unless the evaluation shows it helps.
- **The search evaluation floor only goes up.** `packages/knowledge/eval/search-eval.json` and the recall
  floor in `test/search-eval.test.ts` guard `search_docs`; fix ranking or expected sources, never lower the floor.
- **Never expose a method the engine refuses.** `x-engineDispatch: none` and `x-layer: transport`
  methods are excluded by the generator; keep it that way.
- **Read-only by default.** Write/destructive tools need the live server's write mode, and destructive
  ones a per-call user confirmation (STP-1065).
- **Refuse or explain, never a silent failure.** An unknown name, a refused call or a timeout returns
  `isError` with the reason, never an empty success.
- Work is tracked in the STP Jira project under epic STP-943 (STP-1058 - STP-1065).
