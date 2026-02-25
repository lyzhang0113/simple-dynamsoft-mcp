import { ragConfig } from "./config.js";
import {
  resourceIndex,
  normalizeSearchFilters,
  entryMatchesScope,
  normalizeText
} from "./search-utils.js";
import { resolveProviderChain, loadSearchProvider } from "./providers.js";
import {
  logRag,
  logRagConfigOnce,
  logProviderChainOnce,
  logProviderSelectedOnce,
  logFallbackSelectedOnce
} from "./logger.js";

async function searchResources({ query, product, edition, platform, type, limit }) {
  const filters = normalizeSearchFilters({ product, edition, platform, type });
  const searchQuery = query ? String(query).trim() : "";
  const maxResults = limit ? Math.min(limit, 50) : undefined;

  if (!searchQuery) {
    const results = resourceIndex.filter((entry) => entryMatchesScope(entry, filters));
    return maxResults ? results.slice(0, maxResults) : results;
  }

  logRagConfigOnce(ragConfig);
  const providers = resolveProviderChain();
  logProviderChainOnce(providers);
  let lastError = null;

  for (const name of providers) {
    try {
      const provider = await loadSearchProvider(name);
      const results = await provider.search(searchQuery, filters, maxResults);
      logProviderSelectedOnce(name);
      if (name !== providers[0]) {
        logFallbackSelectedOnce(name, providers[0]);
      }
      return results;
    } catch (error) {
      lastError = error;
      console.error(`[rag] provider "${name}" failed: ${error.message}`);
    }
  }

  if (lastError) {
    console.error(`[rag] all providers failed: ${lastError.message}`);
  }
  return [];
}

async function prewarmRagIndex() {
  if (!ragConfig.prewarm) return;
  logRagConfigOnce(ragConfig);
  const providers = resolveProviderChain();
  const primary = providers[0];
  if (!primary || primary === "fuse") return;
  try {
    logRag(`prewarm start provider=${primary}`);
    const provider = await loadSearchProvider(primary);
    if (provider.warm) {
      await provider.warm();
    }
    logRag(`prewarm done provider=${primary}`);
  } catch (error) {
    console.error(`[rag] prewarm failed: ${error.message}`);
  }
}

async function getSampleSuggestions({ query, product, edition, platform, limit = 5 }) {
  const scope = normalizeSearchFilters({ product, edition, platform, type: "sample" });
  const searchQuery = query ? String(query).trim() : "";
  const maxResults = Math.min(limit || 5, 10);

  if (searchQuery) {
    const results = await searchResources({
      query: searchQuery,
      product: scope.product,
      edition: scope.edition,
      platform: scope.platform,
      type: "sample",
      limit: maxResults
    });
    if (results.length) return results;
  }

  let candidates = resourceIndex.filter((entry) => entryMatchesScope(entry, scope));
  if (candidates.length === 0 && scope.product) {
    candidates = resourceIndex.filter((entry) => entry.type === "sample" && entry.product === scope.product);
  }

  if (searchQuery && candidates.length > 1) {
    const terms = normalizeText(searchQuery.toLowerCase()).split(/\s+/).filter(Boolean);
    const scoreEntry = (entry) => {
      const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()) : [];
      const haystack = [
        String(entry.title || "").toLowerCase(),
        String(entry.summary || "").toLowerCase(),
        tags.join(" ")
      ].join(" ");
      let score = 0;
      for (const term of terms) {
        if (!term) continue;
        if (tags.some((tag) => tag === term || tag.includes(term))) score += 3;
        if (haystack.includes(term)) score += 1;
      }
      return score;
    };
    candidates = [...candidates].sort((a, b) => {
      const delta = scoreEntry(b) - scoreEntry(a);
      if (delta !== 0) return delta;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
  }

  const seen = new Set();
  const results = [];
  for (const entry of candidates) {
    if (seen.has(entry.uri)) continue;
    seen.add(entry.uri);
    results.push(entry);
    if (results.length >= maxResults) break;
  }

  return results;
}

export {
  ragConfig,
  searchResources,
  getSampleSuggestions,
  prewarmRagIndex
};
