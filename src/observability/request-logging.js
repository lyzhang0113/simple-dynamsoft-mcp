import { createHmac, randomBytes } from "node:crypto";
import { logEvent } from "./logging.js";

// JSON-RPC methods whose parameters and responses are logged. These are the
// user-driven operations worth reviewing (what was asked, what was returned).
const LOGGED_METHODS = new Map([
  ["tools/call", "tool_call"],
  ["resources/read", "resource_read"]
]);

const DEFAULT_MAX_FIELD_CHARS = 8000;
const MAX_PENDING_REQUESTS = 1000;
const MAX_USER_AGENT_CHARS = 256;
const CLIENT_IP_MODES = new Set(["hash", "full", "off"]);

// Per-process fallback salt so hashed client IDs are not reversible by brute
// forcing the IPv4 space. Set MCP_LOG_IP_SALT for IDs that stay stable across
// restarts and replicas.
const processSalt = randomBytes(32).toString("hex");

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

function resolveClientIpMode(env = process.env) {
  const mode = String(env.MCP_LOG_CLIENT_IP || "").trim().toLowerCase();
  return CLIENT_IP_MODES.has(mode) ? mode : "hash";
}

// Keeps log lines bounded: container runtimes split long stderr lines, which
// breaks JSON parsing downstream. 0 disables the limit.
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

// Behind a reverse proxy (e.g. Azure Container Apps ingress) the socket peer is
// the proxy. The proxy appends the peer it saw to X-Forwarded-For, so the
// right-most entry is the one a client cannot spoof.
function resolveClientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (header) {
    const parts = String(header).split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return normalizeIp(parts[parts.length - 1]);
  }
  return normalizeIp(req?.socket?.remoteAddress);
}

function describeClientIp(ip, env = process.env) {
  if (!ip) return {};
  const mode = resolveClientIpMode(env);
  if (mode === "off") return {};
  if (mode === "full") return { client_ip: ip };
  const salt = env.MCP_LOG_IP_SALT || processSalt;
  return { client_id: createHmac("sha256", salt).update(ip).digest("hex").slice(0, 16) };
}

function buildHttpRequestContext(req, env = process.env) {
  const context = { transport: "http", ...describeClientIp(resolveClientIp(req), env) };
  const userAgent = req?.headers?.["user-agent"];
  if (userAgent) context.user_agent = String(userAgent).slice(0, MAX_USER_AGENT_CHARS);
  return context;
}

function isResponse(message) {
  return Boolean(message) && message.id !== undefined && message.id !== null
    && ("result" in message || "error" in message);
}

// Logs one entry per tools/call or resources/read: request parameters, the
// response sent back, duration, and the caller context. Hooks the transport so
// every tool and resource handler is covered without per-handler code.
// Safe to call before or after server.connect(transport).
function attachRequestLogging(transport, context = {}, { env = process.env, now = Date.now } = {}) {
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
      logEvent("mcp", request.event, {
        ...context,
        request_id: message.id,
        tool: isToolCall ? params.name : undefined,
        uri: isToolCall ? undefined : params.uri,
        arguments: isToolCall ? limitForLog(params.arguments || {}, maxChars) : undefined,
        duration_ms: now() - request.startedAt,
        is_error: Boolean(rpcError) || message.result?.isError === true,
        error: rpcError ? { code: rpcError.code, message: rpcError.message } : undefined,
        response: rpcError ? undefined : limitForLog(message.result, maxChars)
      }, { level: rpcError ? "warn" : "info" });
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
