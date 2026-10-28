import test from "node:test";
import assert from "node:assert/strict";
import { isVerboseLoggingEnabled, latencyBucket, logEvent } from "../../src/observability/logging.js";

test("isVerboseLoggingEnabled honors MCP_LOG_LEVEL and MCP_VERBOSE_LOGS", () => {
  assert.equal(isVerboseLoggingEnabled({ MCP_LOG_LEVEL: "debug" }), true);
  assert.equal(isVerboseLoggingEnabled({ MCP_VERBOSE_LOGS: "true" }), true);
  assert.equal(isVerboseLoggingEnabled({}), false);
});

test("latencyBucket maps expected ranges", () => {
  assert.equal(latencyBucket(50), "lt100ms");
  assert.equal(latencyBucket(250), "100-299ms");
  assert.equal(latencyBucket(800), "300-999ms");
  assert.equal(latencyBucket(1800), "1-2s");
  assert.equal(latencyBucket(7000), "ge3s");
});

test("logEvent suppresses debug when verbose is disabled", () => {
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args.join(" "));
  };

  try {
    logEvent("rag", "provider_ready", { provider: "lexical" }, { level: "debug", env: {} });
  } finally {
    console.error = original;
  }

  assert.equal(calls.length, 0);
});

test("logEvent writes one JSON object per line with base fields and skips empty values", () => {
  const calls = [];
  const original = console.error;
  console.error = (...args) => {
    calls.push(args.join(" "));
  };

  try {
    logEvent("transport", "server_start", {
      mode: "http",
      port: 3333,
      empty: "",
      missing: undefined,
      level: "spoofed",
      nested: { query: "multi\nline \"quoted\"" }
    }, { level: "warn", env: {} });
  } finally {
    console.error = original;
  }

  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("\n"), "a log entry must stay on one line");
  const entry = JSON.parse(calls[0]);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  assert.equal(entry.level, "warn", "caller fields must not override reserved keys");
  assert.equal(entry.component, "transport");
  assert.equal(entry.event, "server_start");
  assert.equal(entry.mode, "http");
  assert.equal(entry.port, 3333);
  assert.deepEqual(entry.nested, { query: "multi\nline \"quoted\"" });
  assert.equal("empty" in entry, false);
  assert.equal("missing" in entry, false);
});

function captureLines(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

test("MCP_LOG_FORMAT=text renders a single readable line with key=value fields", () => {
  const env = { MCP_LOG_FORMAT: "text" };
  const [line] = captureLines(() => logEvent("data", "startup_mode", {
    mode: "custom",
    path: "/mnt/mcp cache",
    note: "line1\nline2",
    nested: { a: 1 }
  }, { env }));

  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO  \[data\] startup_mode /);
  assert.ok(line.endsWith('mode=custom path="/mnt/mcp cache" note="line1\\nline2" nested={"a":1}'), line);
});

test("text format leads request summaries with tool or uri, outcome, duration, and size", () => {
  const env = { MCP_LOG_FORMAT: "text" };
  const [ok, rpcError] = captureLines(() => {
    logEvent("mcp", "tool_call", {
      transport: "http",
      client_id: "a1b2c3d4e5f60718",
      user_agent: "example-chatbot/1.0",
      request_id: 1,
      tool: "search",
      duration_ms: 374,
      is_error: false,
      response_chars: 1804
    }, { env });
    logEvent("mcp", "resource_read", {
      transport: "stdio",
      request_id: 2,
      uri: "doc://x",
      duration_ms: 1,
      is_error: true,
      error: { code: -32603, message: "Resource not found: doc://x" }
    }, { env, level: "warn" });
  });

  assert.ok(
    ok.endsWith("INFO  [mcp] search ok 374ms 1804 chars transport=http client_id=a1b2c3d4e5f60718 user_agent=example-chatbot/1.0 request_id=1"),
    ok
  );
  assert.ok(
    rpcError.endsWith('WARN  [mcp] read doc://x error -32603 "Resource not found: doc://x" 1ms transport=stdio request_id=2'),
    rpcError
  );
});

test("JSON stays the default console format", () => {
  const [line] = captureLines(() => logEvent("transport", "server_start", { mode: "http" }, { env: {} }));
  assert.equal(JSON.parse(line).event, "server_start");
});

test("text format marks responses that failed to reach the client as undelivered", () => {
  const [line] = captureLines(() => logEvent("mcp", "tool_call", {
    tool: "search",
    duration_ms: 5,
    is_error: false,
    response_chars: 10,
    send_failed: true,
    send_error: "socket closed"
  }, { env: { MCP_LOG_FORMAT: "text" }, level: "warn" }));
  assert.ok(line.endsWith('WARN  [mcp] search undelivered 5ms 10 chars send_error="socket closed"'), line);
});
