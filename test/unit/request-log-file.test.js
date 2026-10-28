import assert from "node:assert/strict";
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
