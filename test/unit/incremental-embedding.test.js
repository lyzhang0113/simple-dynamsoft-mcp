// Guards the credit-saving guarantee end to end through the real provider:
// a rebuild with unchanged chunk text makes no embedding calls, and a rebuild
// after one doc changes embeds only that doc's chunk.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderOrchestrator } from "../../src/rag/providers.js";
import { createVectorCacheHelpers } from "../../src/rag/vector-cache.js";
import * as searchUtils from "../../src/rag/search-utils.js";

async function startStubEmbedder() {
  const stats = { texts: 0 };
  const vector = (text) => {
    const values = new Array(8).fill(0);
    for (let i = 0; i < text.length; i += 1) values[i % 8] += (text.charCodeAt(i) % 7) + 1;
    return values;
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      const payload = json.requests
        ? { embeddings: json.requests.map((r) => { stats.texts += 1; return { values: vector(r.content.parts[0].text) }; }) }
        : (stats.texts += 1, { embedding: { values: vector(json.content.parts[0].text) } });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { stats, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function makeEntries(changedBody = "second body") {
  return [
    { id: "a", uri: "doc://a", type: "doc", product: "dbr", title: "Alpha", summary: "first", tags: [], embedText: "# Alpha\nfirst body" },
    { id: "b", uri: "doc://b", type: "doc", product: "dbr", title: "Beta", summary: "second", tags: [], embedText: `# Beta\n${changedBody}` }
  ];
}

async function buildIndex({ entries, pkgVersion, cacheDir, baseUrl }) {
  const ragConfig = {
    provider: "gemini", fallback: "none", profile: "semantic-gemini", cacheDir, rebuild: false,
    chunkSize: 1200, chunkOverlap: 200, maxChunksPerDoc: 0, maxTextChars: 4000, minScore: 0,
    geminiApiKey: "stub", geminiModel: "models/stub", geminiBaseUrl: baseUrl, geminiBatchSize: 16,
    geminiRetryMaxAttempts: 1, geminiRetryBaseDelayMs: 1, geminiRetryMaxDelayMs: 1, geminiRequestThrottleMs: 0,
    prebuiltIndexAutoDownload: false, prebuiltIndexUrl: "", prebuiltIndexUrlGemini: "", prebuiltIndexTimeoutMs: 1000
  };
  const noop = () => {};
  const orchestrator = createProviderOrchestrator({
    pkgVersion,
    ragConfig,
    ragLogState: { providerReady: new Set() },
    logRag: noop,
    resourceIndex: entries,
    resourceIndexByUri: new Map(entries.map((entry) => [entry.uri, entry])),
    createLexicalProvider: () => ({ search: async () => [] }),
    getRagSignatureData: () => ({ resourceCount: entries.length, docCount: entries.length }),
    utils: {
      ...searchUtils,
      createFuseSearch: () => searchUtils.createFuseSearch(entries),
      attachScore: (entry, score) => ({ ...entry, score }),
      entryMatchesScope: () => true
    },
    vectorCache: createVectorCacheHelpers({ ragConfig, pkgVersion, legacyPrebuiltIndexUrl: "", logRag: noop })
  });
  const provider = await orchestrator.loadSearchProvider("gemini");
  await provider.search("alpha", {}, 5);
}

test("rebuilds embed only chunks whose text changed", async () => {
  const stub = await startStubEmbedder();
  const cacheDir = mkdtempSync(join(tmpdir(), "incremental-embed-"));
  try {
    await buildIndex({ entries: makeEntries(), pkgVersion: "1.0.0", cacheDir, baseUrl: stub.url });
    // Each build also embeds the one search query used to load it.
    const QUERY = 1;
    const firstBuild = stub.stats.texts;
    assert.equal(firstBuild - QUERY, 2, "first build embeds every chunk");

    // New package version, identical content: nothing to embed.
    await buildIndex({ entries: makeEntries(), pkgVersion: "1.0.1", cacheDir, baseUrl: stub.url });
    assert.equal(stub.stats.texts - firstBuild - QUERY, 0, "version-only rebuild embeds no chunks");

    // One doc's text changes: only its chunk is embedded.
    const before = stub.stats.texts;
    await buildIndex({ entries: makeEntries("second body, edited"), pkgVersion: "1.0.2", cacheDir, baseUrl: stub.url });
    assert.equal(stub.stats.texts - before - QUERY, 1, "only the edited chunk is embedded");
  } finally {
    await stub.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
