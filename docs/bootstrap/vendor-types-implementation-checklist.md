# Vendor Types Implementation Checklist

Reference: [`vendor-types-recommendation.md`](/home/kevin/worktrees/codapter/docs/bootstrap/vendor-types-recommendation.md)

## Goal

Implement a narrow first pass of vendored Codex and PI type definitions that:

- strengthens compile-time alignment with upstream contracts,
- avoids destabilizing the existing adapter,
- preserves the adapter-owned backend contract,
- and keeps the build/test/bootstrap story explicit.

## Non-Goals For This Pass

- Do not replace the full local `ThreadItem`, `Turn`, or `Thread` unions.
- Do not move PI-specific RPC types into `packages/core`.
- Do not add backward-compatibility fallbacks for multiple vendoring layouts.
- Do not widen scope into a full protocol refactor just because vendored types are available.

Note:

- The non-goals above applied to the initial first pass.
- The follow-on section below tracks the broader Codex protocol replacement once adapter changes were explicitly approved.

## Decisions To Lock Before Coding

- [x] Assign an owner for policy decisions and capture the final resolution in this checklist or a linked ADR
  - recommended owner: implementation lead for the vendoring task
  - required artifact: this checklist or a short ADR checked into `docs/bootstrap/`
- [x] Confirm generated vendor output policy:
  - default recommendation: keep `types/codex/` and `types/pi/` gitignored
  - require CI to run `npm run vendor-types` before build/test
- [x] Resolve CI network access as a hard prerequisite:
  - if CI cannot fetch, revisit the gitignore decision before implementation starts
- [x] Confirm vendoring output format:
  - recommended: generate `.d.ts` output, not raw upstream `.ts` source imports
- [x] Confirm manifest policy:
  - `vendor-types.manifest.json` is the single source of truth for repo, commit, and entrypoint list
- [x] Confirm update policy:
  - vendored updates happen only by editing the manifest and rerunning the script
- [x] Confirm license/attribution requirements for copied upstream material

Implementation decision notes for this pass:

- Owner: implementation lead for the vendoring task.
- Generated outputs remain gitignored under `types/codex/` and `types/pi/`.
- Output format is repo-root `.d.ts` declarations consumed by relative imports from workspace packages.
- Update path is manifest-only: edit `vendor-types.manifest.json`, rerun `npm run vendor-types`, then rebuild/retest.
- Attribution policy: preserve upstream headers for copied declarations and keep provenance metadata alongside generated output.
- License check completed against sibling checkouts:
  - `openai/codex`: Apache-2.0
  - `badlogic/pi-mono`: MIT
- CI/network decision point: this repo currently has no checked-in CI workflow to update. External CI owners must run `npm run vendor-types` before build/test and allow network fetches for the pinned commits. If that network policy is not acceptable, the gitignore policy must be revisited before rollout.

## External Plan Review

- [x] Run `$agent-runner-review` with `generic-gemini` on this checklist
- [x] Run `$agent-runner-review` with `generic-pi` on this checklist
- [x] Incorporate agreed review findings into the checklist before implementation
- [x] Capture the key review feedback:
  - clarify offline bootstrap and CI network dependency tradeoffs
  - make `.d.ts` output explicit rather than "declaration-friendly"
  - tighten subjective checklist items with clearer adoption gates
  - validate manifest schema, import rewriting, and failure modes explicitly
  - add stronger testing for the vendoring script itself, not just output existence

## Milestone 1: Vendoring Infrastructure

### 1.1 Manifest

- [x] Create `vendor-types.manifest.json`
- [x] Add `codex` entry:
  - repo URL
  - pinned commit
  - entrypoint files
  - output root
- [x] Add `pi` entry:
  - repo URL
  - pinned commit
  - entrypoint files
  - output root
- [x] Document that entrypoints are seeds and the script resolves transitive local imports as needed
- [x] Validate manifest structure at script runtime and fail loudly on malformed entries
- [x] Block implementation and escalate if the manifest cannot express multiple vendor targets cleanly
- [x] Decide whether the manifest or script should surface staleness metadata for pinned commits
  - decision: do not add staleness metadata in the first pass; pinned commits in the manifest remain the explicit update trigger.

**Done when**: manifest fully describes both vendor targets without hardcoded repo details inside the script.

### 1.2 Fetch Script

- [x] Create `scripts/vendor-types.mjs`
- [x] Clone each upstream repo into a temporary directory at the pinned commit
- [x] Resolve the transitive closure of local type imports starting from the manifest entrypoints
- [x] Follow only local relative imports during closure resolution unless an explicit exception is approved
- [x] Copy the required files into the configured output root
- [x] Rewrite relative type imports for `NodeNext` + ESM compatibility
- [x] Normalize copied output into `.d.ts` form suitable for `NodeNext` + ESM consumption
- [x] Preserve required attribution/header comments unless cleared otherwise
- [x] Decide whether the script needs additional dependencies for parsing or rewriting and add them explicitly if required
  - decision: reuse the existing workspace `typescript` dependency for AST-based extraction; no new dependency added.
- [x] Clean temporary directories after success and failure
- [x] Make failures loud:
  - missing upstream file
  - moved file
  - malformed manifest
  - import rewrite failure
- [x] Record generation provenance somewhere discoverable:
  - source repo
  - pinned commit
  - generation time or equivalent debug metadata
- [x] Ensure the script is deterministic across repeated runs

Implementation note:

- `copy` entrypoints preserve whole upstream declarations and follow relative-import closure.
- `extract` entrypoints preserve selected exported declarations plus any same-file exported type dependencies they reference, and they fail loudly on imported type references so unsupported `pi-mono` graph edges do not leak through as downstream build failures.

**Done when**: `node scripts/vendor-types.mjs` can regenerate the vendored output from the manifest alone.

### 1.3 Package Wiring

- [x] Add `"vendor-types": "node scripts/vendor-types.mjs"` to [`package.json`](/home/kevin/worktrees/codapter/package.json)
- [x] Update `.gitignore` to ignore `types/codex/` and `types/pi/`
- [x] Decide whether `tsconfig.base.json` needs path aliases or whether relative imports are sufficient
- [x] Verify the chosen wiring does not violate package `rootDir` constraints
- [x] Verify a fresh local clone can follow the documented bootstrap path with the chosen gitignore policy
  - decision: relative imports are sufficient; no `tsconfig` path aliases were needed.

**Done when**: the repo has a single documented command for generating vendored types.

## Milestone 2: Codex Type Adoption

### 2.1 Safe First-Pass Targets

- [x] Compare local and vendored shapes for:
  - `GitInfo`
  - `SessionSource`
  - `ThreadStatus`
  - `TurnError` only if shapes are identical after comparison
- [x] Record any shape mismatch before adoption
- [x] Adopt only types that are confirmed compatible with current adapter output

Comparison results:

- `GitInfo`: identical shape; adopted.
- `SessionSource`: not adopted in this pass because upstream includes additional variants beyond local adapter output.
- `ThreadStatus`: not adopted in this pass because upstream active flags pull a wider dependency edge.
- `TurnError`: not adopted in this pass because upstream imports `CodexErrorInfo`, widening the dependency set beyond the narrow first-pass goal.

**Done when**: at least one safe vendored Codex type can be imported without forcing broader protocol rewrites.

### 2.2 Protocol Integration

- [x] Update [`packages/core/src/protocol.ts`](/home/kevin/worktrees/codapter/packages/core/src/protocol.ts) to import at least one vendored Codex type
- [x] Keep local definitions in place where the adapter intentionally emits reduced shapes
- [x] Do not replace:
  - `ThreadItem`
  - `Turn`
  - `Thread`
- [x] Confirm existing exports remain stable for downstream packages

**Done when**: `protocol.ts` uses vendored Codex types in a narrow, compile-safe way.

## Milestone 3: PI Type Adoption

### 3.1 Backend Boundary

- [x] Keep [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts) adapter-owned
- [x] Do not import PI RPC types into `packages/core`
- [x] Keep `BackendEvent`, `BackendMessage`, and `IBackend` as the normalized internal contract

**Done when**: core remains backend-agnostic.

### 3.2 PI Parsing Integration

- [x] Update [`packages/backend-pi/src/pi-process.ts`](/home/kevin/worktrees/codapter/packages/backend-pi/src/pi-process.ts) to consume vendored PI RPC/session/event types where applicable
- [x] Reduce `unknown` parsing only where the vendored type covers the full set of values currently handled at that call site
- [x] Keep defensive runtime checks at the process boundary
- [x] Avoid a broad rewrite of all message mapping logic in the first pass

Adopted PI types for this pass:

- `ImageContent`
- `Usage`
- `AssistantMessage`
- `AssistantMessageEvent`
- `RpcExtensionUIRequest`
- `RpcExtensionUIResponse`

**Done when**: the PI backend uses vendored upstream types for targeted parsing paths without changing the adapter contract.

## Milestone 4: CI And Bootstrap

### 4.1 README And Developer Setup

- [x] Update [`README.md`](/home/kevin/worktrees/codapter/README.md) quick-start/setup steps
- [x] Add `npm run vendor-types` before `npm run build` / `npm run build:dist`
- [x] Add a short explanation of why vendored output is generated and gitignored
- [x] Add a short note about the local bootstrap consequence if vendored output is not committed

**Done when**: a fresh contributor can follow the README and build successfully.

### 4.2 CI Policy

- [x] Update CI pipeline to run `npm run vendor-types` before build
- [x] Update CI pipeline to run `npm run vendor-types` before tests if tests depend on vendored imports
- [x] Decide whether CI is allowed to fetch from the network
- [x] Document the fallback if CI cannot fetch:
  - stop here and revisit the gitignore decision
  - choose committed output instead

Decision point recorded:

- GitHub Actions is now checked in at `.github/workflows/ci.yml`.
- The workflow runs `npm ci`, `npm run vendor-types`, `npm run build`, `npm run lint`, and `npm test` on fresh clones.
- The checked-in CI policy therefore explicitly allows networked vendoring from pinned upstream commits before build/test.
- If that policy changes in the future, the fallback remains the same: commit generated vendored output instead of relying on CI-time fetches.

**Done when**: CI behavior matches the repo policy for vendored output.

## Milestone 5: Validation

### 5.1 Script Validation

- [x] Add a smoke test or validation step for `npm run vendor-types`
- [x] Add focused tests for the vendoring script logic if it contains non-trivial import parsing/rewriting behavior
- [x] Verify both output roots are created
- [x] Verify representative files exist under `types/codex/` and `types/pi/`
- [x] Verify import rewriting succeeded for generated declarations
- [x] Verify generated `.d.ts` output type-checks in isolation
- [x] Verify loud failure behavior for at least representative negative cases:
  - malformed manifest
  - missing upstream file
  - unreachable upstream repo
  - rewrite failure path

Validation note:

- `test/vendor-types.test.ts` covers deterministic generation, copy-mode import rewriting, extract-mode output, malformed manifest failure, missing-file failure, and unreachable-repo failure.
- Workspace build after `npm run vendor-types` provides the isolation/type-check confirmation for the adopted declaration imports.

**Done when**: vendoring failures are caught before build-time adoption work starts.

### 5.2 Type Compatibility Checks

- [x] Add a type-level check for each adopted "safe leaf type"
- [x] Ensure local usage remains assignable to the vendored contract
- [x] Fail fast if an upstream update invalidates an adopted type
- [x] Standardize the mechanism used for type-level checks so adoption is verified consistently
  - recommended mechanism: dedicated compile-only `.ts` files included in the build or a dedicated `tsconfig` check target
  - avoid runtime test scaffolding for purely type-level assertions

**Done when**: adopted vendored types are guarded against silent drift.

### 5.3 Build And Test Gates

- [x] Run `npm run vendor-types`
- [x] Run `npm run build`
- [x] Run existing test suite after vendoring step
- [x] Verify the gitignore policy works as intended for generated output
- [x] Confirm no package imports vendored files from outside its supported compile boundary
- [x] Add or wire an enforcement mechanism for vendored import boundaries if manual review is insufficient
  - decision: manual review is sufficient for this pass because only two direct vendored import sites were introduced and both compile successfully under the existing package boundaries.

**Done when**: vendoring is part of the normal green path, not a one-off manual step.

## Follow-on Pass: Full Codex Thread Adoption

### F.1 Vendored Codex Graph

- [x] Expand the Codex manifest seed from a single leaf file to the upstream `Thread.ts` graph
- [x] Regenerate the vendored Codex declaration closure from the manifest-only update path
- [x] Keep the vendored output policy unchanged: generated declarations remain gitignored

### F.2 Protocol Replacement

- [x] Replace local `SessionSource` with the vendored Codex type
- [x] Replace local `ThreadStatus` with the vendored Codex type
- [x] Replace local `UserInput` with the vendored Codex type
- [x] Replace local `ThreadItem` with the vendored Codex type
- [x] Replace local `TurnStatus` and `TurnError` with vendored Codex types
- [x] Replace local `Turn` and `Thread` with vendored Codex types
- [x] Expand compile-only compatibility checks to cover the full adopted set

### F.3 Adapter Alignment

- [x] Update historical thread reconstruction to emit vendored `UserInput[]` for user messages
- [x] Update historical file tool items to emit vendored `FileUpdateChange[]`
- [x] Update agent message items to include the vendored `memoryCitation` field
- [x] Update command execution items to include the vendored `source` field
- [x] Populate vendored `commandActions` instead of emitting empty lists for command items
- [x] Stop emitting non-upstream thread active flags and restrict status output to valid vendored values
- [x] Surface `waitingOnUserInput` when a tool-user-input request is pending
- [x] Stop emitting non-upstream `"interrupted"` item statuses for in-flight tool items
- [x] Centralize live and historical tool classification behind one shared core helper
- [x] Preserve assistant `stopReason` and `errorMessage` across the PI backend boundary so historical failed turns can be reconstructed accurately
- [x] Classify turn failures into vendored `CodexErrorInfo` variants instead of always emitting `null`
- [x] Enrich normalized live tool events with backend-provided `toolKind` and update-time `input` so turn-state recovery uses adapter metadata instead of empty fallbacks
- [x] Propagate PI subprocess exits during active turns as backend `error` events so core finalizes failed turns instead of hanging live state
- [x] When prompt startup fails after a turn-level error is already emitted, return the finalized failed turn instead of layering an extra RPC error over the same failure
- [x] Surface fatal backend turn failures as vendored `ThreadStatus.systemError`
- [x] Allow `thread/resume` to recover loaded threads that are stuck in adapter `system_error` state after a fatal backend failure
- [x] Allow `thread/fork` from a loaded `system_error` source thread by rebuilding backend state from persisted session data
- [x] Ensure `thread/resume` and `thread/fork` responses are built after the runtime transitions to ready so returned thread status matches the actual post-call state

### F.4 Validation

- [x] Add resumed-history coverage for inline image/user-input normalization
- [x] Add resumed-history coverage for vendored file-change normalization
- [x] Add resumed-history coverage for failed assistant turns reconstructed from backend message metadata
- [x] Add direct unit coverage for interrupted in-flight tool items under the vendored item union
- [x] Add direct unit coverage for reasoning/text streaming, command streaming, and unknown-tool fallback in `TurnStateMachine`
- [x] Add direct unit coverage for command-action inference and Codex error classification helpers
- [x] Add direct coverage for live tool-update recovery using backend-provided metadata
- [x] Re-run `npm run vendor-types`
- [x] Re-run `npm run lint`
- [x] Re-run `npm run build`
- [x] Re-run `npm test`
- [x] Re-run `npm run test:smoke`

Follow-on implementation notes:

- Upstream Codex `ThreadItem` at the pinned commit now requires `agentMessage.memoryCitation` and `commandExecution.source`; the adapter now emits those fields directly instead of preserving reduced local variants.
- Command-execution items now infer vendored `CommandAction[]` from the emitted shell command string instead of leaving the field empty.
- Thread runtime states such as `starting`, `forking`, and `terminating` remain adapter-owned internally, but the published protocol surface now maps them to the upstream `ThreadStatus` union without custom active-flag values.
- During normal active turn execution, published `ThreadStatus` now uses `activeFlags: []`; only upstream-supported flags such as `waitingOnUserInput` are surfaced externally.
- Historical inline image inputs are normalized to vendored `UserInput` image URLs using `data:` URLs when only base64 payloads are available.
- PI history normalization now preserves assistant `stopReason`/`errorMessage`, allowing `thread/resume` to rebuild failed turns with vendored `TurnError.codexErrorInfo`.
- The adapter-owned `BackendToolUpdateEvent` now carries optional `input` and `toolKind`, and PI populates those fields so live recovery paths do not degrade to empty synthetic tool starts.
- PI subprocess exits now surface through the normalized backend event stream as turn-scoped `error` events, allowing core to complete the active turn deterministically.
- `turn/start` now preserves the graceful failed-turn result when the backend both emits a turn error and rejects the prompt request during startup, while still throwing on unrelated startup failures that never finalized the turn.
- Fatal backend errors now map to published vendored `ThreadStatus.systemError` instead of incorrectly falling back to `idle`.
- `thread/resume` can now tear down a loaded `system_error` runtime and reattach to persisted backend state, which gives the crashed-thread path an explicit recovery route.
- `thread/fork` now accepts a loaded `system_error` source thread and relies on the backend's persisted-session recovery path instead of rejecting the operation outright.
- `thread/resume` and `thread/fork` now build their returned `thread` payloads after transitioning internal runtime state to ready, avoiding stale `"active"` statuses in otherwise successful responses.

## Milestone 6: External Review Of Code Changes

- [x] After code changes land, run `$agent-runner-review` with `generic-gemini` on the implementation diff
- [x] After code changes land, run `$agent-runner-review` with `generic-pi` on the implementation diff
- [x] Ask both reviewers to focus on:
  - contract correctness
  - missing requirements
  - CI/bootstrap risks
  - test gaps
- [x] Triage findings before closing the task

Review notes for the latest follow-on change:

- PI review flagged the double-path startup failure case where an emitted backend error and a rejected `prompt()` could produce both `turn/completed` and an RPC error. Fixed by returning the already-finalized failed turn when the turn is no longer in progress.
- Gemini review first failed because the reviewer could not inspect the diff without an inline patch; reran with the patch text included.
- Gemini then flagged that the new `turn/start` catch path had removed the final fallback `throw`. Fixed by restoring the throw for any startup error that did not actually finalize the turn.
- Gemini review found no blocking issues on the status/recovery slice after the fatal-status changes landed.
- PI review flagged three non-blocking concerns:
  - add a note/comment explaining why resume/fork build thread payloads after `transitionToReady`
  - consider fork behavior from `system_error`
  - keep negative-path coverage in mind for future cleanup
- Accepted fixes from that review:
  - added inline comments for the ready-before-build ordering
  - implemented and tested `thread/fork` from a loaded `system_error` source thread
  - disposed stale `system_error` source subscriptions before forking and documented the shared `fatal` backend-error contract
- Explicit deferrals from that review:
  - no extra negative-path coverage was added beyond the existing non-fatal error regression test and the new system-error resume/fork tests
- Review notes for the vendored `AssistantMessageEvent` follow-on slice:
  - Gemini review found no blocking issues and called out one non-blocking future risk: the extract-mode AST walk only covers the declaration shapes we currently need.
  - PI review flagged four actionable follow-ups:
    - document why same-file dependency resolution uses the leaf identifier while import detection uses the namespace root
    - harden `isAssistantMessageEvent` so `partial` must be a record, not just present
    - add coverage for an additional assistant-event subtype and unknown-event rejection
    - assert topological declaration ordering in the extract-mode fixture
  - Accepted fixes from that review:
    - added inline comments distinguishing `entityNameText()` from `rootEntityNameText()`
    - tightened `isAssistantMessageEvent` to require record-shaped `partial` payloads
    - added `thinking_end`, `aborted`, `partial: null`, and unknown-discriminant guard coverage
    - added extract-output ordering assertions alongside the existing same-file dependency and cycle fixture coverage
- Explicit deferrals from that review:
  - no generalized support was added for more complex future TypeScript shapes such as mapped or conditional types beyond the current vendored PI surface
  - enum value-expression dependency walking remains out of scope for this narrow extract-mode implementation
- Review notes for the CI wiring follow-on slice:
  - Gemini review found no blocking issues and reiterated the documented operational risk that CI now depends on networked vendoring from pinned upstream commits.
  - PI review flagged three actionable follow-ups:
    - make sure the new workflow file ships in the same commit as the checklist/changelog claims
    - clarify that the checklist item is documenting the no-network fallback, not claiming that fallback path was taken
    - avoid a local absolute path when referencing the checked-in workflow file
  - Accepted fixes from that review:
    - the workflow file is included in the milestone commit
    - the fallback checklist line now explicitly says it documents the no-network fallback
    - the workflow reference now uses `.github/workflows/ci.yml` instead of a machine-local absolute path
- Explicit deferrals from that review:
  - the workflow still triggers on all pushes and pull requests; narrowing trigger scope is left as a future CI-cost optimization if needed
- Review notes for the vendored `AssistantMessage` / `Usage` follow-on slice:
  - Gemini review found no blocking issues and noted two non-blocking strictness tradeoffs:
    - `isUsage` now intentionally rejects assistant/usage payloads that omit vendored fields such as `cost`
    - `isAssistantMessageEvent` now intentionally rejects `done`/`error` events when the event reason disagrees with the embedded message `stopReason`
  - PI review flagged three actionable follow-ups:
    - add a direct unit test for the vendored `Usage` fast path in `mapTokenUsage`
    - add more negative coverage for missing required assistant-message fields and invalid content items
    - keep in mind that strict vendored guards will drop streaming events if PI starts emitting partially conformant assistant payloads
  - Accepted fixes from that review:
    - added a direct `mapTokenUsage({ tokens: usage })` unit test
    - added negative assistant-message coverage for missing `api` and invalid content item shapes
    - updated the helper fixture to include real vendored `text`, `thinking`, and `toolCall` content items so the positive guard path exercises more than an empty array
  - Explicit deferrals from that review:
    - no compatibility fallback was added for assistant event payloads that partially resemble vendored `AssistantMessage`; malformed streaming events still log and drop instead of being reinterpreted heuristically
    - optional assistant-content metadata fields such as `textSignature`, `thinkingSignature`, `redacted`, and `thoughtSignature` are preserved when present but not individually validated by the runtime guards

**Done when**: both external reviews have been completed on the implementation, and accepted findings are either fixed or explicitly deferred.

## Milestone 7: Documentation And Follow-Up

### 7.1 Documentation Updates

- [x] Update the recommendation doc if implementation decisions change
- [x] Document the chosen output format and CI policy
- [x] Document how to update pinned upstream commits
- [x] Document known limitations of the first pass
- [x] Once implementation starts, treat this checklist as the active execution document and the recommendation doc as supporting context unless explicitly revised

### 7.2 Follow-Up Backlog

- [ ] Evaluate whether additional Codex leaf types can be adopted safely
- [ ] Reassess full `ThreadItem` migration only after adapter-emitted item shapes are upstream-compatible
- [ ] Reassess whether more PI `unknown` parsing can be typed without overcoupling the adapter

## Acceptance Criteria

- [x] `vendor-types.manifest.json` is checked in
- [x] `scripts/vendor-types.mjs` exists and regenerates vendored output from pinned commits
- [x] `types/codex/` and `types/pi/` policy is implemented consistently with CI
- [x] At least one import in `packages/core/src/protocol.ts` uses a vendored Codex type
- [x] Vendored PI types are consumed only inside `packages/backend-pi`
- [x] `npm run vendor-types` succeeds
- [x] `npm run build` succeeds after vendoring
- [x] Existing tests pass after vendoring
- [x] Gemini and PI have reviewed the implementation after code changes are in
- [x] `README.md` documents the vendoring step

## Suggested Execution Order

1. Lock policy decisions.
2. Complete and absorb external review on the plan/checklist.
3. Build manifest and fetch script.
4. Wire package scripts, ignore rules, and CI/bootstrap behavior.
5. Adopt one safe Codex type.
6. Adopt targeted PI RPC types in `packages/backend-pi`.
7. Run validation, build, and tests.
8. Run external review on the implementation diff.
9. Update docs and capture follow-up work.
