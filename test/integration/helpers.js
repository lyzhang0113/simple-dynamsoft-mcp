import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const projectRoot = resolve(__dirname, "..", "..");
const serverEntry = join(projectRoot, "src", "index.js");
const dataRoot = join(projectRoot, "data");

const RUN_GEMINI_PROVIDER_TESTS =
  process.env.RUN_GEMINI_PROVIDER_TESTS === "true" &&
  Boolean(process.env.GEMINI_API_KEY);

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function nodeCommand() {
  return process.execPath;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function makeClient(name) {
  return new Client({ name, version: "1.0.0" });
}

function sanitizeEnv(rawEnv) {
  const sanitized = {};
  for (const [key, value] of Object.entries(rawEnv || {})) {
    if (value === undefined || value === null) continue;
    sanitized[key] = String(value);
  }
  return sanitized;
}

function resolveServerEnv({ provider, fallback = "none", extra = {} }) {
  const base = {
    MCP_DATA_DIR: process.env.MCP_DATA_DIR || dataRoot,
    MCP_DATA_AUTO_DOWNLOAD: "false",
    MCP_DATA_REFRESH_ON_START: "false",
    RAG_PROVIDER: provider,
    RAG_FALLBACK: fallback,
    RAG_REBUILD: "false",
    RAG_PREWARM: "false",
    RAG_PREWARM_BLOCK: "false",
    RAG_CACHE_DIR: process.env.RAG_CACHE_DIR || join(projectRoot, ".cache", "rag-index"),
    RAG_MODEL_CACHE_DIR: process.env.RAG_MODEL_CACHE_DIR || join(projectRoot, ".cache", "rag-models")
  };
  return { ...process.env, ...base, ...extra };
}

function requestTimeoutForProvider(provider) {
  return provider === "gemini" ? 300000 : 60000;
}

function parseLogEvents(output) {
  const events = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function findLogEvents(output, component, event) {
  return parseLogEvents(output).filter((entry) => entry.component === component && entry.event === event);
}

// Request logs are written just before the response is sent, so the child's
// stderr may arrive slightly after the client sees the response.
async function waitForLogEvent(getOutput, component, event, predicate = () => true, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = findLogEvents(getOutput(), component, event).find(predicate);
    if (match || Date.now() >= deadline) return match;
    await sleep(50);
  }
}

function assertStructuredDataStartupMode(stderr, expectedMode = "") {
  const entries = findLogEvents(stderr, "data", "startup_mode");
  assert.ok(entries.length > 0, "Expected structured data startup mode log in stderr");
  if (expectedMode) {
    assert.ok(
      entries.some((entry) => entry.mode === expectedMode),
      `Expected data startup mode=${expectedMode}, got ${entries.map((entry) => entry.mode).join(", ")}`
    );
  } else {
    assert.ok(entries.every((entry) => typeof entry.mode === "string" && entry.mode), "startup_mode should include mode");
  }
}

// Verifies the per-request log for the search -> read_document flow exercised by
// runCoreAssertions: parameters, response, and caller context are recorded.
async function assertRequestLogs(getOutput, expectedTransport) {
  const searchLog = await waitForLogEvent(
    getOutput,
    "mcp",
    "tool_call",
    (entry) => entry.tool === "search" && entry.arguments?.query === "basic-scan"
  );
  assert.ok(searchLog, "Expected a tool_call log entry for search");
  assert.equal(searchLog.transport, expectedTransport);
  assert.equal(searchLog.is_error, false);
  assert.equal(typeof searchLog.duration_ms, "number");
  assert.ok(Array.isArray(searchLog.response?.content), "search log should include the response content");

  const readLog = await waitForLogEvent(
    getOutput,
    "mcp",
    "tool_call",
    (entry) => entry.tool === "read_document" && entry.is_error === false
  );
  assert.ok(readLog, "Expected a tool_call log entry for read_document");
  assert.match(readLog.arguments.uri, /^doc:\/\//);
  assert.ok(readLog.response, "read_document log should include the (possibly truncated) response");

  const resourceLog = await waitForLogEvent(getOutput, "mcp", "resource_read");
  assert.ok(resourceLog, "Expected a resource_read log entry");
  assert.match(resourceLog.uri, /^(doc|sample):\/\//);

  if (expectedTransport === "http") {
    assert.match(searchLog.client_id || "", /^[0-9a-f]{16}$/, "http request logs should carry a hashed client_id by default");
    assert.equal(searchLog.client_ip, undefined, "raw client IP should not be logged by default");
    assert.ok(searchLog.user_agent, "http request logs should include the user agent");
  } else {
    assert.equal(searchLog.client_id, undefined);
  }
}

function packageCommandCandidates(tgzPath) {
  return [
    {
      command: npmCommand(),
      args: ["exec", "--yes", "--package", tgzPath, "--", "simple-dynamsoft-mcp"]
    },
    {
      command: npxCommand(),
      args: ["-y", "--package", tgzPath, "simple-dynamsoft-mcp"]
    }
  ];
}

async function createPackagedRuntimeClient({
  tgzPath,
  workspaceDir,
  env,
  name,
  retries = 1,
  retryDelayMs = 0
}) {
  const commands = packageCommandCandidates(tgzPath);
  const maxRetries = Math.max(1, Number(retries) || 1);
  let bundle = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries && !bundle; attempt += 1) {
    for (const candidate of commands) {
      try {
        bundle = await createStdioClient({
          command: candidate.command,
          args: candidate.args,
          cwd: workspaceDir,
          env,
          name: `${name}-${attempt}`
        });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!bundle && attempt < maxRetries && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (!bundle) {
    throw lastError || new Error("Failed to launch packaged runtime client");
  }
  return bundle;
}

async function createStdioClient({
  command = nodeCommand(),
  args = [serverEntry],
  cwd = projectRoot,
  env = {},
  name = "integration-stdio-client"
} = {}) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: sanitizeEnv(env),
    stderr: "pipe"
  });

  let stderrOutput = "";
  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
  }

  const client = makeClient(name);
  try {
    await client.connect(transport);
  } catch (error) {
    const detail = stderrOutput.trim();
    const wrapped = new Error(
      `Failed to connect stdio client (${name}). ${detail ? `stderr: ${detail}` : "No stderr output."}`
    );
    wrapped.cause = error;
    throw wrapped;
  }

  return {
    client,
    transport,
    getStderr: () => stderrOutput
  };
}

async function runCoreAssertions(client, { requestTimeoutMs = 60000 } = {}) {
  const requestOptions = { timeout: requestTimeoutMs };
  const tools = await client.listTools(undefined, requestOptions);
  const toolNames = tools.tools.map((tool) => tool.name);
  const expectedTools = [
    "get_index",
    "search",
    "read_document",
    "list_samples",
    "resolve_version",
    "get_quickstart",
    "get_sample_files"
  ];
  assert.equal(tools.tools.length, expectedTools.length, "Unexpected tool count");
  for (const tool of expectedTools) {
    assert.ok(toolNames.includes(tool), `Missing tool: ${tool}`);
  }

  const search = await client.callTool(
    {
      name: "search",
      arguments: { query: "basic-scan", product: "dwt", limit: 3 }
    },
    undefined,
    requestOptions
  );
  assert.equal(search.isError, undefined, "Search should not return isError");
  const link = search.content.find((item) => item.type === "resource_link");
  assert.ok(link, "Search should return at least one resource_link");

  // Regression: DBR web quickstart must honor the scenario (camera -> camera
  // starter) instead of collapsing everything to the image-file sample, must
  // not read api_level (a mobile-only concept), and must not hard-error.
  const cameraQuickstart = await client.callTool(
    {
      name: "get_quickstart",
      arguments: {
        product: "dbr",
        edition: "web",
        platform: "js",
        scenario: "camera",
        api_level: "high-level"
      }
    },
    undefined,
    requestOptions
  );
  assert.equal(cameraQuickstart.isError, undefined, "DBR web camera quickstart should not error");
  const cameraText = cameraQuickstart.content.map((item) => item.text || "").join("\n");
  assert.match(cameraText, /## Foundational sample: scan-a-single-barcode/, "camera scenario should return the camera starter sample");
  assert.doesNotMatch(cameraText, /sample: read-an-image/i, "camera scenario should not serve the image-file sample");

  const imageQuickstart = await client.callTool(
    {
      name: "get_quickstart",
      arguments: { product: "dbr", edition: "web", platform: "js", scenario: "image" }
    },
    undefined,
    requestOptions
  );
  assert.equal(imageQuickstart.isError, undefined, "DBR web image quickstart should not error");
  const imageText = imageQuickstart.content.map((item) => item.text || "").join("\n");
  assert.match(imageText, /## Foundational sample: read-an-image/, "image scenario should return the image-file sample");

  const resources = await client.listResources(undefined, requestOptions);
  assert.ok(resources.resources.length > 0, "resources/list should return pinned resources");
  const resourceUris = resources.resources.map((resource) => resource.uri);
  assert.ok(resourceUris.includes("doc://product-selection"), "resources/list should expose product-selection guidance");
  const read = await client.readResource({ uri: link.uri }, requestOptions);
  assert.ok(read.contents.length > 0, "resources/read should return non-empty contents");

  // Doc Q&A flow for tool-only clients: search -> read_document -> cite URL.
  const docSearch = await client.callTool(
    {
      name: "search",
      arguments: { query: "getting started", product: "dwt", type: "doc", limit: 3 }
    },
    undefined,
    requestOptions
  );
  assert.equal(docSearch.isError, undefined, "Doc search should not return isError");
  const docLink = docSearch.content.find((item) => item.type === "resource_link" && item.uri.startsWith("doc://"));
  assert.ok(docLink, "Doc search should return a doc:// resource_link");
  assert.match(docSearch.content[0].text, /read_document/, "Search guidance should point doc results to read_document");

  const docRead = await client.callTool(
    { name: "read_document", arguments: { uri: docLink.uri } },
    undefined,
    requestOptions
  );
  assert.equal(docRead.isError, undefined, "read_document should succeed for a URI returned by search");
  assert.equal(docRead.content.length, 1);
  assert.equal(docRead.content[0].type, "text");
  const docText = docRead.content[0].text;
  assert.match(docText, /^# \S/, "read_document should start with the document title");
  assert.match(docText, /\*\*URL:\*\* https:\/\/www\.dynamsoft\.com\//, "read_document should include the public docs URL");
  const docBody = docText.split("\n---\n")[1] || "";
  assert.ok(docBody.trim().length > 0, "read_document should include the article body");

  const docResource = await client.readResource({ uri: docLink.uri }, requestOptions);
  assert.equal(docResource.contents[0].text, docText, "read_document should match resources/read content");

  const staleRead = await client.callTool(
    { name: "read_document", arguments: { uri: `${docLink.uri}-stale-uri-check` } },
    undefined,
    requestOptions
  );
  assert.equal(staleRead.isError, true, "read_document should flag stale URIs as errors");
  assert.match(staleRead.content[0].text, /Call search/, "stale URI errors should guide back to search");
}

async function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Unable to resolve ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

function startNativeHttpServer({
  port,
  host = "127.0.0.1",
  cwd = projectRoot,
  env = {}
}) {
  const command = nodeCommand();
  const args = [
    serverEntry,
    "--transport=http",
    "--host",
    host,
    "--port",
    String(port)
  ];
  const proc = spawn(command, args, {
    cwd,
    env: sanitizeEnv(env),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const stop = async () => {
    if (proc.killed || proc.exitCode !== null) return;
    proc.kill();
    await Promise.race([
      new Promise((resolvePromise) => proc.once("exit", resolvePromise)),
      sleep(4000).then(() => {
        if (proc.exitCode === null) {
          proc.kill("SIGKILL");
        }
      })
    ]);
  };

  return {
    proc,
    stop,
    getLogs: () => ({ stdout, stderr })
  };
}

async function connectStreamableClientWithRetry({
  urls,
  timeoutMs = 30000,
  retryDelayMs = 400,
  name = "integration-http-client"
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const rawUrl of urls) {
      let transport = null;
      try {
        const client = makeClient(name);
        transport = new StreamableHTTPClientTransport(new URL(rawUrl));
        await client.connect(transport);
        return { client, transport, url: rawUrl };
      } catch (error) {
        lastError = error;
        if (transport) {
          try {
            await transport.close();
          } catch {
            // Ignore close errors while retrying.
          }
        }
      }
    }
    await sleep(retryDelayMs);
  }

  throw new Error(`Failed to connect Streamable HTTP client. Last error: ${lastError?.message || "unknown"}`);
}

function packProjectToTempDir() {
  const tempDir = mkdtempSync(join(tmpdir(), "simple-dynamsoft-mcp-pack-"));
  const result = spawnSync(`${npmCommand()} pack --pack-destination "${tempDir}"`, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: true
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || result.error?.message || "unknown error";
    throw new Error(`npm pack failed: ${reason}`);
  }
  const tgz = readdirSync(tempDir).find((entry) => entry.endsWith(".tgz"));
  if (!tgz) {
    throw new Error(`npm pack did not produce a .tgz in ${tempDir}`);
  }
  return {
    tempDir,
    tgzPath: join(tempDir, tgz)
  };
}

function cleanupDir(path) {
  if (path && existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

export {
  RUN_GEMINI_PROVIDER_TESTS,
  cleanupDir,
  connectStreamableClientWithRetry,
  createStdioClient,
  dataRoot,
  getFreePort,
  npmCommand,
  npxCommand,
  packProjectToTempDir,
  projectRoot,
  requestTimeoutForProvider,
  resolveServerEnv,
  runCoreAssertions,
  assertRequestLogs,
  assertStructuredDataStartupMode,
  findLogEvents,
  createPackagedRuntimeClient,
  serverEntry,
  startNativeHttpServer
};
