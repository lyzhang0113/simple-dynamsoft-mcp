// Retrieval-quality metrics for the golden query set (test/fixtures/retrieval-golden.json).
// Cases grade relevant documents by public URL (not doc:// URI) so judgments
// survive URI-scheme and index-order changes.

function normalizeUrl(url) {
  return String(url || "").split("#")[0].split("?")[0].replace(/\/index\.html$/i, "/").toLowerCase();
}

function gradeOf(result, relevant) {
  const key = normalizeUrl(result.url);
  if (!key) return 0;
  return relevant.get(key) || 0;
}

function dcg(gains) {
  return gains.reduce((sum, gain, index) => sum + ((2 ** gain) - 1) / Math.log2(index + 2), 0);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function isOffScope(result, testCase) {
  const product = testCase.filters?.product;
  if (product && result.product !== product) return true;
  const prefixes = testCase.allowedUrlPrefixes;
  if (Array.isArray(prefixes) && prefixes.length > 0 && result.url) {
    return !prefixes.some((prefix) => String(result.url).startsWith(prefix));
  }
  return false;
}

function isReleaseNotes(result) {
  return /\/release-notes?\//i.test(String(result.url || ""));
}

function scoreCase(testCase, results, k) {
  const relevant = new Map(
    Object.entries(testCase.relevant || {}).map(([url, grade]) => [normalizeUrl(url), Number(grade) || 0])
  );
  const top = results.slice(0, k);
  const gains = top.map((result) => gradeOf(result, relevant));
  const idealGains = [...relevant.values()].filter((g) => g > 0).sort((a, b) => b - a).slice(0, k);
  const relevantCount = idealGains.length;

  const firstHit = gains.findIndex((gain) => gain > 0);
  const found = new Set(top.filter((result) => gradeOf(result, relevant) > 0).map((r) => normalizeUrl(r.url)));
  const required = [...relevant.entries()].filter(([, grade]) => grade >= 3).map(([url]) => url);
  const requiredFound = required.filter((url) => found.has(url));

  const urls = top.map((result) => normalizeUrl(result.url || result.uri));
  const duplicates = urls.length - new Set(urls).size;

  return {
    id: testCase.id,
    gap: relevantCount === 0,
    recall: relevantCount ? found.size / Math.min(relevantCount, k) : null,
    mrr: relevantCount ? (firstHit >= 0 ? 1 / (firstHit + 1) : 0) : null,
    ndcg: relevantCount ? dcg(gains) / dcg(idealGains) : null,
    requiredHit: required.length ? requiredFound.length === required.length : null,
    requiredMissing: required.filter((url) => !found.has(url)),
    duplicates,
    offScope: top.filter((result) => isOffScope(result, testCase)).length,
    releaseNotes: top.filter(isReleaseNotes).length,
    returned: top.length,
    top: top.map((result, index) => ({
      rank: index + 1,
      grade: gains[index],
      product: result.product,
      title: result.title,
      url: result.url || "",
      uri: result.uri
    }))
  };
}

function mean(values) {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function summarize(caseScores, latencies) {
  const totalReturned = caseScores.reduce((sum, item) => sum + item.returned, 0) || 1;
  const required = caseScores.filter((item) => item.requiredHit !== null);
  return {
    cases: caseScores.length,
    gapCases: caseScores.filter((item) => item.gap).length,
    recallAtK: mean(caseScores.map((item) => item.recall)),
    mrr: mean(caseScores.map((item) => item.mrr)),
    ndcgAtK: mean(caseScores.map((item) => item.ndcg)),
    requiredHitRate: required.length ? required.filter((item) => item.requiredHit).length / required.length : null,
    duplicateRate: caseScores.reduce((sum, item) => sum + item.duplicates, 0) / totalReturned,
    offScopeRate: caseScores.reduce((sum, item) => sum + item.offScope, 0) / totalReturned,
    releaseNotesRate: caseScores.reduce((sum, item) => sum + item.releaseNotes, 0) / totalReturned,
    latencyMs: {
      first: latencies[0] ?? 0,
      p50Warm: percentile(latencies.slice(1), 50),
      p95Warm: percentile(latencies.slice(1), 95)
    }
  };
}

async function runRetrievalEval({ searchResources, cases, k = 5 }) {
  const caseScores = [];
  const latencies = [];
  for (const testCase of cases) {
    const startedAt = performance.now();
    const results = await searchResources({ query: testCase.query, ...(testCase.filters || {}), limit: k });
    const latencyMs = performance.now() - startedAt;
    latencies.push(latencyMs);
    caseScores.push({ ...scoreCase(testCase, results, k), latencyMs });
  }
  return { k, summary: summarize(caseScores, latencies), cases: caseScores };
}

export { normalizeUrl, scoreCase, summarize, runRetrievalEval };
