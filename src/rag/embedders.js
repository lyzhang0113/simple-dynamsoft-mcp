import {
  sleepMs,
  parseRetryAfterMs,
  normalizeGeminiRetryConfig,
  GeminiHttpError,
  executeWithGeminiRetry
} from "./gemini-retry.js";
import { ragConfig } from "./config.js";
import { logRag, markLocalEmbedderInit } from "./logger.js";
import { ensureDirectory } from "./vector-cache.js";

let localEmbedderPromise = null;
async function getLocalEmbedder() {
  if (localEmbedderPromise) return localEmbedderPromise;
  localEmbedderPromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    ensureDirectory(ragConfig.modelCacheDir);
    if (markLocalEmbedderInit()) {
      logRag(
        `init local embedder model=${ragConfig.localModel} quantized=${ragConfig.localQuantized} model_cache_dir=${ragConfig.modelCacheDir}`
      );
    }
    env.cacheDir = ragConfig.modelCacheDir;
    env.allowLocalModels = true;
    const extractor = await pipeline("feature-extraction", ragConfig.localModel, {
      quantized: ragConfig.localQuantized
    });
    return {
      embed: async (text) => {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        return Array.from(output.data);
      }
    };
  })();
  return localEmbedderPromise;
}

let geminiEmbedderPromise = null;
async function getGeminiEmbedder() {
  if (!ragConfig.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for gemini embeddings.");
  }
  if (geminiEmbedderPromise) return geminiEmbedderPromise;
  const retryConfig = normalizeGeminiRetryConfig({
    maxAttempts: ragConfig.geminiRetryMaxAttempts,
    baseDelayMs: ragConfig.geminiRetryBaseDelayMs,
    maxDelayMs: ragConfig.geminiRetryMaxDelayMs,
    requestThrottleMs: ragConfig.geminiRequestThrottleMs
  });

  geminiEmbedderPromise = Promise.resolve((() => {
    const metrics = {
      requests: 0,
      retries: 0,
      retryDelayMs: 0,
      throttleEvents: 0,
      throttleDelayMs: 0,
      rateLimitRetries: 0
    };

    let nextAllowedAt = 0;

    const throttleRequest = async (operation) => {
      if (retryConfig.requestThrottleMs <= 0) return;
      const now = Date.now();
      const waitMs = Math.max(0, nextAllowedAt - now);
      if (waitMs > 0) {
        metrics.throttleEvents += 1;
        metrics.throttleDelayMs += waitMs;
        logRag(`gemini throttle op=${operation} wait_ms=${waitMs}`);
        await sleepMs(waitMs);
      }
      nextAllowedAt = Date.now() + retryConfig.requestThrottleMs;
    };

    const requestJson = async (operation, endpoint, body) => executeWithGeminiRetry({
      operation,
      retryConfig,
      logger: (message) => logRag(message),
      onRetry: ({ delayMs, rateLimited }) => {
        metrics.retries += 1;
        metrics.retryDelayMs += delayMs;
        if (rateLimited) {
          metrics.rateLimitRetries += 1;
        }
      },
      requestFn: async () => {
        await throttleRequest(operation);
        metrics.requests += 1;
        const response = await fetch(
          `${ragConfig.geminiBaseUrl}/v1beta/${endpoint}?key=${ragConfig.geminiApiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );
        if (!response.ok) {
          const detail = await response.text();
          throw new GeminiHttpError(`Gemini ${operation} failed (${response.status}): ${detail}`, {
            status: response.status,
            detail,
            retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))
          });
        }
        return response.json();
      }
    });

    return {
      embed: async (text) => {
        const payload = await requestJson(
          "embedContent",
          `${ragConfig.geminiModel}:embedContent`,
          {
            content: {
              parts: [{ text }]
            }
          }
        );
        const embedding = payload.embedding?.values || payload.embedding || payload.embeddings?.[0]?.values;
        if (!embedding) {
          throw new Error("Gemini embedding response missing embedding values.");
        }
        return embedding;
      },
      embedBatch: async (texts) => {
        const payload = await requestJson(
          "batchEmbedContents",
          `${ragConfig.geminiModel}:batchEmbedContents`,
          {
            requests: texts.map((text) => ({
              model: ragConfig.geminiModel,
              content: {
                parts: [{ text }]
              }
            }))
          }
        );
        const embeddings = payload.embeddings || payload.responses;
        if (!Array.isArray(embeddings)) {
          throw new Error("Gemini batch response missing embeddings.");
        }
        return embeddings.map((item) => item.values || item.embedding?.values || item.embedding);
      },
      getMetrics: () => ({ ...metrics }),
      resetMetrics: () => {
        metrics.requests = 0;
        metrics.retries = 0;
        metrics.retryDelayMs = 0;
        metrics.throttleEvents = 0;
        metrics.throttleDelayMs = 0;
        metrics.rateLimitRetries = 0;
      }
    };
  })());
  return geminiEmbedderPromise;
}

export {
  getLocalEmbedder,
  getGeminiEmbedder
};
