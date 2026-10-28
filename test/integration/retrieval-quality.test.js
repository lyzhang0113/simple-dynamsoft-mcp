// Retrieval-quality gate on the real, pinned docs with the lexical provider.
// Floors sit below current golden-set scores (see scripts/eval-retrieval.mjs)
// so routine doc refreshes pass, while losing shared-API coverage or
// reintroducing duplicate/off-scope hits fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.MCP_DATA_DIR ||= join(projectRoot, "data");
process.env.MCP_DATA_AUTO_DOWNLOAD = "false";
process.env.MCP_DATA_REFRESH_ON_START = "false";
process.env.RAG_PROVIDER = "lexical";
process.env.RAG_FALLBACK = "none";
process.env.RAG_PREWARM = "false";

const { ensureResourceIndexReady, resourceIndex, readResourceContent } = await import("../../src/server/resource-index.js");
const { searchResources } = await import("../../src/rag/index.js");
const { runRetrievalEval } = await import("../../scripts/lib/retrieval-eval.mjs");
const { isResultInScope } = await import("../../scripts/lib/scope-matcher.mjs");

const golden = JSON.parse(readFileSync(join(projectRoot, "test", "fixtures", "retrieval-golden.json"), "utf8"));
ensureResourceIndexReady();

const FLOORS = {
  recallAtK: 0.4,
  mrr: 0.33,
  requiredHitRate: 0.36
};

test("golden-set retrieval quality stays above floors (lexical)", async () => {
  const { summary, cases } = await runRetrievalEval({ searchResources, cases: golden.cases, k: golden.k, isInScope: isResultInScope });
  const report = cases.map((item) => `${item.id}: recall=${item.recall} mrr=${item.mrr}`).join("\n");
  for (const [metric, floor] of Object.entries(FLOORS)) {
    assert.ok(summary[metric] >= floor, `${metric}=${summary[metric]} < ${floor}\n${report}`);
  }
  assert.equal(summary.duplicateRate, 0, "no public URL may appear twice in one result list");
  assert.equal(summary.offScopeRate, 0, "filtered searches must not leak other products");
});

test("every resource has a unique URI", () => {
  const uris = resourceIndex.map((entry) => entry.uri);
  assert.equal(new Set(uris).size, uris.length);
});

test("shared Capture Vision APIs are indexed under DBR scope and readable", async () => {
  const targets = [
    ["web", "web", "https://www.dynamsoft.com/capture-vision/docs/web/programming/javascript/api-reference/capture-vision-router/single-image-processing.html"],
    ["web", "web", "https://www.dynamsoft.com/capture-vision/docs/web/programming/javascript/api-reference/capture-vision-router/settings.html"],
    ["mobile", "android", "https://www.dynamsoft.com/capture-vision/docs/mobile/programming/android/api-reference/capture-vision-router/settings.html"]
  ];
  for (const [edition, platform, url] of targets) {
    const entry = resourceIndex.find((item) => item.url === url && item.product === "dbr" && item.edition === edition);
    assert.ok(entry, `missing shared page ${url}`);
    assert.equal(entry.platform, platform);
    assert.match(entry.uri, new RegExp(`^doc://dbr/${edition}/${platform}/[^/]+/dcv/`));
    const content = await readResourceContent(entry.uri);
    assert.ok(content?.text?.includes(url), `read_document content for ${entry.uri} should cite ${url}`);
  }

  const redirectStub = resourceIndex.find((item) => item.url === "https://www.dynamsoft.com/barcode-reader/docs/web/programming/javascript/api-reference/capture-vision-router.html");
  assert.equal(redirectStub, undefined, "DBR redirect stub must not be indexed");
});
