# Azure Container Apps Deployment (v1)

This runbook covers v1 deployment on Azure using:

- Docker image in Azure Container Registry (ACR)
- Azure Container Apps (ACA)
- Azure Files mounted as persistent cache
- Default ACA HTTPS domain (`*.azurecontainerapps.io`)

Custom domain and Azure managed certificate are deferred to v2.

## Runtime Profile (v1)

- `MCP_PROFILE=semantic-gemini`
- `RAG_PROVIDER=gemini`
- `RAG_FALLBACK=lexical`
- `MCP_DATA_HYDRATION_MODE=eager`

## First-Time Bootstrap

Use `infra/main.bicep` to create baseline resources in your target resource group:

- Log Analytics Workspace
- ACR
- Storage Account + Azure Files share (`mcp-cache`)
- ACA environment
- ACA app

v1 keeps ingress target port `80` end-to-end (bootstrap and release deployment).

If using a shared resource group, keep resource tags in `infra/params/prod.bicepparam` and use `cleanupGroup` for safe cleanup later.

## Release Deploy Flow

On release, workflow sequence is:

1. `release.yml` publishes npm package
2. `release.yml` calls reusable `deploy-aca.yml`
3. `deploy-aca.yml` builds and pushes image to ACR
4. `deploy-aca.yml` configures ACA registry auth using system-assigned identity
5. Deploy warm-up revision with `minReplicas=1`, `maxReplicas=1`
6. Wait for warm-up revision to become ready
7. Set steady-state scale to `minReplicas=1`, `maxReplicas=1` (always one warm replica; no scale-to-zero cold starts)
8. Route traffic to newest ready revision
9. Deactivate previous revisions
10. Remove old cache version directories from Azure Files

## Version-Scoped Cache Contract

Cache paths are release-version scoped only.

For a release version `<version>`, the container uses:

- `/mnt/mcp-cache/<version>/data`
- `/mnt/mcp-cache/<version>/tmp`
- `/mnt/mcp-cache/<version>/rag/cache`
- `/mnt/mcp-cache/<version>/rag/models`

Temporary directories (`TMPDIR`, `TMP`, `TEMP`) are pinned to `/mnt/mcp-cache/<version>/tmp` so hydration staging and final cache paths are on the same filesystem.

Old versions are deleted only after traffic is moved off old revisions.

## Endpoint

v1 public endpoint:

- `https://<app>.<hash>.<region>.azurecontainerapps.io/mcp`

TLS is provided by Azure on the default ACA domain.

## Request Logs

Deploys set `MCP_LOG_FORMAT=text`, `MCP_LOG_CLIENT_IP=hash`, `MCP_LOG_TRUST_PROXY=true`, and `MCP_REQUEST_LOG_DIR=/mnt/mcp-cache/request-logs`. Each `tools/call` and `resources/read` is logged twice:

- **Console (container output):** one line with the tool (or `read <uri>`), `ok`/`error`/`undelivered`, duration, response size, and the requester: `client_id` (salted HMAC of the client IP) and `user_agent`. No raw IP, arguments, or response bodies. Lines are written after the response is handed to the transport; a failed send is logged as `undelivered` with `send_error`.

  ```text
  2026-10-28T02:52:18.668Z INFO  [mcp] search ok 374ms 1804 chars transport=http client_id=a1b2c3d4e5f60718 user_agent=example-chatbot/1.0 request_id=1
  ```

  View it with `az containerapp logs show --name <app> --resource-group <rg> --follow`.
- **Detailed file:** the same fields plus `arguments` and the full `response`, as JSON lines in `requests-<YYYY-MM-DD>-<host>.jsonl` (UTC day, one file per replica).

Files older than `MCP_REQUEST_LOG_RETENTION_DAYS` (default 30) are deleted when a new day's file opens. `request-logs/` is not a version directory, so cache cleanup (`cleanup-azure-cache.yml`) leaves it alone. File logging never fails a request:

- Write failures are reported once per day as `[request-log] file_write_failed`, including failures of a previous day's file that is still flushing.
- If the share stalls, at most 8 MiB of entries are queued in memory in total, including a previous day's file that is still flushing. Further entries are dropped and reported once as `file_backpressure_dropping`, then `file_backpressure_resumed dropped_entries=<n>` on the next entry that fits. A single entry larger than 8 MiB is dropped and reported as `file_entry_too_large` with its size (set `MCP_LOG_MAX_FIELD_CHARS` to keep large responses as truncated previews instead).

Responses are stored whole by default; set `MCP_LOG_MAX_FIELD_CHARS` to cap `arguments`/`response` as `{truncated, original_chars, preview}`. `uri`, `tool`, `request_id`, and error messages are always capped at 1024 chars.

Reading the detailed logs:

```bash
az storage file list --account-name <storage-account> --share-name mcp-cache --path request-logs -o table
az storage file download --account-name <storage-account> --share-name mcp-cache \
  --path request-logs/requests-2026-10-28-<replica>.jsonl --dest ./requests.jsonl
jq -c 'select(.tool == "search") | {ts, client_id, query: .arguments.query, is_error}' requests.jsonl
```

Requester identity (`MCP_LOG_CLIENT_IP`; the default outside these deploys is `off`):

- `hash`: `client_id`, a salted HMAC of the client IP. Groups requests per caller without storing the IP. The salt comes from the `MCP_LOG_IP_SALT` GitHub secret: `deploy-aca.yml` stores it as the ACA secret `log-ip-salt` and sets `MCP_LOG_IP_SALT=secretref:log-ip-salt`, so ids stay stable across cold starts, revisions, and replicas. Without that secret the deploy warns and a per-process salt is used (ids change on every restart). The salt is never written to the share, so reading the logs does not reveal it.
- `full`: raw `client_ip`.
- `off`: no IP-derived field.

Privacy: `client_id` is pseudonymous (linkable across requests) and `user_agent` is caller-supplied, so console output still counts as personal data under GDPR-style rules. The detailed files additionally hold full arguments and responses, which can include whatever users typed. Restrict who can read container logs and the `mcp-cache` share, and keep `MCP_REQUEST_LOG_RETENTION_DAYS` as short as review needs allow.

To create the salt: `openssl rand -hex 32`, then add it as repository or `azure-production` environment secret `MCP_LOG_IP_SALT`. Rotating it starts a new id space.

On ACA the socket peer is the ingress proxy, so `MCP_LOG_TRUST_PROXY=true` uses the right-most `X-Forwarded-For` entry (appended by ACA ingress). Leave it unset when the server is reachable directly, since clients can then forge the header. Clients that call through a hosted agent (e.g. a chatbot platform) appear as that platform's egress IP, so all of its users share one `client_id`; use `user_agent` to tell platforms apart.
