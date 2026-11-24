# STP-1808 landing handoff (Q157 a, 2026-11-24)

## Done
- JS SDK `release/5.12`: cherry-picked wording commit f90842e as **48673ae** (`-x` line kept, subject ends
  `[skip ci]`). 339/339 JS tests passed. Pushed fast-forward 9d523ad..48673ae. JS main untouched.
- MCP: branch claude/STP-1808-repin from claude/STP-1805-mcp-descriptions (e3730f3, includes 9a574de /
  STP-1804). Contract re-pinned to 48673ae with `npm run contract:update -- --from-git <local sdk-js clone>
  --ref 48673ae...` (the GitHub API route returned HTTP 401 in this sandbox). Only pin.json changed;
  the contract text is identical to f90842e, so no snapshot change.
- `npm test`: 202/202, tool-choice eval 36/36 (floor 1.0), search-eval recall@5 73/73 (floor 0.98 unchanged).
- Landed on MCP main with [skip ci] on the tip commit; no PRs, labels or workflow runs.

## Notes
- The first push was denied by the auto-mode classifier, then by the git proxy (repo not in session sources);
  resolved by the operator approval plus `add_repo` for sketch-thru-plan-sdk-js with push access.
- `npx vitest run -u` alone reported 11 failed files (import errors) in this checkout, yet reported no
  snapshot writes (git status showed only pin.json modified); `npm test` passes fully. Not diagnosed.
- No CI has run on either tip; run it when convenient.
