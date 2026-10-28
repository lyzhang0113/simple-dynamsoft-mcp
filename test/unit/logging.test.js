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
