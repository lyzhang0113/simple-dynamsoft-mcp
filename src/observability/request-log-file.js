import { createWriteStream, mkdirSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { logEvent, serializeLogEntry } from "./logging.js";

const FILE_PATTERN = /^requests-(\d{4}-\d{2}-\d{2})-.+\.jsonl$/;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cap on entries queued in memory while the log volume is slow or stalled.
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

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
//
// Logging must never disrupt requests:
// - Failures are reported on stderr once per day (for whichever day's stream
//   failed, including streams already rotated out or closing) and never thrown.
//   A failing old stream never disables its replacement.
// - If the volume stalls, entries are dropped once maxBufferedBytes are queued
//   across all streams not yet closed (the current day's and any rotated-out
//   stream still flushing), so memory stays bounded. Dropping is reported once
//   per stall, and resuming (with the dropped count) on the next write that
//   fits. A single entry larger than the cap is dropped and reported with its
//   size. A cap of 0 queues nothing.
function createRequestLogFile({
  dir,
  retentionDays = DEFAULT_RETENTION_DAYS,
  host = hostname(),
  now = Date.now,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  openStream = (path) => createWriteStream(path, { flags: "a" })
}) {
  const hostPart = sanitizeFilePart(host);
  const reportedDays = new Set();
  let currentDay = "";
  let failedDay = "";
  let stream = null;
  let droppedEntries = 0;
  // Streams that may still hold queued bytes: the current one plus rotated-out
  // or closing ones, until they emit "close".
  const liveStreams = new Set();

  function queuedBytes() {
    let total = 0;
    for (const live of liveStreams) {
      if (!live.destroyed) total += live.writableLength || 0;
    }
    return total;
  }
  let cleanup = Promise.resolve();

  function reportFailure(day, error) {
    if (reportedDays.has(day)) return;
    reportedDays.add(day);
    const message = error instanceof Error ? error.message : String(error);
    logEvent("request-log", "file_write_failed", { dir, day, message }, { level: "error" });
  }

  function disableDay(day) {
    failedDay = day;
    const failed = stream;
    stream = null;
    failed?.destroy();
  }

  function resumeAfterBackpressure() {
    if (!droppedEntries) return;
    logEvent("request-log", "file_backpressure_resumed", { dir, dropped_entries: droppedEntries }, { level: "warn" });
    droppedEntries = 0;
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
    const next = openStream(join(dir, `requests-${day}-${hostPart}.jsonl`));
    next.on("error", (error) => {
      reportFailure(day, error);
      if (stream === next) disableDay(day);
    });
    liveStreams.add(next);
    next.once("close", () => liveStreams.delete(next));
    stream = next;
    cleanup = removeExpired(day);
  }

  function write(entry) {
    const day = utcDay(now());
    if (day === failedDay) return;
    try {
      if (!stream || day !== currentDay) open(day);
      const line = `${serializeLogEntry(entry)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > maxBufferedBytes) {
        logEvent("request-log", "file_entry_too_large", {
          dir,
          day,
          entry_bytes: lineBytes,
          limit_bytes: maxBufferedBytes
        }, { level: "warn" });
        return;
      }
      const queued = queuedBytes();
      if (queued + lineBytes > maxBufferedBytes) {
        if (!droppedEntries) {
          logEvent("request-log", "file_backpressure_dropping", {
            dir,
            day,
            buffered_bytes: queued,
            limit_bytes: maxBufferedBytes
          }, { level: "warn" });
        }
        droppedEntries += 1;
        return;
      }
      resumeAfterBackpressure();
      stream.write(line);
    } catch (error) {
      reportFailure(day, error);
      currentDay = day;
      disableDay(day);
    }
  }

  // Ends the current stream and resolves once every stream that may still hold
  // queued entries (including rotated-out ones still flushing) has closed, so
  // shutdown does not drop prior-day entries. Errors are reported by each
  // stream's error handler; "close" follows them, so this still resolves.
  function close() {
    const current = stream;
    stream = null;
    const pending = [...liveStreams].filter((live) => !live.closed);
    const closed = pending.map((live) => new Promise((resolve) => live.once("close", resolve)));
    if (current && !current.closed) current.end();
    return Promise.all(closed).then(() => undefined);
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
