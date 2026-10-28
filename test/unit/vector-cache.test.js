import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVectorCacheHelpers } from "../../src/rag/vector-cache.js";

function withHelpers(fn) {
  const cacheDir = mkdtempSync(join(tmpdir(), "vector-cache-"));
  try {
    const helpers = createVectorCacheHelpers({
      ragConfig: { cacheDir, prebuiltIndexAutoDownload: false },
      pkgVersion: "0.0.0",
      legacyPrebuiltIndexUrl: "",
      logRag: () => {}
    });
    return fn(helpers, cacheDir);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

const payload = {
  cacheKey: "key-1",
  meta: { provider: "gemini", model: "m", signature: "sig" },
  items: [{ id: "a#0", uri: "doc://a" }, { id: "b#0", uri: "doc://b" }],
  vectors: [[0.6, 0.8, 0], [0, 0.25, -1.5]]
};

test("cache round-trips items and vectors through header + float32 files", () => {
  withHelpers((helpers, cacheDir) => {
    const cacheFile = join(cacheDir, "rag-gemini-m-key.json");
    helpers.saveVectorIndexCache(cacheFile, payload);
    assert.ok(existsSync(cacheFile.replace(/\.json$/, ".f32")));

    const loaded = helpers.loadVectorIndexCache(cacheFile, { cacheKey: "key-1", signature: "sig", provider: "gemini", model: "m" });
    assert.equal(loaded.hit, true);
    assert.deepEqual(loaded.payload.items, payload.items);
    assert.deepEqual(loaded.payload.vectors.map((vector) => Array.from(vector)), [[0.6000000238418579, 0.800000011920929, 0], [0, 0.25, -1.5]]);

    assert.equal(helpers.loadVectorIndexCache(cacheFile, { signature: "other" }).reason, "signature_mismatch");
  });
});

test("cache with a truncated or missing vector file is rejected", () => {
  withHelpers((helpers, cacheDir) => {
    const cacheFile = join(cacheDir, "rag-gemini-m-key.json");
    helpers.saveVectorIndexCache(cacheFile, payload);
    writeFileSync(cacheFile.replace(/\.json$/, ".f32"), Buffer.alloc(8));
    assert.equal(helpers.loadVectorIndexCache(cacheFile).reason, "vectors_size_mismatch");

    rmSync(cacheFile.replace(/\.json$/, ".f32"));
    assert.equal(helpers.loadVectorIndexCache(cacheFile).reason, "vectors_missing");
  });
});

test("checkpoint resumes partial vectors and clearing removes both files", () => {
  withHelpers((helpers, cacheDir) => {
    const checkpointFile = join(cacheDir, "rag-gemini-m-key.checkpoint.json");
    helpers.saveVectorIndexCheckpoint(checkpointFile, { ...payload, vectors: payload.vectors.slice(0, 1) });

    const resumed = helpers.loadVectorIndexCheckpoint(checkpointFile, "key-1", payload.items);
    assert.equal(resumed.hit, true);
    assert.equal(resumed.payload.vectors.length, 1);
    assert.equal(helpers.loadVectorIndexCheckpoint(checkpointFile, "key-1", payload.items.slice(1)).reason, "items_length_mismatch");

    helpers.clearVectorIndexCheckpoint(checkpointFile);
    assert.equal(existsSync(checkpointFile), false);
    assert.equal(existsSync(checkpointFile.replace(/\.json$/, ".f32")), false);
  });
});
