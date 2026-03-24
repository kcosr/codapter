# Upstream Type Vendoring Notes

Status: Working notes

## Purpose

Capture the current recommendation for vendoring upstream Codex and Pi type definitions without coupling that work to the backend-routing refactor.

## Summary

Recommendation:

1. treat vendoring as a separate follow-up topic,
2. do backend routing first,
3. then add narrow vendoring at the stabilized backend boundaries,
4. keep vendored declarations checked into this repo with explicit provenance.

## Why Vendor At All

Vendoring helps with compile-time alignment against pinned upstream contracts.

Primary benefits:

1. catches missing required fields and stale enum/union assumptions when we type payload builders against upstream definitions,
2. makes pinned upstream contract updates visible in normal code review,
3. reduces long-lived drift between codapter's local protocol shapes and upstream Codex or Pi shapes,
4. gives backend-specific parser code a better source of truth than `unknown` plus local handwritten interfaces.

Vendoring does not solve:

1. runtime drift when the installed backend is newer than the pinned snapshot,
2. automatic detection of upstream changes unless we intentionally bump the pinned commit,
3. JSON serialization by itself; we will still construct objects locally unless upstream also provides runtime encoders.

## Current Assessment

Current codapter behavior:

1. Pi JSONL lines are constructed locally and serialized with `JSON.stringify(...) + "\\n"`,
2. app-server NDJSON lines are also serialized locally,
3. Pi process parsing is mostly runtime validation plus handwritten mapping,
4. Codex protocol shapes are still defined locally in `packages/core/src/protocol.ts`.

This means codapter is currently hand-maintaining both:

1. payload construction,
2. payload typing.

Vendoring improves the typing side, not the transport-framing side.

## Recommended Scope

### Codex

Vendor Codex protocol types for the `packages/backend-codex` boundary.

Use them for:

1. request and notification payload typing,
2. request-id mapping payloads,
3. `thread/read` and other proxied response shapes,
4. compile-time compatibility checks where codapter deliberately mirrors upstream Codex protocol.

Do not use vendored Codex protocol types as the core routed contract in `packages/core`.

Reason:

1. `packages/core` should own codapter's backend-neutral routed abstractions,
2. `packages/backend-codex` should own exact Codex protocol fidelity.

### Pi

Pi vendoring is optional and narrower.

If done, keep it inside `packages/backend-pi` only.

Use it for:

1. RPC/event parsing in `pi-process.ts`,
2. targeted assignability checks for parsed upstream message/event shapes.

Do not pull Pi RPC types into `packages/core`.

## Implementation Shape

Preferred approach:

1. checked-in manifest with pinned upstream repo and commit metadata,
2. checked-in generated declaration output,
3. checked-in provenance files for each vendor target,
4. compatibility-check files that assert local adapter types remain assignable where intended.

Preferred layout:

1. `vendor-types.manifest.json`
2. `third_party/types/codex/...`
3. `third_party/types/pi/...`
4. `third_party/types/codex/_provenance.json`
5. `third_party/types/pi/_provenance.json`

Recommended provenance fields:

1. `repo`
2. `commit`
3. `sourcePath` or `entrypoints`
4. `generatedAt`
5. generator version or script identity

## What Not To Reuse From The Old Branch

The old `vendored-types` branch contains useful vendoring mechanics, but it should not be revived wholesale.

Keep the idea:

1. manifest-driven vendoring,
2. generated declarations,
3. compatibility-check files,
4. vendoring-script tests.

Do not reuse the branch as-is because it also:

1. rewrites broad protocol behavior,
2. changes app-server normalization,
3. deletes collab-related code,
4. aliases too much of core protocol typing directly to vendored Codex types.

## Comparison With `../litter`

`../litter` is using a Codex submodule pattern under `shared/third_party/codex`.

That is heavier than what codapter needs.

For codapter, the current recommendation is:

1. do not use a Codex source submodule just for types,
2. do not carry local patch management like `litter` does,
3. prefer vendored declarations plus provenance instead.

## Sequencing

Recommended order:

1. finish backend routing and the new backend boundary design,
2. implement the new routed backend contract in code,
3. add Codex vendoring now that `packages/backend-codex` is implemented,
4. add Pi vendoring later only if backend-pi parsing work is active.

Default policy:

1. separate topic from backend routing,
2. backend work first,
3. vendoring second.

Exception:

1. if Codex implementation work becomes blocked by unclear local protocol typings at the start of Codex backend implementation, do a narrow Codex-only vendoring step at that point.

## Open Decisions For The Follow-Up Topic

1. exact output root for vendored declarations,
2. whether to use one shared vendoring package or plain checked-in declaration folders,
3. whether compatibility checks live beside consumers or in one central validation module,
4. whether to add any runtime schema validation for Codex beyond static typing,
5. how aggressively to vendor Pi types versus keeping existing runtime guards.
