# Agent Onboarding (Codapter)

This file is a lightweight, internal onboarding note for agents working in this repo. It is not part of the product output.

## Start Here

- Read `README.md` for the project goal, CLI usage, and API basics.
- Core code lives in `packages/`, tests alongside each package in `test/` subdirectories.
- Smoke tests in `test/smoke/` require a live Pi backend (`PI_SMOKE_TEST=1`).

## Conventions

- TypeScript, ESM modules, NodeNext resolution (see `tsconfig.base.json`).
- Monorepo with npm workspaces: `packages/core`, `packages/cli`, `packages/backend-pi`.
- Formatting and linting via Biome (`biome.json`); pre-commit hook runs `lint-staged`.
- Keep edits ASCII-only unless a file already uses Unicode.
- Prefer small, focused changes; match existing file layout and naming.

## Testing Requirements

- Run `npm install` to install dependencies.
- Run `npm test` for all functional changes.
- Run `npm run build` if you touch the CLI, exports, or public API signatures.
- Run `npm run lint` to check formatting and lint rules.
- Run `npm run check` to run build + lint + test together.
- If you cannot run tests, call it out explicitly in your response.

## GUI Debugging

- Checked-in launcher scripts live at `scripts/pi.sh` and `scripts/codex.sh`.
- `scripts/pi.sh` launches Codex Desktop against `dist/codapter.mjs`, enables collab, preserves the JSONL debug log, and writes stdio traffic to `/tmp/codapter-pi-stdio.log`.
- `scripts/codex.sh` launches the native Codex backend through the same stdio tap and writes traffic to `/tmp/codapter-codex-stdio.log`.
- Both launchers enable Electron remote debugging on port `9222` for Chrome DevTools MCP inspection.
- Before Pi GUI repros, clear persisted thread state with `rm -f ~/.local/share/codapter/threads.json` when old threads are polluting the sidebar.
- When reproducing Pi sub-agent flows in the GUI, switch the model picker to `Claude Opus 4.6` before sending the prompt. `Claude Haiku 3.5` has produced misleading failures in this setup.
- Use the Chrome DevTools MCP against the Electron page to inspect the sidebar, composer, and sub-agent thread UI while the app is running.
- Compare `/tmp/codapter-pi-stdio.log` against `/tmp/codapter-codex-stdio.log` first when native Codex and Pi diverge. Use `/tmp/codapter-pi.jsonl` for app-server level debug events from Codapter.
- Stop the GUI between backend switches so the next run binds cleanly to the remote debugging port and starts with fresh logs.

## Changelog

Location: `CHANGELOG.md` (root)

### Format

Use these sections under `## [Unreleased]`:
- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- New entries ALWAYS go under `## [Unreleased]`
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.0.1]`)
- Use inline PR links: `([#123](<pr-url>))`

### Attribution

- Internal changes: `Fixed foo bar ([#123](<pr-url>))`
- External contributions: `Added feature X ([#456](<pr-url>) by [@user](https://github.com/user))`

## Releasing

### During Development

When preparing PRs for main, open the PR first to get the PR number, then update `CHANGELOG.md` under `## [Unreleased]` with that PR number and push a follow-up commit.

### When Ready to Release

1. Checkout and update main:
   ```bash
   git checkout main && git pull
   ```
2. Verify `## [Unreleased]` in `CHANGELOG.md` includes all changes.
3. Run the release script:
   ```bash
   node scripts/release.mjs patch   # 0.0.1 -> 0.0.2
   node scripts/release.mjs minor   # 0.0.2 -> 0.1.0
   node scripts/release.mjs major   # 0.1.0 -> 1.0.0
   ```

Notes:
- Requires the `gh` CLI and an authenticated GitHub session.
- Script expects a clean working tree, bumps version in `package.json` and `package-lock.json`, updates `CHANGELOG.md`, tags `vX.Y.Z`, pushes, and creates a prerelease.
