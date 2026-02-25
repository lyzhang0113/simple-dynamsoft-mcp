import { ragConfig } from "./config.js";
import { logProviderReadyOnce } from "./logger.js";
import { fuseSearch, entryMatchesScope, attachScore } from "./search-utils.js";
import { createVectorProvider } from "./vector-cache.js";
import { getLocalEmbedder, getGeminiEmbedder } from "./embedders.js";

function createFuseProvider() {
  return {
    name: "fuse",
    search: async (query, filters, limit) => {
      const results = [];
      for (const result of fuseSearch.search(query)) {
        const entry = result.item;
        if (!entryMatchesScope(entry, filters)) continue;
        const score = Number.isFinite(result.score) ? Math.max(0, 1 - result.score) : undefined;
        results.push(attachScore(entry, score));
      }
      if (limit) return results.slice(0, limit);
      return results;
    },
    warm: async () => {}
  };
}

function resolveProviderChain() {
  let primary = ragConfig.provider;
  if (primary === "auto") {
    primary = ragConfig.geminiApiKey ? "gemini" : "local";
  }
  const chain = [primary];
  if (ragConfig.fallback && ragConfig.fallback !== "none" && ragConfig.fallback !== primary) {
    chain.push(ragConfig.fallback);
  }
  return Array.from(new Set(chain));
}

const providerCache = new Map();

async function loadSearchProvider(name) {
  if (providerCache.has(name)) return providerCache.get(name);
  let providerPromise;
  if (name === "fuse") {
    providerPromise = Promise.resolve(createFuseProvider());
  } else if (name === "local") {
    providerPromise = (async () => {
      const embedder = await getLocalEmbedder();
      return createVectorProvider({
        name: "local",
        model: ragConfig.localModel,
        embedder,
        batchSize: 1
      });
    })();
  } else if (name === "gemini") {
    providerPromise = (async () => {
      const embedder = await getGeminiEmbedder();
      return createVectorProvider({
        name: "gemini",
        model: ragConfig.geminiModel,
        embedder,
        batchSize: Math.max(1, ragConfig.geminiBatchSize)
      });
    })();
  } else {
    providerPromise = Promise.reject(new Error(`Unknown search provider: ${name}`));
  }

  logProviderReadyOnce(name);
  providerCache.set(name, providerPromise);
  return providerPromise;
}

export {
  resolveProviderChain,
  loadSearchProvider
};
