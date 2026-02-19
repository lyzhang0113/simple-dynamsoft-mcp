# TODO

## Purpose

This file tracks deferred release automation work.
Current state:
- `update-data-lock.yml` updates submodules and `data/metadata/data-manifest.json` on a schedule and opens PRs.
- Release version bump and npm publish are still manual.

## Release Automation Roadmap

### 1. Choose release orchestration tool

- [ ] Decide between `changesets` and `release-please`.
- [ ] Document decision criteria in this file after selection.
- [ ] Keep setup minimal and avoid introducing multiple overlapping release tools.

Preferred direction with current repo structure:
- `changesets` is usually easier when commits include mixed code + data updates and you want explicit semver control.

### 2. Define version bump policy

- [ ] Formalize semver rules for this project.
- [ ] Mark data-only refreshes (`submodule pointers` + `data-manifest`) as patch releases.
- [ ] Mark feature/tool behavior changes as minor releases.
- [ ] Mark breaking MCP behavior changes as major releases.

### 3. Implement release workflow

- [ ] Add workflow triggered on merge to `main` (or manual dispatch) that creates/releases version.
- [ ] Ensure workflow runs after CI and only on clean green checks.
- [ ] Ensure workflow updates `package.json` and lockfile consistently.
- [ ] Ensure workflow creates git tag and GitHub release notes.
- [ ] Ensure workflow publishes to npm with provenance if supported.

### 4. Guardrails and safety

- [ ] Require `npm test` pass before versioning/publish.
- [ ] Require `npm run data:verify-lock` pass before versioning/publish.
- [ ] Block publish when working tree is dirty in workflow steps.
- [ ] Add concurrency control for release workflow to prevent parallel publishes.
- [ ] Add branch protection checks so release workflow is not bypassed.

### 5. Changelog strategy

- [ ] Define changelog sections: `Data Updates`, `Features`, `Fixes`, `Breaking`.
- [ ] Ensure data-lock PR merges are summarized in release notes.
- [ ] Ensure user-facing notes mention any changed sample/doc sources.

### 6. Post-release validation

- [ ] Add smoke test that runs package in npm-like mode (`npm pack` + run from tarball context).
- [ ] Validate runtime bootstrap path for `npx` users after publish.
- [ ] Validate first-run cache download path on Windows and Linux/macOS.

## Key Points For Future Agents

- Do not treat `data/metadata/data-manifest.json` as manual source-of-truth.
- Always regenerate manifest from real submodule heads via `npm run data:lock`.
- Always verify consistency via `npm run data:verify-lock`.
- Keep `npx` support in mind: release artifacts should include metadata and runtime bootstrap logic, not full submodule payloads.
- Preserve dual-mode behavior for data access in all release changes.
- Dev mode should use local `data/` submodules when present.
- npm/npx mode should auto-download pinned archives into cache.
- Avoid modifying submodule content directly under `data/samples/*` or `data/documentation/*` unless explicitly intended.
- Prefer small, reviewable release-automation PRs over one large migration.

## Handoff Checklist (When Starting Release Automation Work)

- [ ] Read `AGENTS.md` and `README.md` release/data sections first.
- [ ] Run `npm run data:bootstrap`.
- [ ] Run `npm run data:sync`.
- [ ] Run `npm run data:lock`.
- [ ] Run `npm run data:verify-lock`.
- [ ] Run `npm test`.
- [ ] Confirm `npm pack --dry-run` does not include full submodule data.
