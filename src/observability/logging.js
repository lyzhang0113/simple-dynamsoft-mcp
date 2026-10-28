// Structured logging on stderr (stdout is reserved for the stdio MCP
// transport). Every entry carries ts, level, component, and event; caller
// fields are merged in. MCP_LOG_FORMAT selects the console rendering:
// "json" (default, one JSON object per line) or "text" (one human-readable
// line). Detailed request log files are always JSON (see request-log-file.js).

const RESERVED_KEYS = new Set(["ts", "level", "component", "event"]);
const REQUEST_EVENTS = new Set(["tool_call", "resource_read"]);

function normalizeEnvValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toLowerCase();
}

function isVerboseLoggingEnabled(env = process.env) {
  const explicit = normalizeEnvValue(env.MCP_LOG_LEVEL);
  if (["debug", "verbose", "trace"].includes(explicit)) return true;
  const toggle = normalizeEnvValue(env.MCP_VERBOSE_LOGS);
  return ["1", "true", "yes", "on"].includes(toggle);
}

function resolveLogFormat(env = process.env) {
  return normalizeEnvValue(env.MCP_LOG_FORMAT) === "text" ? "text" : "json";
}

function latencyBucket(latencyMs) {
  const n = Number(latencyMs);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 100) return "lt100ms";
  if (n < 300) return "100-299ms";
  if (n < 1000) return "300-999ms";
  if (n < 3000) return "1-2s";
  return "ge3s";
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

function serializeLogEntry(entry) {
  try {
    return JSON.stringify(entry, jsonReplacer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      component: entry.component,
      event: entry.event,
      serialization_error: message
    });
  }
}

function createLogEntry(component, event, fields = {}, level = "info") {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: String(component || "app"),
    event: String(event || "detail")
  };
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (RESERVED_KEYS.has(key)) continue;
    entry[key] = value;
  }
  return entry;
}

function formatTextValue(value) {
  if (typeof value === "string") {
    return value === "" || /[\s="\x00-\x1f]/.test(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, jsonReplacer);
}

// "search ok 374ms 1804 chars" / "read doc://x error -32603 \"msg\" 1ms".
function formatRequestHead(entry, consumed) {
  const parts = [];
  if (entry.event === "tool_call") {
    parts.push(formatTextValue(entry.tool ?? "?"));
    consumed.add("tool");
  } else {
    parts.push("read", formatTextValue(entry.uri ?? "?"));
    consumed.add("uri");
  }
  parts.push(entry.is_error ? "error" : "ok");
  if (entry.error) {
    parts.push(String(entry.error.code), formatTextValue(String(entry.error.message ?? "")));
  }
  if (entry.duration_ms !== undefined) parts.push(`${entry.duration_ms}ms`);
  if (entry.response_chars !== undefined) parts.push(`${entry.response_chars} chars`);
  for (const key of ["is_error", "error", "duration_ms", "response_chars"]) consumed.add(key);
  return parts;
}

function formatTextLine(entry) {
  const parts = [entry.ts, entry.level.toUpperCase().padEnd(5), `[${entry.component}]`];
  const consumed = new Set(RESERVED_KEYS);
  if (entry.component === "mcp" && REQUEST_EVENTS.has(entry.event)) {
    parts.push(...formatRequestHead(entry, consumed));
  } else {
    parts.push(entry.event);
  }
  for (const [key, value] of Object.entries(entry)) {
    if (!consumed.has(key)) parts.push(`${key}=${formatTextValue(value)}`);
  }
  return parts.join(" ");
}

function logEvent(component, event, fields = {}, options = {}) {
  const env = options.env || process.env;
  const level = normalizeEnvValue(options.level || "info") || "info";
  const verbose = isVerboseLoggingEnabled(env);
  if (level === "debug" && !verbose) return;

  const entry = createLogEntry(component, event, fields, level);
  console.error(resolveLogFormat(env) === "text" ? formatTextLine(entry) : serializeLogEntry(entry));
}

export {
  createLogEntry,
  formatTextLine,
  isVerboseLoggingEnabled,
  latencyBucket,
  logEvent,
  serializeLogEntry
};
