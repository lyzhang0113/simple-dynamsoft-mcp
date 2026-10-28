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
7. Set steady-state scale to `minReplicas=0`, `maxReplicas=1`
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

Each `tools/call` and `resources/read` is logged twice:

- **Console (stderr -> Log Analytics):** a one-line summary with `component="mcp"`, `event="tool_call"` or `"resource_read"`, `transport`, `request_id`, `tool` or `uri`, `is_error`, `error` (JSON-RPC errors), `duration_ms`, and `response_chars`. No arguments, response bodies, or caller identity.
- **Detailed file (`MCP_REQUEST_LOG_DIR`):** the same fields plus `arguments`, the full `response`, `user_agent`, and the opt-in client identity field. Deploys set `MCP_REQUEST_LOG_DIR=/mnt/mcp-cache/request-logs` on the Azure Files cache share.

Detailed files are `requests-<YYYY-MM-DD>-<host>.jsonl` (UTC day, one JSON object per line, one file per replica). Files older than `MCP_REQUEST_LOG_RETENTION_DAYS` (default 30) are deleted when a new day's file opens. `request-logs/` is not a version directory, so cache cleanup (`cleanup-azure-cache.yml`) leaves it alone. Write failures are reported on stderr as `component="request-log"`, `event="file_write_failed"` and never fail a request.

Responses are stored whole by default; set `MCP_LOG_MAX_FIELD_CHARS` to cap `arguments`/`response` as `{truncated, original_chars, preview}`. `uri`, `tool`, `request_id`, and error messages are always capped at 1024 chars.

Reading the detailed logs:

```bash
az storage file list --account-name <storage-account> --share-name mcp-cache --path request-logs -o table
az storage file download --account-name <storage-account> --share-name mcp-cache \
  --path request-logs/requests-2026-10-28-<replica>.jsonl --dest ./requests.jsonl
jq -c 'select(.tool == "search") | {ts, query: .arguments.query, is_error}' requests.jsonl
```

Client IP handling (`MCP_LOG_CLIENT_IP`, personal data, so opt-in; written to the detailed file only):

- `off` (default): no IP-derived field.
- `hash`: `client_id`, a salted HMAC. Groups requests per caller without storing the IP. Set `MCP_LOG_IP_SALT` (as an ACA secret) for ids that survive restarts; otherwise a per-process salt is used and ids change on each cold start (`minReplicas=0`).
- `full`: raw `client_ip`. Check retention/privacy requirements first.

On ACA the socket peer is the ingress proxy, so also set `MCP_LOG_TRUST_PROXY=true` to use the right-most `X-Forwarded-For` entry (appended by ACA ingress). Leave it unset when the server is reachable directly, since clients can then forge the header. Clients that call through a hosted agent (e.g. a chatbot platform) appear as that platform's egress IP, not the end user's.

Console summary query (column is `Log_s` in `ContainerAppConsoleLogs_CL`; `Log` in the resource-specific `ContainerAppConsoleLogs` table):

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.component == "mcp"
| project TimeGenerated, event = tostring(e.event), tool = tostring(e.tool), uri = tostring(e.uri),
          is_error = tobool(e.is_error), duration_ms = toint(e.duration_ms), response_chars = toint(e.response_chars)
| order by TimeGenerated desc
```
