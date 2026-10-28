import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequestLogFile } from "../../src/observability/request-log-file.js";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "request-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function silenceStderr(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return lines;
}

function readJsonLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("appends JSON lines to a per-day, per-host file and rotates at UTC midnight", async (t) => {
  const dir = tempDir(t);
  let clock = Date.parse("2026-10-28T23:59:59Z");
  const file = createRequestLogFile({ dir, host: "replica/1", now: () => clock });

  file.write({ event: "tool_call", n: 1, text: "multi\nline" });
  file.write({ event: "tool_call", n: 2 });
  clock = Date.parse("2026-10-29T00:00:01Z");
  file.write({ event: "tool_call", n: 3 });
  await file.close();

  assert.deepEqual(readdirSync(dir).sort(), [
    "requests-2026-10-28-replica_1.jsonl",
    "requests-2026-10-29-replica_1.jsonl"
  ]);
  assert.deepEqual(readJsonLines(join(dir, "requests-2026-10-28-replica_1.jsonl")), [
    { event: "tool_call", n: 1, text: "multi\nline" },
    { event: "tool_call", n: 2 }
  ]);
  assert.deepEqual(readJsonLines(join(dir, "requests-2026-10-29-replica_1.jsonl")), [{ event: "tool_call", n: 3 }]);
});

test("removes request log files older than the retention period and leaves other files", async (t) => {
  const dir = tempDir(t);
  for (const name of [
    "requests-2026-09-27-old.jsonl",
    "requests-2026-09-28-boundary.jsonl",
    "requests-2026-10-27-recent.jsonl",
    "notes.txt"
  ]) {
    writeFileSync(join(dir, name), "{}\n");
  }
  const file = createRequestLogFile({ dir, retentionDays: 30, host: "h", now: () => Date.parse("2026-10-28T12:00:00Z") });

  file.write({ event: "tool_call" });
  await file.whenCleanupDone();
  await file.close();

  assert.deepEqual(readdirSync(dir).sort(), [
    "notes.txt",
    "requests-2026-09-28-boundary.jsonl",
    "requests-2026-10-27-recent.jsonl",
    "requests-2026-10-28-h.jsonl"
  ]);
});

test("retention 0 keeps every file", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "requests-2020-01-01-h.jsonl"), "{}\n");
  const file = createRequestLogFile({ dir, retentionDays: 0, host: "h", now: () => Date.parse("2026-10-28T12:00:00Z") });
  file.write({ event: "tool_call" });
  await file.whenCleanupDone();
  await file.close();
  assert.ok(readdirSync(dir).includes("requests-2020-01-01-h.jsonl"));
});

test("an unwritable directory reports one error per day and never throws", async (t) => {
  const stderr = silenceStderr(t);
  const root = tempDir(t);
  const blocker = join(root, "not-a-dir");
  writeFileSync(blocker, "");
  const file = createRequestLogFile({ dir: join(blocker, "logs"), host: "h", now: () => Date.parse("2026-10-28T12:00:00Z") });

  file.write({ event: "tool_call" });
  file.write({ event: "tool_call" });
  await file.close();

  const failures = stderr.map((line) => JSON.parse(line)).filter((entry) => entry.event === "file_write_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, "error");
});

// Stand-in for an fs.WriteStream on a volume whose flushes the test controls:
// written bytes stay queued until flush(); end() closes once flushed.
function createFakeStreamFactory() {
  const streams = [];
  const open = (path) => {
    const stream = new EventEmitter();
    Object.assign(stream, {
      path,
      lines: [],
      writableLength: 0,
      ending: false,
      closed: false,
      destroyed: false,
      write(line) {
        this.lines.push(line);
        this.writableLength += Buffer.byteLength(line);
        return true;
      },
      flush() {
        this.writableLength = 0;
        if (this.ending) this.finishClose();
      },
      end() {
        this.ending = true;
        if (this.writableLength === 0) this.finishClose();
      },
      finishClose() {
        if (this.closed) return;
        this.closed = true;
        this.emit("close");
      },
      destroy() {
        this.destroyed = true;
        this.finishClose();
      }
    });
    streams.push(stream);
    return stream;
  };
  return { streams, open };
}

function stderrEvents(lines, event) {
  return lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === event);
}

const ENTRY = { event: "tool_call", pad: "x".repeat(30) };
const ENTRY_BYTES = Buffer.byteLength(`${JSON.stringify(ENTRY)}\n`);

test("a stalled volume drops entries past the buffer cap and reports dropping and resuming once", (t) => {
  const stderr = silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  const file = createRequestLogFile({
    dir: tempDir(t),
    host: "h",
    now: () => Date.parse("2026-10-28T12:00:00Z"),
    maxBufferedBytes: ENTRY_BYTES * 2,
    openStream: open
  });

  for (let i = 0; i < 5; i += 1) file.write(ENTRY);
  const [stream] = streams;
  assert.equal(stream.lines.length, 2, "only entries that fit under the cap are queued");

  const dropping = stderrEvents(stderr, "file_backpressure_dropping");
  assert.equal(dropping.length, 1, "dropping is reported once per stall");
  assert.equal(dropping[0].limit_bytes, ENTRY_BYTES * 2);

  stream.flush();
  file.write(ENTRY);
  assert.equal(stream.lines.length, 3, "writes resume once the queue drains");
  const resumed = stderrEvents(stderr, "file_backpressure_resumed");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].dropped_entries, 3);
});

test("the cap covers a stalled rotated-out stream, so rotation does not grant a fresh budget", (t) => {
  const stderr = silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  let clock = Date.parse("2026-10-28T23:59:59Z");
  const file = createRequestLogFile({
    dir: tempDir(t),
    host: "h",
    now: () => clock,
    maxBufferedBytes: ENTRY_BYTES * 2,
    openStream: open
  });

  file.write(ENTRY);
  file.write(ENTRY);
  clock = Date.parse("2026-10-29T00:00:01Z");
  file.write(ENTRY);
  file.write(ENTRY);
  const [oldStream, newStream] = streams;
  assert.equal(oldStream.closed, false, "the old stream is still flushing");
  assert.equal(newStream.lines.length, 0, "no new entries while the old stream holds the full budget");
  assert.equal(stderrEvents(stderr, "file_backpressure_dropping").length, 1);

  oldStream.flush();
  assert.equal(oldStream.closed, true);
  file.write(ENTRY);
  assert.equal(newStream.lines.length, 1, "budget returns once the old stream closes");
  assert.equal(stderrEvents(stderr, "file_backpressure_resumed")[0].dropped_entries, 2);
});

test("an entry larger than the cap is dropped and reported even when nothing is queued", (t) => {
  const stderr = silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  const file = createRequestLogFile({
    dir: tempDir(t),
    host: "h",
    now: () => Date.parse("2026-10-28T12:00:00Z"),
    maxBufferedBytes: ENTRY_BYTES - 1,
    openStream: open
  });

  file.write(ENTRY);
  assert.equal(streams[0].lines.length, 0);
  const [tooLarge] = stderrEvents(stderr, "file_entry_too_large");
  assert.equal(tooLarge.entry_bytes, ENTRY_BYTES);
  assert.equal(tooLarge.limit_bytes, ENTRY_BYTES - 1);
});

test("an error from a rotated-out stream is reported for its own day without disabling the new stream", (t) => {
  const stderr = silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  let clock = Date.parse("2026-10-28T23:59:59Z");
  const file = createRequestLogFile({ dir: tempDir(t), host: "h", now: () => clock, openStream: open });

  file.write({ n: 1 });
  clock = Date.parse("2026-10-29T00:00:01Z");
  file.write({ n: 2 });
  const [oldStream, newStream] = streams;

  oldStream.emit("error", new Error("flush failed"));
  oldStream.emit("error", new Error("flush failed again"));
  let failures = stderrEvents(stderr, "file_write_failed");
  assert.deepEqual(failures.map((entry) => entry.day), ["2026-10-28"], "reported once, under the old stream's day");
  assert.equal(newStream.destroyed, false);

  file.write({ n: 3 });
  assert.equal(newStream.lines.length, 2, "the replacement stream keeps receiving entries");

  newStream.emit("error", new Error("share offline"));
  failures = stderrEvents(stderr, "file_write_failed");
  assert.deepEqual(failures.map((entry) => entry.day), ["2026-10-28", "2026-10-29"]);
  assert.equal(newStream.destroyed, true);
  file.write({ n: 4 });
  assert.equal(streams.length, 2, "a failed day is not reopened");
});

test("close() reports an error from the closing stream and still resolves", async (t) => {
  const stderr = silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  const file = createRequestLogFile({
    dir: tempDir(t),
    host: "h",
    now: () => Date.parse("2026-10-28T12:00:00Z"),
    openStream: open
  });
  file.write({ n: 1 });
  streams[0].end = function failingEnd() {
    this.emit("error", new Error("final flush failed"));
    this.closed = true;
    this.emit("close");
  };

  await file.close();
  const failures = stderrEvents(stderr, "file_write_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, "final flush failed");
});

test("close() waits for a rotated-out stream that is still flushing", async (t) => {
  silenceStderr(t);
  const { streams, open } = createFakeStreamFactory();
  let clock = Date.parse("2026-10-28T23:59:59Z");
  const file = createRequestLogFile({ dir: tempDir(t), host: "h", now: () => clock, openStream: open });

  file.write({ n: 1 });
  clock = Date.parse("2026-10-29T00:00:01Z");
  file.write({ n: 2 });
  const [oldStream, newStream] = streams;

  let resolved = false;
  const closing = file.close().then(() => {
    resolved = true;
  });
  newStream.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false, "shutdown must not finish while the old day's entries are still queued");

  oldStream.flush();
  await closing;
  assert.equal(oldStream.closed, true);
  assert.equal(newStream.closed, true);
});
