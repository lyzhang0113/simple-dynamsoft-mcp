import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogEntry, logEvent } from "./logging.js";
import { getRequestLogFile } from "./request-log-file.js";

// JSON-RPC methods whose parameters and responses are logged. These are the
// user-driven operations worth reviewing (what was asked, what was returned).
const LOGGED_METHODS = new Map([
  ["tools/call", "tool_call"],
  ["resources/read", "resource_read"]
]);

// Detailed entries go to disk, so arguments/responses are kept whole unless
// MCP_LOG_MAX_FIELD_CHARS sets a cap.
const DEFAULT_MAX_FIELD_CHARS = 0;
const MAX_PENDING_REQUESTS = 1000;
const MAX_USER_AGENT_CHARS = 256;
// Cap for caller-controlled scalars (uri, tool name, JSON-RPC id).
const MAX_SCALAR_CHARS = 1024;
const CLIENT_IP_MODES = new Set(["hash", "full", "off"]);

// Salt for hashed client ids, so they are not reversible by brute forcing the
// IPv4 space without it. Resolution: MCP_LOG_IP_SALT, else a random salt
// persisted once in MCP_REQUEST_LOG_DIR (stable across restarts, revisions,
// and replicas sharing the volume), else a per-process salt.
const SALT_FILE = ".client-id-salt";
const MIN_SALT_CHARS = 32;
const processSalt = randomBytes(32).toString("hex");
const persistedSalts = new Map();
const saltWarnings = new Set();

function loadOrCreateSalt(dir) {
  const path = join(dir, SALT_FILE);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const salt = readFileSync(path, "utf8").trim();
  if (salt.length < MIN_SALT_CHARS) throw new Error(`${path} is empty or too short`);
  return salt;
}

function resolveIpSalt(env = process.env) {
  if (env.MCP_LOG_IP_SALT) return env.MCP_LOG_IP_SALT;
  const dir = String(env.MCP_REQUEST_LOG_DIR || "").trim();
  if (!dir) return processSalt;
  if (persistedSalts.has(dir)) return persistedSalts.get(dir);
  try {
    const salt = loadOrCreateSalt(dir);
    persistedSalts.set(dir, salt);
    return salt;
  } catch (error) {
    // Not cached, so a transient share error is retried on the next request.
    if (!saltWarnings.has(dir)) {
      saltWarnings.add(dir);
      const message = error instanceof Error ? error.message : String(error);
      logEvent("request-log", "salt_unavailable", { dir, message }, { level: "warn" });
    }
    return processSalt;
  }
}

function readBoolEnv(env, key, fallback) {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function isRequestLoggingEnabled(env = process.env) {
  return readBoolEnv(env, "MCP_LOG_REQUESTS", true);
}

function resolveMaxFieldChars(env = process.env) {
  const raw = env.MCP_LOG_MAX_FIELD_CHARS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_FIELD_CHARS;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_FIELD_CHARS;
}

// IP-derived fields are personal data, so they are opt-in.
function resolveClientIpMode(env = process.env) {
  const mode = String(env.MCP_LOG_CLIENT_IP || "").trim().toLowerCase();
  return CLIENT_IP_MODES.has(mode) ? mode : "off";
}

// Bounds a logged value when a cap is configured. 0 disables the limit.
function limitForLog(value, maxChars) {
  if (value === undefined || !maxChars) return value;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (text === undefined || text.length <= maxChars) return value;
  return { truncated: true, original_chars: text.length, preview: text.slice(0, maxChars) };
}

// Bounds caller-controlled fields that are expected to be short (uri, tool
// name, JSON-RPC id, error message) even when the caller sends something else.
function capScalar(value) {
  if (typeof value !== "string") return limitForLog(value, MAX_SCALAR_CHARS);
  if (value.length <= MAX_SCALAR_CHARS) return value;
  return `${value.slice(0, MAX_SCALAR_CHARS)}...[truncated ${value.length - MAX_SCALAR_CHARS} chars]`;
}

function normalizeIp(value) {
  let ip = String(value || "").trim();
  if (!ip) return "";
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (ipv4WithPort) ip = ipv4WithPort[1];
  if (ip.toLowerCase().startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  return ip;
}

// X-Forwarded-For is client-controlled unless a proxy in front of the server
// rewrites it, so it is only honored with MCP_LOG_TRUST_PROXY=true (e.g. Azure
// Container Apps ingress). The trusted proxy appends the peer it saw, so the
// right-most entry is the one a client cannot spoof. Otherwise the socket peer
// is used.
function resolveClientIp(req, env = process.env) {
  if (readBoolEnv(env, "MCP_LOG_TRUST_PROXY", false)) {
    const forwarded = req?.headers?.["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    if (header) {
      const parts = String(header).split(",").map((part) => part.trim()).filter(Boolean);
      if (parts.length > 0) return normalizeIp(parts[parts.length - 1]);
    }
  }
  return normalizeIp(req?.socket?.remoteAddress);
}

function describeClientIp(ip, env = process.env) {
  if (!ip) return {};
  const mode = resolveClientIpMode(env);
  if (mode === "off") return {};
  if (mode === "full") return { client_ip: ip };
  const salt = resolveIpSalt(env);
  return { client_id: createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16) };
}

function buildHttpRequestContext(req, env = process.env) {
  const context = { transport: "http" };
  if (resolveClientIpMode(env) !== "off") {
    Object.assign(context, describeClientIp(resolveClientIp(req, env), env));
  }
  const userAgent = req?.headers?.["user-agent"];
  if (userAgent) context.user_agent = String(userAgent).slice(0, MAX_USER_AGENT_CHARS);
  return context;
}

function isResponse(message) {
  return Boolean(message) && message.id !== undefined && message.id !== null
    && ("result" in message || "error" in message);
}

function jsonLength(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return undefined;
  }
}

// One entry per tools/call or resources/read. stderr gets a short summary
// (what was called, outcome, duration, response size). The detailed entry
// (arguments, full response, caller context) is appended to the request log
// file when MCP_REQUEST_LOG_DIR is set. Hooks the transport so every tool and
// resource handler is covered without per-handler code. Safe to call before or
// after server.connect(transport).
function attachRequestLogging(transport, context = {}, {
  env = process.env,
  now = Date.now,
  file = getRequestLogFile(env)
} = {}) {
  if (!isRequestLoggingEnabled(env)) return transport;
  const maxChars = resolveMaxFieldChars(env);
  const pending = new Map();

  const previousOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const event = message && message.id !== undefined ? LOGGED_METHODS.get(message.method) : undefined;
    if (event) {
      if (pending.size >= MAX_PENDING_REQUESTS) {
        pending.delete(pending.keys().next().value);
      }
      pending.set(message.id, { event, params: message.params || {}, startedAt: now() });
    }
    previousOnMessage?.(message, extra);
  };

  const originalSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (isResponse(message) && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      const params = request.params;
      const isToolCall = request.event === "tool_call";
      const rpcError = message.error;
      const level = rpcError ? "warn" : "info";
      const summary = {
        ...context,
        request_id: capScalar(message.id),
        tool: isToolCall ? capScalar(params.name) : undefined,
        uri: isToolCall ? undefined : capScalar(params.uri),
        duration_ms: now() - request.startedAt,
        is_error: Boolean(rpcError) || message.result?.isError === true,
        error: rpcError ? { code: rpcError.code, message: capScalar(rpcError.message) } : undefined
      };

      logEvent("mcp", request.event, {
        ...summary,
        response_chars: rpcError ? undefined : jsonLength(message.result)
      }, { level, env });

      file?.write(createLogEntry("mcp", request.event, {
        ...summary,
        arguments: isToolCall ? limitForLog(params.arguments || {}, maxChars) : undefined,
        response: rpcError ? undefined : limitForLog(message.result, maxChars)
      }, level));
    }
    return originalSend(message, options);
  };

  return transport;
}

export {
  attachRequestLogging,
  buildHttpRequestContext,
  describeClientIp,
  limitForLog,
  resolveClientIp
};
