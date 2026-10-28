import { createWriteStream, mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { logEvent, serializeLogEntry } from "./logging.js";

const FILE_PATTERN = /^requests-(\d{4}-\d{2}-\d{2})-.+\.jsonl$/;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function resolveRetentionDays(env = process.env) {
  const raw = env.MCP_REQUEST_LOG_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

function sanitizeFilePart(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]/g, "_") || "host";
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Appends detailed request entries as JSON lines to
// <dir>/requests-<YYYY-MM-DD>-<host>.jsonl (UTC day). One file per host keeps
// replicas sharing a network volume from interleaving writes. Files older than
// retentionDays are removed when a new day's file is opened (0 keeps all).
// Write failures are reported once per day on stderr and never thrown.
function createRequestLogFile({ dir, retentionDays = DEFAULT_RETENTION_DAYS, host = hostname(), now = Date.now }) {
  const hostPart = sanitizeFilePart(host);
  let currentDay = "";
  let failedDay = "";
  let stream = null;
  let cleanup = Promise.resolve();

  function fail(error) {
    failedDay = currentDay;
    const message = error instanceof Error ? error.message : String(error);
    logEvent("request-log", "file_write_failed", { dir, day: currentDay, message }, { level: "error" });
    stream?.destroy();
    stream = null;
  }

  async function removeExpired(today) {
    if (!retentionDays) return;
    const cutoff = Date.parse(`${today}T00:00:00Z`) - retentionDays * DAY_MS;
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      logEvent("request-log", "retention_failed", { dir, message: error instanceof Error ? error.message : String(error) }, { level: "warn" });
      return;
    }
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (!match || Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
      try {
        await unlink(join(dir, name));
      } catch (error) {
        logEvent("request-log", "retention_failed", { file: name, message: error instanceof Error ? error.message : String(error) }, { level: "warn" });
      }
    }
  }

  function open(day) {
    stream?.end();
    stream = null;
    currentDay = day;
    mkdirSync(dir, { recursive: true });
    const next = createWriteStream(join(dir, `requests-${day}-${hostPart}.jsonl`), { flags: "a" });
    next.on("error", (error) => {
      if (stream === next) fail(error);
    });
    stream = next;
    cleanup = removeExpired(day);
  }

  function write(entry) {
    const day = utcDay(now());
    if (day === failedDay) return;
    try {
      if (!stream || day !== currentDay) open(day);
      stream.write(`${serializeLogEntry(entry)}\n`);
    } catch (error) {
      currentDay = day;
      fail(error);
    }
  }

  function close() {
    const current = stream;
    stream = null;
    if (!current) return Promise.resolve();
    return new Promise((resolve) => current.end(resolve));
  }

  return {
    write,
    close,
    whenCleanupDone: () => cleanup
  };
}

let sharedFile = null;
let sharedDir = "";

// Process-wide writer for MCP_REQUEST_LOG_DIR; null when file logging is off.
function getRequestLogFile(env = process.env) {
  const dir = String(env.MCP_REQUEST_LOG_DIR || "").trim();
  if (!dir) return null;
  if (!sharedFile || sharedDir !== dir) {
    sharedFile = createRequestLogFile({ dir, retentionDays: resolveRetentionDays(env) });
    sharedDir = dir;
  }
  return sharedFile;
}

async function closeRequestLogFile() {
  const file = sharedFile;
  sharedFile = null;
  sharedDir = "";
  await file?.close();
}

export {
  closeRequestLogFile,
  createRequestLogFile,
  getRequestLogFile
};
