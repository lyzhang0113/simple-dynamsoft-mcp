# AGENTS.md

## Purpose
This repository hosts a stdio-only MCP server for Dynamsoft SDKs. It provides tool-based discovery and lazy resource reads so agents do not load all resources by default.

Supported products:
- DBR (Barcode Reader): mobile, web, server/desktop (python, dotnet, java, cpp, nodejs)
- DWT (Dynamic Web TWAIN): web
- DDV (Document Viewer): web

## Core Design
- Minimal tool surface: `get_index`, `search`, `list_samples`, `resolve_sample`, `resolve_version`, `get_quickstart`, `generate_project`.
- Resources are discovered via tools and read on demand with `resources/read`.
- `resources/list` exposes only pinned resources to keep context small.
- Resource indexing logic is split under `src/resource-index/` with `src/resource-index.js` as the composition layer.
- Transport is stdio only. Do not add an HTTP wrapper in this repo.

## Version Policy
- Only the latest major version is served.
- DBR legacy docs are available only for v9 and v10; versions prior to v9 are refused.
- DWT archived docs are available for v16.1.1+ (specific versions listed in code).
- DDV has no legacy archive links in this server.

## Key Files and Data
- `src/index.js`: server implementation, tools, resource routing, version policy.
- `src/resource-index.js`: resource index composition and exports used by the server and RAG layer.
- `src/resource-index/*`: modularized resource-index implementation (`config`, `paths`, docs/sample discovery, URI parsing, version policy, builders).
- `src/submodule-sync.js`: optional startup sync for submodules (`DATA_SYNC_ON_START`).
- `scripts/sync-submodules.mjs`: script entry used by `npm run data:sync`.
- `data/metadata/dynamsoft_sdks.json`: product metadata and latest version info.
- `data/samples/*`: sample repositories (git submodules).
- `data/documentation/web-twain-docs`: DWT docs repository (git submodule).
- `data/documentation/document-viewer-docs`: DDV docs repository (git submodule).

Avoid modifying `data/` submodule content unless explicitly requested.

## Resource URI Shape
- Docs: `doc://{product}/{edition}/{platform}/{version}/{slug}`
- Samples: `sample://{product}/{edition}/{platform}/{version}/...`

## Tests and Commands
- Run server: `npm start`
- Run tests: `npm test`
- Init submodules: `npm run data:bootstrap`
- Sync submodules: `npm run data:sync`
- Submodule status: `npm run data:status`
- Optional startup sync env: `DATA_SYNC_ON_START=true`, `DATA_SYNC_TIMEOUT_MS=30000`

## Contribution Notes
- Prefer adding new content as resources (search + read) instead of new tools.
- Keep edits ASCII-only unless the file already uses Unicode.
- Keep code changes focused; avoid reformatting unrelated sections.
