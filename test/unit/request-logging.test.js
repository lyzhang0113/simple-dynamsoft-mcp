import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function createFakeFile() {
  const entries = [];
  return { entries, write: (entry) => entries.push(JSON.parse(JSON.stringify(entry))) };
}

test("stderr gets a summary while the file gets arguments, full response, and context", async (t) => {
  const readLogs = captureLogs(t);
  const file = createFakeFile();
  const transport = createFakeTransport();
  const received = [];
  transport.onmessage = (message) => received.push(message);
  attachRequestLogging(
    transport,
    { transport: "http", client_id: "abc", user_agent: "agent/1" },
    { env: {}, now: fakeClock(1000, 1042), file }
  );

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

  const [summary, ...extraLogs] = readLogs();
  assert.deepEqual(extraLogs, []);
  const { ts: summaryTs, ...summaryFields } = summary;
  assert.ok(summaryTs);
  assert.deepEqual(summaryFields, {
    level: "info",
    component: "mcp",
    event: "tool_call",
    transport: "http",
    client_id: "abc",
    user_agent: "agent/1",
    request_id: 7,
    tool: "search",
    duration_ms: 42,
    is_error: false,
    response_chars: JSON.stringify(response.result).length
  }, "stderr carries requester info but not arguments or response bodies");

  assert.equal(file.entries.length, 1);
  const [detail] = file.entries;
  assert.equal(detail.component, "mcp");
  assert.equal(detail.event, "tool_call");
  assert.equal(detail.client_id, "abc");
  assert.equal(detail.user_agent, "agent/1");
  assert.equal(detail.request_id, 7);
  assert.equal(detail.tool, "search");
  assert.deepEqual(detail.arguments, { query: "scan a barcode", product: "dbr" });
  assert.equal(detail.duration_ms, 42);
  assert.equal(detail.is_error, false);
  assert.deepEqual(detail.response, response.result);
});

test("flags tool results with isError and JSON-RPC errors for resources/read", async (t) => {
  const readLogs = captureLogs(t);
  const file = createFakeFile();
  const transport = createFakeTransport();
  attachRequestLogging(transport, { transport: "stdio" }, { env: {}, file });

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
  assert.equal(resourceEntry.level, "warn");
  assert.equal(resourceEntry.is_error, true);
  assert.deepEqual(resourceEntry.error, { code: -32603, message: "Resource not found" });
  assert.equal(resourceEntry.response_chars, undefined);

  const resourceDetail = file.entries[1];
  assert.equal(resourceDetail.level, "warn");
  assert.equal(resourceDetail.arguments, undefined);
  assert.equal(resourceDetail.response, undefined);
  assert.deepEqual(resourceDetail.error, { code: -32603, message: "Resource not found" });
});

test("does not log other methods, notifications, or unmatched responses", async (t) => {
  const readLogs = captureLogs(t);
  const file = createFakeFile();
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: {}, file });

  transport.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await transport.send({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  await transport.send({ jsonrpc: "2.0", id: 99, result: {} });
  await transport.send({ jsonrpc: "2.0", method: "notifications/message", params: {} });

  assert.deepEqual(readLogs(), []);
  assert.deepEqual(file.entries, []);
  assert.equal(transport.sent.length, 3);
});

test("file detail is untruncated by default and MCP_LOG_MAX_FIELD_CHARS caps it", async (t) => {
  captureLogs(t);
  const file = createFakeFile();
  const result = { content: [{ type: "text", text: "x".repeat(50000) }] };

  const unlimited = createFakeTransport();
  attachRequestLogging(unlimited, {}, { env: {}, file });
  unlimited.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sample_files", arguments: {} } });
  await unlimited.send({ jsonrpc: "2.0", id: 1, result });

  const limited = createFakeTransport();
  attachRequestLogging(limited, {}, { env: { MCP_LOG_MAX_FIELD_CHARS: "100" }, file });
  limited.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sample_files", arguments: { sample_id: "y".repeat(200) } } });
  await limited.send({ jsonrpc: "2.0", id: 1, result });

  const [unlimitedEntry, limitedEntry] = file.entries;
  assert.deepEqual(unlimitedEntry.response, result);
  assert.equal(limitedEntry.response.truncated, true);
  assert.equal(limitedEntry.response.original_chars, JSON.stringify(result).length);
  assert.equal(limitedEntry.response.preview.length, 100);
  assert.equal(limitedEntry.arguments.truncated, true);
});

test("MCP_LOG_REQUESTS=false disables request logging", async (t) => {
  const readLogs = captureLogs(t);
  const file = createFakeFile();
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: { MCP_LOG_REQUESTS: "false" }, file });
  transport.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: {} } });
  await transport.send({ jsonrpc: "2.0", id: 1, result: { content: [] } });
  assert.deepEqual(readLogs(), []);
  assert.deepEqual(file.entries, []);
});

test("caps caller-controlled uri and request id so one entry stays bounded", async (t) => {
  const readLogs = captureLogs(t);
  const transport = createFakeTransport();
  attachRequestLogging(transport, {}, { env: {}, file: null });
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

test("without MCP_LOG_IP_SALT, hashing writes no salt next to the request logs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "client-id-salt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { MCP_LOG_CLIENT_IP: "hash", MCP_REQUEST_LOG_DIR: dir };

  const first = describeClientIp("203.0.113.9", env);
  assert.match(first.client_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(describeClientIp("203.0.113.9", env), first, "ids are stable within the process");
  assert.deepEqual(readdirSync(dir), [], "the HMAC key must not be co-located with the logs");
});

test("a failed send is logged as undelivered and the error is rethrown", async (t) => {
  const readLogs = captureLogs(t);
  const file = createFakeFile();
  const transport = {
    onmessage: undefined,
    async send() {
      throw new Error("socket closed");
    }
  };
  attachRequestLogging(transport, { transport: "http" }, { env: {}, file });

  transport.onmessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "search", arguments: { query: "q" } } });
  await assert.rejects(
    () => transport.send({ jsonrpc: "2.0", id: 5, result: { content: [] } }),
    { message: "socket closed" }
  );

  const [summary] = readLogs();
  assert.equal(summary.level, "warn");
  assert.equal(summary.send_failed, true);
  assert.equal(summary.send_error, "socket closed");
  assert.equal(file.entries[0].send_failed, true);
});
