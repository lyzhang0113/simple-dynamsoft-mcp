# TODO

## Purpose

This file tracks open release/data automation work.

Current state:
- `update-data-lock.yml` fast-forwards submodules, updates `data/metadata/data-manifest.json`, runs tests, and opens a PR.
- Version bumping and npm publishing are still manual.
- DBR server/desktop refactor and DBR docs integration are complete.
- Release orchestration decision: custom workflows only.
- Patch bump scope decision: automated data-refresh PRs only.
- Human-driven minor version bumps (e.g., `5.0.2 -> 5.1.0`) should publish a release.
- Human-driven major version bumps (e.g., `5.x.y -> 6.0.0`) should publish a release.
- Prebuilt index default decision: `RAG_PREBUILT_INDEX_AUTO_DOWNLOAD=true`.
- Prebuilt index profile decision: single model profile for now (`Xenova/all-MiniLM-L6-v2`).

## Workstream 1: Data Refresh PR Automation

Goal: turn data-refresh PRs into automatic patch release candidates.

- [ ] Change `update-data-lock.yml` schedule from weekly to daily.
- [ ] In the workflow, detect whether data changed (`.gitmodules`, submodule SHAs, `data/metadata/data-manifest.json`).
- [ ] When data changed, auto-bump patch version in `package.json` and `package-lock.json`.
- [ ] Ensure patch bumps are monotonic from `main` (e.g., `5.0.0 -> 5.0.1 -> 5.0.2`).
- [ ] Skip version bump if no data change is detected.
- [ ] Add clear PR title/label convention for auto data-release PRs.
- [ ] Keep `npm run data:verify-lock` and `npm test` as required checks in the PR workflow.

## Workstream 2: Release Pipeline (GitHub Release + npm Publish)

Goal: publish releases automatically when version changes land on `main`.

- [ ] Add a release workflow triggered by version changes (or semver tags) on `main`.
- [ ] Ensure release workflow runs for:
- [ ] automated patch bumps from data-refresh PRs
- [ ] manual minor bumps committed by maintainers
- [ ] manual major bumps committed by maintainers
- [ ] Require CI-green status before release steps.
- [ ] Build package artifact with `npm pack` and attach `.tgz` to the GitHub Release.
- [ ] Publish package to npm from the release workflow.
- [ ] Generate release notes including data/source changes.
- [ ] Add workflow concurrency guard to prevent parallel releases.

## Workstream 3: Prebuilt Local RAG Index Distribution

Goal: avoid long local index build time for `RAG_PROVIDER=local`.

- [ ] Add a GPU runner job to prebuild local embedding index for release.
- [ ] Attach prebuilt index artifact(s) to GitHub Release.
- [ ] Define artifact naming convention including compatibility keys:
- [ ] package version
- [ ] RAG model id
- [ ] index signature/cache key
- [ ] Add runtime logic: when `RAG_PROVIDER=local`, try downloading matching prebuilt index before local build.
- [ ] Validate downloaded index signature before use.
- [ ] Fallback to existing local-build flow when prebuilt index is missing/incompatible/download fails.
- [ ] Add env controls:
- [ ] `RAG_PREBUILT_INDEX_AUTO_DOWNLOAD` (default `true`)
- [ ] `RAG_PREBUILT_INDEX_URL`
- [ ] `RAG_PREBUILT_INDEX_TIMEOUT_MS`
- [ ] Document this behavior in `README.md`, `AGENTS.md`, and `.env.example`.

## Post-Release Validation

- [ ] Add smoke test for npm-like install/run (`npm pack` then execute from tarball context).
- [ ] Validate `npx` first-run bootstrap path on Windows and Linux/macOS.
- [ ] Validate prebuilt-index download path and fallback behavior.

## Key Points For Future Agents

- Do not manually edit `data/metadata/data-manifest.json`; regenerate via `npm run data:lock`.
- Always run `npm run data:verify-lock` and `npm test` for release/data changes.
- Keep npm package payload minimal (`data/metadata` + runtime code), not full submodule contents.
- Preserve dual-mode data behavior:
- dev/local clone uses submodules
- npm/npx mode downloads pinned archives into cache
- Avoid direct edits inside submodule trees under `data/samples/*` and `data/documentation/*` unless explicitly requested.
