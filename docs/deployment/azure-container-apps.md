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

The server writes JSON lines to stderr, which ACA ships to the Log Analytics workspace. Every `tools/call` and `resources/read` produces one entry with `component="mcp"`, `event="tool_call"` or `"resource_read"`, and:

- `tool` + `arguments` (tool calls) or `uri` (resource reads)
- `response` (the result sent to the client) or `error` (JSON-RPC errors), plus `is_error` and `duration_ms`
- `transport`, `user_agent`, and `client_id` (HMAC of the client IP)

`arguments` and `response` are truncated to `MCP_LOG_MAX_FIELD_CHARS` (default 8000 JSON chars) as `{truncated, original_chars, preview}`, keeping each line below the container runtime's 16 KB line split.

Client IP handling (`MCP_LOG_CLIENT_IP`):

- `hash` (default): `client_id`, a salted hash. Groups requests per caller without storing the IP. Set `MCP_LOG_IP_SALT` (as an ACA secret) for ids that survive restarts; otherwise a per-process salt is used and ids change on each cold start (`minReplicas=0`).
- `full`: raw `client_ip`. Personal data; check retention/privacy requirements first.
- `off`: no IP-derived field.

The IP is the right-most `X-Forwarded-For` entry (appended by ACA ingress), falling back to the socket address. Clients that call through a hosted agent (e.g. a chatbot platform) appear as that platform's egress IP, not the end user's.

Example query (column is `Log_s` in `ContainerAppConsoleLogs_CL`; `Log` in the resource-specific `ContainerAppConsoleLogs` table):

```kusto
ContainerAppConsoleLogs_CL
| extend e = parse_json(Log_s)
| where e.component == "mcp"
| project TimeGenerated, event = tostring(e.event), tool = tostring(e.tool),
          arguments = e.arguments, is_error = tobool(e.is_error),
          duration_ms = toint(e.duration_ms), client_id = tostring(e.client_id), response = e.response
| order by TimeGenerated desc
```
