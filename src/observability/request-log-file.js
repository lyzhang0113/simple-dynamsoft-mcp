import { createWriteStream } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
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
//   across every day's file not yet closed (entries waiting for the file to
//   open plus bytes queued in its stream, including a rotated-out file still
//   flushing), so memory stays bounded. Dropping is reported once per stall,
//   and resuming (with the dropped count) on the next write that fits. A
//   single entry larger than the cap is dropped and reported with its size. A
//   cap of 0 queues nothing.
// - No blocking filesystem calls run on the request path: the directory is
//   created asynchronously, and entries logged meanwhile are queued (within
//   the cap) and written in order once the file opens.
function createRequestLogFile({
  dir,
  retentionDays = DEFAULT_RETENTION_DAYS,
  host = hostname(),
  now = Date.now,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  makeDir = (path) => mkdir(path, { recursive: true }),
  openStream = (path) => createWriteStream(path, { flags: "a" })
}) {
  const hostPart = sanitizeFilePart(host);
  const reportedDays = new Set();
  // One sink per day's file. Entries logged before the directory exists and
  // the stream is open wait in sink.pending; afterwards they queue in the
  // stream. A sink stays in `sinks` (and counts against the cap) until its
  // stream closes or its open fails, including after rotation.
  const sinks = new Set();
  let current = null;
  let failedDay = "";
  let droppedEntries = 0;
  let cleanup = Promise.resolve();

  function reportFailure(day, error) {
    if (reportedDays.has(day)) return;
    reportedDays.add(day);
    const message = error instanceof Error ? error.message : String(error);
    logEvent("request-log", "file_write_failed", { dir, day, message }, { level: "error" });
  }

  function sinkBytes(sink) {
    const streamBytes = sink.stream && !sink.stream.destroyed ? sink.stream.writableLength || 0 : 0;
    return sink.pendingBytes + streamBytes;
  }

  function queuedBytes() {
    let total = 0;
    for (const sink of sinks) total += sinkBytes(sink);
    return total;
  }

  function discardPending(sink) {
    sink.pending = [];
    sink.pendingBytes = 0;
  }

  function disableDay(day) {
    failedDay = day;
    const failed = current;
    current = null;
    if (!failed) return;
    discardPending(failed);
    failed.stream?.destroy();
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

  // Directory creation is async so a slow or stalled volume never blocks the
  // event loop on the request path.
  function createSink(day) {
    const sink = { day, stream: null, pending: [], pendingBytes: 0, ended: false };
    let markDone;
    sink.done = new Promise((resolve) => {
      markDone = resolve;
    });
    const finish = () => {
      sinks.delete(sink);
      markDone();
    };
    sinks.add(sink);

    sink.ready = Promise.resolve()
      .then(() => makeDir(dir))
      .then(() => {
        if (failedDay === day) {
          finish();
          return;
        }
        const stream = openStream(join(dir, `requests-${day}-${hostPart}.jsonl`));
        stream.on("error", (error) => {
          reportFailure(day, error);
          if (current === sink) disableDay(day);
        });
        stream.once("close", finish);
        sink.stream = stream;
        for (const line of sink.pending) stream.write(line);
        discardPending(sink);
        if (sink.ended) stream.end();
        cleanup = removeExpired(day);
      })
      .catch((error) => {
        reportFailure(day, error);
        if (current === sink) disableDay(day);
        discardPending(sink);
        if (!sink.stream) finish();
      });
    return sink;
  }

  function endSink(sink) {
    sink.ended = true;
    sink.stream?.end();
  }

  function write(entry) {
    const day = utcDay(now());
    if (day === failedDay) return;
    try {
      if (!current || current.day !== day) {
        if (current) endSink(current);
        current = createSink(day);
      }
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
      if (current.stream) {
        current.stream.write(line);
      } else {
        current.pending.push(line);
        current.pendingBytes += lineBytes;
      }
    } catch (error) {
      reportFailure(day, error);
      disableDay(day);
    }
  }

  // Ends the current day's file and resolves once every sink has finished:
  // pending opens complete and flush, and rotated-out streams still flushing
  // close, so shutdown does not drop entries. Errors are reported by each
  // stream's handler; "close" follows them, so this still resolves.
  function close() {
    const last = current;
    current = null;
    if (last) endSink(last);
    return Promise.all([...sinks].map((sink) => sink.done)).then(() => undefined);
  }

  async function whenCleanupDone() {
    await Promise.all([...sinks].map((sink) => sink.ready));
    await cleanup;
  }

  return {
    write,
    close,
    whenCleanupDone
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
