import assert from "node:assert/strict";
import test from "node:test";
import {
  attachRequestLogging,
  buildHttpRequestContext,
  describeClientIp,
  resolveClientIp
} from "../../src/observability/request-logging.js";

function createFakeTransport() {
  const sent = [];
  return {
    sent,
    onmessage: undefined,
    async send(message) {
      sent.push(message);
    }
  };
}

function captureLogs(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return () => lines.map((line) => JSON.parse(line));
}

function fakeClock(...times) {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

test("logs tools/call arguments, response, duration, and context; delivers messages unchanged", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  const received = [];
  transport.onmessage = (message) => received.push(message);
  attachRequestLogging(transport, { transport: "http", client_id: "abc" }, { env: {}, now: fakeClock(1000, 1042) });

  const request = {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "search", arguments: { query: "scan a barcode", product: "dbr" } }
  };
  transport.onmessage(request);
  const response = { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "Found 1 result" }] } };
  await transport.send(response);

  assert.deepEqual(received, [request], "the original message handler must still run");
  assert.deepEqual(transport.sent, [response], "the response must still be sent");
  const logs = readLogs();
  assert.equal(logs.length, 1);
  const [entry] = logs;
  assert.equal(entry.component, "mcp");
  assert.equal(entry.event, "tool_call");
  assert.equal(entry.level, "info");
  assert.equal(entry.transport, "http");
  assert.equal(entry.client_id, "abc");
  assert.equal(entry.request_id, 7);
  assert.equal(entry.tool, "search");
  assert.deepEqual(entry.arguments, { query: "scan a barcode", product: "dbr" });
  assert.equal(entry.duration_ms, 42);
  assert.equal(entry.is_error, false);
  assert.deepEqual(entry.response, response.result);
});

test("flags tool results with isError and JSON-RPC errors for resources/read", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  attachRequestLogging(transport, { transport: "stdio" }, { env: {} });

  transport.onmessage({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "read_document", arguments: { uri: "https://x" } } });
  await transport.send({ jsonrpc: "2.0", id: "a", result: { isError: true, content: [{ type: "text", text: "Unsupported URI" }] } });

  transport.onmessage({ jsonrpc: "2.0", id: "b", method: "resources/read", params: { uri: "doc://dwt/web/web/19/x" } });
  await transport.send({ jsonrpc: "2.0", id: "b", error: { code: -32603, message: "Resource not found", data: { detail: "x" } } });

  const [toolEntry, resourceEntry] = readLogs();
  assert.equal(toolEntry.is_error, true);
  assert.equal(toolEntry.level, "info");

  assert.equal(resourceEntry.event, "resource_read");
  assert.equal(resourceEntry.uri, "doc://dwt/web/web/19/x");
  assert.equal(resourceEntry.tool, undefined);
  assert.equal(resourceEntry.arguments, undefined);
  assert.equal(resourceEntry.level, "warn");
  assert.equal(resourceEntry.is_error, true);
  assert.deepEqual(resourceEntry.error, { code: -32603, message: "Resource not found" });
  assert.equal(resourceEntry.response, undefined);
});

test("does not log other methods, notifications, or unmatched responses", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: {} });

  transport.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await transport.send({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  await transport.send({ jsonrpc: "2.0", id: 99, result: {} });
  await transport.send({ jsonrpc: "2.0", method: "notifications/message", params: {} });

  assert.deepEqual(readLogs(), []);
  assert.equal(transport.sent.length, 3);
});

test("truncates oversized fields to MCP_LOG_MAX_FIELD_CHARS and 0 disables the limit", async (t) => {
  const readLogs = captureLogs(t);
  const bigText = "x".repeat(500);
  const result = { content: [{ type: "text", text: bigText }] };

  const limited = createFakeTransport();
  attachRequestLogging(limited, {}, { env: { MCP_LOG_MAX_FIELD_CHARS: "100" } });
  limited.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sample_files", arguments: { sample_id: "y".repeat(200) } } });
  await limited.send({ jsonrpc: "2.0", id: 1, result });

  const unlimited = createFakeTransport();
  attachRequestLogging(unlimited, {}, { env: { MCP_LOG_MAX_FIELD_CHARS: "0" } });
  unlimited.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sample_files", arguments: {} } });
  await unlimited.send({ jsonrpc: "2.0", id: 1, result });

  const [limitedEntry, unlimitedEntry] = readLogs();
  assert.equal(limitedEntry.response.truncated, true);
  assert.equal(limitedEntry.response.original_chars, JSON.stringify(result).length);
  assert.equal(limitedEntry.response.preview.length, 100);
  assert.equal(limitedEntry.arguments.truncated, true);
  assert.deepEqual(unlimitedEntry.response, result);
});

test("MCP_LOG_REQUESTS=false disables request logging", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: { MCP_LOG_REQUESTS: "false" } });
  transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } });
  await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  assert.deepEqual(readLogs(), []);
});

test("caps caller-controlled uri and request id so one entry stays bounded", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: {} });
  const longId = "i".repeat(5000);
  const longUri = `doc://${"u".repeat(50000)}`;
  transport.onmessage({ jsonrpc: "2.0", id: longId, method: "resources/read", params: { uri: longUri } });
  await transport.send({ jsonrpc: "2.0", id: longId, error: { code: -32603, message: `Resource not found: ${longUri}` } });

  const [entry] = readLogs();
  assert.ok(entry.uri.length < 1100);
  assert.match(entry.uri, /\.\.\.\[truncated \d+ chars\]$/);
  assert.ok(entry.request_id.length < 1100);
  assert.ok(entry.error.message.length < 1100);
});

const PROXY_TRUSTED = { MCP_LOG_TRUST_PROXY: "true" };

test("resolveClientIp ignores X-Forwarded-For unless MCP_LOG_TRUST_PROXY is set", () => {
  const req = { headers: { "x-forwarded-for": "203.0.113.9" }, socket: { remoteAddress: "198.51.100.4" } };
  assert.equal(resolveClientIp(req, {}), "198.51.100.4", "a directly exposed server must not trust a client-sent header");
  assert.equal(resolveClientIp(req, PROXY_TRUSTED), "203.0.113.9");
});

test("resolveClientIp behind a trusted proxy uses the right-most X-Forwarded-For entry", () => {
  assert.equal(
    resolveClientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, socket: { remoteAddress: "10.0.0.1" } }, PROXY_TRUSTED),
    "203.0.113.9",
    "the client-supplied left-most value must not win"
  );
  assert.equal(resolveClientIp({ headers: { "x-forwarded-for": "203.0.113.9:51234" } }, PROXY_TRUSTED), "203.0.113.9");
  assert.equal(resolveClientIp({ headers: { "x-forwarded-for": "[2001:db8::1]:443" } }, PROXY_TRUSTED), "2001:db8::1");
  assert.equal(resolveClientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }, PROXY_TRUSTED), "127.0.0.1");
  assert.equal(resolveClientIp({ headers: {}, socket: {} }, PROXY_TRUSTED), "");
});

test("describeClientIp is off by default and supports hash and full modes", () => {
  assert.deepEqual(describeClientIp("203.0.113.9", {}), {});

  const salted = { MCP_LOG_CLIENT_IP: "hash", MCP_LOG_IP_SALT: "salt-1" };
  const hashed = describeClientIp("203.0.113.9", salted);
  assert.match(hashed.client_id, /^[0-9a-f]{16}$/);
  assert.equal(hashed.client_ip, undefined);
  assert.deepEqual(describeClientIp("203.0.113.9", salted), hashed, "same IP and salt give a stable id");
  assert.notEqual(describeClientIp("203.0.113.10", salted).client_id, hashed.client_id);
  assert.notEqual(describeClientIp("203.0.113.9", { ...salted, MCP_LOG_IP_SALT: "salt-2" }).client_id, hashed.client_id);

  assert.deepEqual(describeClientIp("203.0.113.9", { MCP_LOG_CLIENT_IP: "full" }), { client_ip: "203.0.113.9" });
  assert.deepEqual(describeClientIp("", { MCP_LOG_CLIENT_IP: "full" }), {});
});

test("buildHttpRequestContext includes transport and user agent, and client identity only when enabled", () => {
  const req = { headers: { "user-agent": "copilot-studio/1.0" }, socket: { remoteAddress: "198.51.100.4" } };
  assert.deepEqual(buildHttpRequestContext(req, {}), { transport: "http", user_agent: "copilot-studio/1.0" });
  assert.deepEqual(
    buildHttpRequestContext(req, { MCP_LOG_CLIENT_IP: "full" }),
    { transport: "http", client_ip: "198.51.100.4", user_agent: "copilot-studio/1.0" }
  );
});
