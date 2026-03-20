# Vendor Types Recommendation

Date: 2026-03-19

## Scope

Review the proposed "Vendor Codex and Pi type definitions" request and recommend what should actually be implemented in this repository.

## Original Request Summary

The upstream request proposed:

- a checked-in `vendor-types.manifest.json` with pinned source repos and commits,
- a `scripts/vendor-types.mjs` fetch script,
- gitignored `types/codex/` and `types/pi/` output directories,
- at least one vendored import in `packages/core/src/protocol.ts`,
- and a green `npm run build` after the migration.

## Current Baseline

- `npm run build` passes in the current repo state.
- Codex protocol types are currently maintained locally in [`packages/core/src/protocol.ts`](/home/kevin/worktrees/codapter/packages/core/src/protocol.ts).
- Backend event and session contracts are adapter-owned in [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts).
- PI RPC payloads are parsed from `unknown` in [`packages/backend-pi/src/pi-process.ts`](/home/kevin/worktrees/codapter/packages/backend-pi/src/pi-process.ts).

## Findings

### 1. The requested `types/` layout will not compile as written

- The repo uses ESM via [`package.json`](/home/kevin/worktrees/codapter/package.json:5).
- `packages/core` constrains sources to [`rootDir: "./src"`](/home/kevin/worktrees/codapter/packages/core/tsconfig.json:4).
- Importing repo-root vendored `.ts` files from `packages/core/src` will fail with `TS6059` because those files sit outside `rootDir`.
- Importing raw generated `.d.ts` files also requires rewriting relative imports to use explicit `.js` extensions under `NodeNext` + ESM.

### 2. The proposed manifest file lists are too small

- The Codex files in the request are not standalone.
- At `openai/codex` HEAD `6b8175c7346d25a13479bc044819ca406ea1c3ae`, `Thread.ts` imports `GitInfo`, `SessionSource`, `ThreadStatus`, and `Turn`.
- `Turn.ts` imports `ThreadItem`, `TurnError`, and `TurnStatus`.
- `ThreadItem.ts` imports a wider schema set including command status, file change status, user input, reasoning effort, and other transitive types.
- At `badlogic/pi-mono` HEAD `970774ec3ce2756f45b892ec1208bc73ba6f612d`, `rpc-types.ts` imports internal package types plus published packages, so copying only that one file is also insufficient.

## 3. Replacing local Codex thread types wholesale will break the adapter

- The local types in [`packages/core/src/protocol.ts`](/home/kevin/worktrees/codapter/packages/core/src/protocol.ts:357) are reduced shapes, not exact upstream mirrors.
- The adapter currently constructs simplified `ThreadItem` values in [`packages/core/src/turn-state.ts`](/home/kevin/worktrees/codapter/packages/core/src/turn-state.ts) and [`packages/core/src/app-server.ts`](/home/kevin/worktrees/codapter/packages/core/src/app-server.ts).
- Upstream Codex `ThreadItem` now includes additional required structure for variants such as `agentMessage`, `commandExecution`, and `fileChange`.
- A direct swap to vendored `ThreadItem`, `Turn`, or `Thread` would require follow-up implementation work beyond the request's stated acceptance criteria.

## 4. PI vendoring should stay in the PI backend package

- [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts) defines the adapter's normalized cross-backend contract.
- Pulling PI RPC types into `packages/core` would hard-couple the core package to the PI backend.
- The actual PI parsing surface is in [`packages/backend-pi/src/pi-process.ts`](/home/kevin/worktrees/codapter/packages/backend-pi/src/pi-process.ts:128) and [`packages/backend-pi/src/pi-process.ts`](/home/kevin/worktrees/codapter/packages/backend-pi/src/pi-process.ts:656).
- Vendored PI RPC types should therefore be consumed in `packages/backend-pi`, not `packages/core`.

## 5. Vendoring Codex types does not automatically remove `unknown` handling in `turn-state.ts`

- The `unknown` values in [`packages/core/src/turn-state.ts`](/home/kevin/worktrees/codapter/packages/core/src/turn-state.ts) come from the adapter-owned backend event contract in [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts:73), [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts:80), [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts:88), and [`packages/core/src/backend.ts`](/home/kevin/worktrees/codapter/packages/core/src/backend.ts:105).
- Those casts will only shrink if backend event payloads become more strongly typed, especially inside the PI backend adapter.

## Recommendation

Implement this in two tracks.

### Track A: Codex protocol vendoring

- Add `vendor-types.manifest.json`.
- Add `scripts/vendor-types.mjs`.
- Add `.gitignore` entries for generated vendor output.
- Update setup docs to require the vendoring step before build.
- Vendor the transitive closure needed for the selected Codex types, not just the three example files.
- Generate declaration artifacts for consumption in this repo rather than importing raw upstream `.ts` modules directly.
- Rewrite internal relative imports in generated declarations to explicit `.js` paths so they type-check under `NodeNext` + ESM.
- Pin the exact upstream commit in the manifest and treat manifest changes as the only supported update path.

### Track B: PI RPC vendoring

- Vendor PI RPC types for use inside `packages/backend-pi`.
- Keep PI-specific upstream types out of `packages/core`.
- Use the vendored PI RPC contract to replace hand-rolled `unknown` parsing in `pi-process.ts` where practical.
- Ensure the manifest and script support multiple vendor targets and per-target output roots from the start.

## Recommended First Pass

The first implementation should stay narrow enough to meet the acceptance criteria without destabilizing the adapter:

### Track A first pass

1. Add the vendoring manifest and fetch script.
2. Add `.gitignore` entries for generated vendor output.
3. Add `npm run vendor-types`.
4. Update `README.md` setup instructions to include `npm run vendor-types` before build.
5. Import at least one safe vendored Codex type into `protocol.ts`.

### Track B first pass

1. Use vendored PI types only inside `packages/backend-pi/src/pi-process.ts`.
2. Keep local adapter-owned `BackendEvent` and `IBackend` contracts in place.

## Types Safe To Vendor First

Good initial candidates are:

- `GitInfo`
- `SessionSource`
- `ThreadStatus`
- possibly `TurnError` after exact shape comparison

Even these "safe" types need explicit compatibility checks before adoption. They should only be swapped after verifying the local reduced shape still matches the vendored upstream contract.

Do not replace these in the first pass:

- `ThreadItem`
- `Turn`
- `Thread`

Those should only move after the adapter emits upstream-compatible item shapes.

## Required Design Decisions Before Implementation

One of these approaches must be chosen explicitly:

1. Generate `.d.ts` vendor output at repo root and rewrite imports for ESM compatibility.
2. Create a dedicated vendored-types TS project/package and reference it from workspace packages.
3. Widen package `rootDir` settings and accept vendored source files as part of compilation.

Trade-offs:

- Option 1 has the lowest runtime/build coupling and preserves current package boundaries, but it adds script-maintenance cost.
- Option 2 has the cleanest module boundary, but it is heavier operationally because it adds a new workspace package and build edge.
- Option 3 is the smallest change short-term, but it weakens build isolation and expands the compile surface of existing packages.

Option 1 is the lowest-risk path for a type-contract-only goal because it preserves the current package graph while avoiding raw vendored source imports in `packages/core`.

## First-Pass Implementation Note

The implemented first pass should keep Option 1 for copied Codex declarations and allow one narrow PI exception:

- copy full upstream declarations only when the selected file graph stays small and local-import closure is sufficient,
- otherwise extract standalone exported PI declarations into generated `.d.ts` files when that avoids pulling unpublished `pi-mono` package imports into this repo,
- keep the manifest as the pinned source of truth for both copied and extracted declarations.

This still preserves the intended first-pass boundaries:

- `packages/core` adopts only a safe Codex leaf type,
- `packages/backend-pi` consumes only targeted PI declarations,
- and the adapter-owned backend contract remains unchanged.

## Versioning And Update Policy

- `vendor-types.manifest.json` should be the single source of truth for pinned upstream commits and copied entrypoints.
- Updating vendored types should require an explicit manifest change and a rerun of `npm run vendor-types`.
- The script should fail loudly if an expected upstream file disappears or moves.
- The repo should not attempt to auto-follow upstream HEAD during normal builds.

## CI And Commit Policy

- If `types/` remains gitignored, CI must run `npm run vendor-types` before `npm run build` and before any tests that type-check vendored imports.
- If CI is not allowed to fetch from the network, generated vendor output must be committed instead of ignored.
- The current request implies gitignored output, so CI changes are required if that policy is kept.

## License And Attribution

- Before vendoring files from `openai/codex` and `badlogic/pi-mono`, confirm the applicable licenses and whether attribution notices must be preserved in generated output or adjacent documentation.
- The vendoring script should avoid stripping header comments unless that is confirmed to be permissible.

## Validation And Test Coverage

Build success alone is not sufficient. The implementation should also require:

1. A smoke test for `npm run vendor-types` that verifies expected output roots and representative files exist.
2. A type-level compatibility check for any "safe leaf type" adopted from vendored output.
3. CI wiring that ensures fresh clones run the vendor step before build/test.
4. Existing test suite execution after the vendoring step, not just `npm run build`.

## Recommended Approval Scope

Approve the request only with these adjustments:

- Codex vendoring uses transitive closure, not the three-file sample only.
- PI vendoring is consumed in `packages/backend-pi`, not `packages/core`.
- The first pass adopts safe leaf types rather than replacing full thread/turn/item unions.
- The vendoring script produces output that is valid under this repo's `NodeNext` + ESM build rules.
- The manifest defines explicit pinned commits and the repo defines whether CI fetches vendored output or stores it in git.
- Acceptance criteria include vendoring-script validation and post-vendor test/build execution, not only `npm run build`.

Without those adjustments, the request is underspecified and likely to fail the stated `npm run build` acceptance criterion.
