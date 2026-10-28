// Structured logging: one JSON object per line on stderr (stdout is reserved
// for the stdio MCP transport). Every entry carries ts, level, component, and
// event; caller fields are merged in. Lines are directly queryable in log
// stores such as Azure Log Analytics (parse_json(Log_s)).

const RESERVED_KEYS = new Set(["ts", "level", "component", "event"]);

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

function logEvent(component, event, fields = {}, options = {}) {
  const level = normalizeEnvValue(options.level || "info") || "info";
  const verbose = isVerboseLoggingEnabled(options.env);
  if (level === "debug" && !verbose) return;

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

  console.error(serializeLogEntry(entry));
}

export {
  isVerboseLoggingEnabled,
  latencyBucket,
  logEvent
};
