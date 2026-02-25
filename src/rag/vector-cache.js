import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import * as tar from "tar";
import { isRateLimitGeminiStatus } from "./gemini-retry.js";
import { ragConfig, pkgVersion, legacyPrebuiltIndexUrl } from "./config.js";
import { logRag } from "./logger.js";
import {
  resourceIndexByUri,
  attachScore,
  entryMatchesScope,
  normalizeText,
  truncateText,
  buildEmbeddingItems,
  buildIndexSignature
} from "./search-utils.js";

const prebuiltDownloadAttempts = new Map();

function ensureDirectory(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function makeCacheFileName(provider, model, cacheKey) {
  const safeModel = String(model || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32);
  return `rag-${provider}-${safeModel}-${cacheKey.slice(0, 12)}.json`;
}

function makeCheckpointFileName(provider, model, cacheKey) {
  const safeModel = String(model || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32);
  return `rag-${provider}-${safeModel}-${cacheKey.slice(0, 12)}.checkpoint.json`;
}

function loadVectorIndexCache(
  cacheFile,
  { cacheKey, signature, provider, model, requireSignature = false } = {}
) {
  if (!existsSync(cacheFile)) {
    return { hit: false, reason: "missing", payload: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (!parsed || (cacheKey && parsed.cacheKey !== cacheKey)) {
      return { hit: false, reason: "cache_key_mismatch", payload: null };
    }
    if (!Array.isArray(parsed.items) || !Array.isArray(parsed.vectors)) {
      return { hit: false, reason: "invalid_payload", payload: null };
    }
    const meta = parsed.meta || {};
    if (provider && meta.provider && meta.provider !== provider) {
      return { hit: false, reason: "provider_mismatch", payload: null };
    }
    if (model && meta.model && meta.model !== model) {
      return { hit: false, reason: "model_mismatch", payload: null };
    }
    if (signature) {
      if (!meta.signature) {
        if (requireSignature) {
          return { hit: false, reason: "missing_signature", payload: null };
        }
      } else if (meta.signature !== signature) {
        return { hit: false, reason: "signature_mismatch", payload: null };
      }
    }
    return { hit: true, reason: "ok", payload: parsed };
  } catch {
    return { hit: false, reason: "parse_error", payload: null };
  }
}

function listFilesRecursive(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function readSignaturePackageVersion(signatureRaw) {
  if (!signatureRaw) return "";
  try {
    const parsed = JSON.parse(signatureRaw);
    return String(parsed?.packageVersion || "");
  } catch {
    return "";
  }
}

function listDownloadedCacheCandidatesByProvider(extractRoot, expectedCacheFileName, cacheKey, provider) {
  const allFiles = listFilesRecursive(extractRoot).filter((path) => path.toLowerCase().endsWith(".json")).sort();
  const expectedPath = allFiles.find((path) => basename(path) === expectedCacheFileName);

  const cachePrefix = cacheKey.slice(0, 12);
  const prefixPath = allFiles.find((path) => {
    const name = basename(path);
    return name.startsWith(`rag-${provider}-`) && name.endsWith(`-${cachePrefix}.json`);
  });

  const providerFiles = allFiles.filter((path) => basename(path).startsWith(`rag-${provider}-`));
  const unique = [];
  for (const path of [expectedPath, prefixPath, ...providerFiles]) {
    if (!path) continue;
    if (!unique.includes(path)) unique.push(path);
  }
  return unique;
}

function resolvePrebuiltIndexUrlCandidates(provider) {
  const override = String(ragConfig.prebuiltIndexUrl || "").trim();
  if (override) return [override];

  const candidates = [];
  if (provider === "local") {
    candidates.push(String(ragConfig.prebuiltIndexUrlLocal || "").trim());
  } else if (provider === "gemini") {
    candidates.push(String(ragConfig.prebuiltIndexUrlGemini || "").trim());
  }
  candidates.push(legacyPrebuiltIndexUrl);

  const deduped = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!deduped.includes(candidate)) deduped.push(candidate);
  }
  return deduped;
}

async function downloadPrebuiltArchive(url, outputPath, timeoutMs) {
  const source = String(url || "").trim();
  if (!source) {
    throw new Error("prebuilt URL is empty");
  }

  if (source.startsWith("file://")) {
    copyFileSync(fileURLToPath(source), outputPath);
    return { sourceType: "file", size: statSync(outputPath).size };
  }

  if (!/^https?:\/\//i.test(source)) {
    copyFileSync(resolve(source), outputPath);
    return { sourceType: "file", size: statSync(outputPath).size };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    writeFileSync(outputPath, Buffer.from(arrayBuffer));
    return { sourceType: "http", size: arrayBuffer.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

async function maybeDownloadPrebuiltVectorIndex({ provider, model, cacheKey, signature, cacheFile }) {
  if (!["local", "gemini"].includes(provider)) {
    return { downloaded: false, reason: "provider_not_supported" };
  }
  if (!ragConfig.prebuiltIndexAutoDownload) {
    return { downloaded: false, reason: "auto_download_disabled" };
  }

  const sourceUrls = resolvePrebuiltIndexUrlCandidates(provider);
  if (sourceUrls.length === 0) {
    return { downloaded: false, reason: "url_not_set" };
  }

  const attemptKey = `${provider}:${cacheKey}:${sourceUrls.join("|")}`;
  if (prebuiltDownloadAttempts.has(attemptKey)) {
    return prebuiltDownloadAttempts.get(attemptKey);
  }

  const expectedCacheFileName = makeCacheFileName(provider, model, cacheKey);
  const attempt = (async () => {
    let lastReason = "not_attempted";
    for (const sourceUrl of sourceUrls) {
      const tempRoot = join(
        tmpdir(),
        `simple-dynamsoft-mcp-rag-prebuilt-${Date.now()}-${Math.random().toString(16).slice(2)}`
      );
      const archivePath = join(tempRoot, "prebuilt-rag-index.tar.gz");
      const extractRoot = join(tempRoot, "extract");

      ensureDirectory(extractRoot);
      try {
        logRag(
          `prebuilt index download start provider=${provider} url=${sourceUrl} timeout_ms=${ragConfig.prebuiltIndexTimeoutMs}`
        );
        const downloaded = await downloadPrebuiltArchive(sourceUrl, archivePath, ragConfig.prebuiltIndexTimeoutMs);
        logRag(
          `prebuilt index downloaded provider=${provider} source=${downloaded.sourceType} size=${downloaded.size}B url=${sourceUrl}`
        );

        await tar.x({
          file: archivePath,
          cwd: extractRoot,
          strict: true
        });

        const candidateFiles = listDownloadedCacheCandidatesByProvider(
          extractRoot,
          expectedCacheFileName,
          cacheKey,
          provider
        );
        if (candidateFiles.length === 0) {
          throw new Error(`cache_file_not_found expected=${expectedCacheFileName}`);
        }

        for (const sourceCacheFile of candidateFiles) {
          const candidateCache = loadVectorIndexCache(sourceCacheFile, {
            provider,
            model
          });
          if (!candidateCache.hit) {
            continue;
          }

          const cachePackageVersion = readSignaturePackageVersion(candidateCache.payload?.meta?.signature);
          if (!cachePackageVersion || cachePackageVersion !== pkgVersion) {
            continue;
          }

          const migratedPayload = {
            ...candidateCache.payload,
            cacheKey,
            meta: {
              ...(candidateCache.payload.meta || {}),
              provider,
              model,
              signature
            }
          };
          saveVectorIndexCache(cacheFile, migratedPayload);
          logRag(
            `prebuilt index installed provider=${provider} cache_file=${cacheFile} source=${basename(sourceCacheFile)} mode=version_only_compat version=${cachePackageVersion}`
          );
          return { downloaded: true, reason: "installed_version_only_compat" };
        }

        throw new Error(
          `no_compatible_cache expected=${expectedCacheFileName} found=${candidateFiles.map((path) => basename(path)).join(",")}`
        );
      } catch (error) {
        lastReason = `${sourceUrl} => ${error.message}`;
        logRag(`prebuilt index unavailable provider=${provider} url=${sourceUrl} reason=${error.message}`);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
    return { downloaded: false, reason: lastReason };
  })();

  prebuiltDownloadAttempts.set(attemptKey, attempt);
  return attempt;
}

function saveVectorIndexCache(cacheFile, payload) {
  ensureDirectory(ragConfig.cacheDir);
  writeFileSync(cacheFile, JSON.stringify(payload));
}

function loadVectorIndexCheckpoint(checkpointFile, expectedKey, expectedItems) {
  if (!existsSync(checkpointFile)) {
    return { hit: false, reason: "missing", payload: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(checkpointFile, "utf8"));
    if (!parsed || parsed.cacheKey !== expectedKey) {
      return { hit: false, reason: "cache_key_mismatch", payload: null };
    }
    if (!Array.isArray(parsed.items) || !Array.isArray(parsed.vectors)) {
      return { hit: false, reason: "invalid_payload", payload: null };
    }
    if (parsed.items.length !== expectedItems.length) {
      return { hit: false, reason: "items_length_mismatch", payload: null };
    }
    for (let i = 0; i < expectedItems.length; i += 1) {
      if (parsed.items[i]?.id !== expectedItems[i]?.id || parsed.items[i]?.uri !== expectedItems[i]?.uri) {
        return { hit: false, reason: "items_mismatch", payload: null };
      }
    }
    if (parsed.vectors.length > expectedItems.length) {
      return { hit: false, reason: "vectors_overflow", payload: null };
    }
    return { hit: true, reason: "ok", payload: parsed };
  } catch {
    return { hit: false, reason: "parse_error", payload: null };
  }
}

function saveVectorIndexCheckpoint(checkpointFile, payload) {
  ensureDirectory(ragConfig.cacheDir);
  writeFileSync(checkpointFile, JSON.stringify(payload));
}

function clearVectorIndexCheckpoint(checkpointFile) {
  if (existsSync(checkpointFile)) {
    rmSync(checkpointFile, { force: true });
  }
}

function normalizeVector(vector) {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!norm) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

function dotProduct(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function isRateLimitError(error) {
  if (error?.rateLimited) return true;
  const status = Number(error?.status);
  return isRateLimitGeminiStatus(status);
}

async function embedTextsWithProgress(
  texts,
  embedder,
  batchSize = 1,
  {
    offset = 0,
    total = texts.length,
    onChunk = null,
    providerName = ""
  } = {}
) {
  const results = [];
  const normalizedBatchSize = Math.max(1, batchSize);
  let completed = offset;
  let currentBatchSize = normalizedBatchSize;
  let rateLimitFailures = 0;
  let batchDowngrades = 0;
  let singleFallbackBatches = 0;

  const reportChunk = async (vectors, mode, sourceBatchSize) => {
    if (!Array.isArray(vectors) || vectors.length === 0) return;
    completed += vectors.length;
    if (onChunk) {
      await onChunk({
        vectors,
        mode,
        sourceBatchSize,
        completed,
        total
      });
    }
  };

  if (embedder.embedBatch && normalizedBatchSize > 1) {
    let index = 0;
    while (index < texts.length) {
      const batch = texts.slice(index, index + currentBatchSize);
      try {
        const vectors = await embedder.embedBatch(batch);
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
          throw new Error(`Gemini batch response size mismatch expected=${batch.length} actual=${vectors?.length || 0}`);
        }
        results.push(...vectors);
        index += batch.length;
        rateLimitFailures = 0;
        await reportChunk(vectors, "batch", batch.length);
      } catch (error) {
        if (isRateLimitError(error)) {
          rateLimitFailures += 1;
          const nextBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
          if (nextBatchSize < currentBatchSize) {
            batchDowngrades += 1;
            logRag(
              `gemini batch downgrade provider=${providerName || "unknown"} from=${currentBatchSize} to=${nextBatchSize} ` +
              `rate_limit_failures=${rateLimitFailures}`
            );
            currentBatchSize = nextBatchSize;
            continue;
          }
        }

        singleFallbackBatches += 1;
        logRag(
          `batch embedding fallback provider=${providerName || "unknown"} batch_size=${batch.length} reason=${error.message}`
        );
        for (const text of batch) {
          const vector = await embedder.embed(text);
          results.push(vector);
          await reportChunk([vector], "single_fallback", 1);
        }
        index += batch.length;
        rateLimitFailures = 0;
      }
    }

    return {
      vectors: results,
      stats: {
        batchDowngrades,
        singleFallbackBatches,
        finalBatchSize: currentBatchSize
      }
    };
  }

  for (const text of texts) {
    const vector = await embedder.embed(text);
    results.push(vector);
    await reportChunk([vector], "single", 1);
  }

  return {
    vectors: results,
    stats: {
      batchDowngrades,
      singleFallbackBatches,
      finalBatchSize: 1
    }
  };
}

async function createVectorProvider({ name, model, embedder, batchSize }) {
  const signature = buildIndexSignature();
  const cacheMeta = {
    provider: name,
    model,
    signature
  };
  const cacheKey = createHash("sha256").update(JSON.stringify(cacheMeta)).digest("hex");
  const cacheFile = join(ragConfig.cacheDir, makeCacheFileName(name, model, cacheKey));
  const checkpointFile = join(ragConfig.cacheDir, makeCheckpointFileName(name, model, cacheKey));
  const expectedCacheState = {
    cacheKey,
    signature,
    provider: name,
    model
  };
  logRag(
    `provider=${name} cache_file=${cacheFile} rebuild=${ragConfig.rebuild} cache_key=${cacheKey.slice(0, 12)}`
  );

  let indexPromise = null;
  const loadIndex = async () => {
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
      if (!ragConfig.rebuild) {
        let cacheState = loadVectorIndexCache(cacheFile, expectedCacheState);
        if (cacheState.hit) {
          const cached = cacheState.payload;
          logRag(
            `cache hit provider=${name} file=${cacheFile} items=${cached.items.length} vectors=${cached.vectors.length}`
          );
          return {
            items: cached.items,
            vectors: cached.vectors
          };
        }
        logRag(`cache miss provider=${name} file=${cacheFile} reason=${cacheState.reason}`);

        const downloadResult = await maybeDownloadPrebuiltVectorIndex({
          provider: name,
          model,
          cacheKey,
          signature,
          cacheFile
        });
        if (downloadResult.downloaded) {
          cacheState = loadVectorIndexCache(cacheFile, expectedCacheState);
          if (cacheState.hit) {
            const cached = cacheState.payload;
            logRag(
              `cache hit provider=${name} file=${cacheFile} source=prebuilt_download items=${cached.items.length} vectors=${cached.vectors.length}`
            );
            return {
              items: cached.items,
              vectors: cached.vectors
            };
          }
          logRag(`cache miss provider=${name} file=${cacheFile} source=prebuilt_download reason=${cacheState.reason}`);
        }
      } else {
        logRag(`cache bypass provider=${name} file=${cacheFile} reason=rebuild_true`);
        clearVectorIndexCheckpoint(checkpointFile);
      }

      const items = buildEmbeddingItems();
      const texts = items.map((item) => item.text);
      const indexedItems = items.map((item) => ({ id: item.id, uri: item.uri }));
      let normalized = [];
      let resumeFrom = 0;
      if (!ragConfig.rebuild) {
        const checkpointState = loadVectorIndexCheckpoint(checkpointFile, cacheKey, indexedItems);
        if (checkpointState.hit) {
          normalized = checkpointState.payload.vectors;
          resumeFrom = normalized.length;
          logRag(
            `checkpoint resume provider=${name} file=${checkpointFile} completed=${resumeFrom}/${texts.length}`
          );
        } else if (checkpointState.reason !== "missing") {
          logRag(`checkpoint ignored provider=${name} file=${checkpointFile} reason=${checkpointState.reason}`);
        }
      }

      if (name === "gemini" && embedder.resetMetrics) {
        embedder.resetMetrics();
      }

      const checkpointIntervalMs = 5000;
      let lastCheckpointAt = 0;
      const persistCheckpoint = (force = false) => {
        const now = Date.now();
        if (!force && now - lastCheckpointAt < checkpointIntervalMs) return;
        const payload = {
          cacheKey,
          meta: cacheMeta,
          items: indexedItems,
          vectors: normalized,
          completed: normalized.length,
          total: texts.length,
          updatedAt: new Date().toISOString()
        };
        saveVectorIndexCheckpoint(checkpointFile, payload);
        lastCheckpointAt = now;
      };

      if (resumeFrom < texts.length) {
        logRag(
          `building index provider=${name} embed_items=${texts.length} remaining=${texts.length - resumeFrom} batch_size=${batchSize}`
        );
        try {
          const embeddingResult = await embedTextsWithProgress(
            texts.slice(resumeFrom),
            embedder,
            batchSize,
            {
              offset: resumeFrom,
              total: texts.length,
              providerName: name,
              onChunk: ({ vectors, completed, total }) => {
                normalized.push(...vectors.map(normalizeVector));
                persistCheckpoint(completed >= total);
              }
            }
          );

          if (name === "gemini") {
            const metrics = embedder.getMetrics ? embedder.getMetrics() : {};
            logRag(
              `gemini build metrics provider=${name} requests=${metrics.requests || 0} retries=${metrics.retries || 0} ` +
              `retry_delay_ms=${metrics.retryDelayMs || 0} throttle_events=${metrics.throttleEvents || 0} ` +
              `throttle_delay_ms=${metrics.throttleDelayMs || 0} rate_limit_retries=${metrics.rateLimitRetries || 0} ` +
              `batch_downgrades=${embeddingResult.stats.batchDowngrades} single_fallback_batches=${embeddingResult.stats.singleFallbackBatches} ` +
              `final_batch_size=${embeddingResult.stats.finalBatchSize}`
            );
          }
        } catch (error) {
          persistCheckpoint(true);
          if (name === "gemini") {
            const metrics = embedder.getMetrics ? embedder.getMetrics() : {};
            logRag(
              `gemini build failed provider=${name} requests=${metrics.requests || 0} retries=${metrics.retries || 0} ` +
              `retry_delay_ms=${metrics.retryDelayMs || 0} throttle_events=${metrics.throttleEvents || 0} ` +
              `throttle_delay_ms=${metrics.throttleDelayMs || 0} rate_limit_retries=${metrics.rateLimitRetries || 0} ` +
              `checkpoint_completed=${normalized.length}/${texts.length} error=${error.message}`
            );
          }
          throw error;
        }
      } else {
        logRag(`checkpoint already complete provider=${name} completed=${resumeFrom}/${texts.length}`);
      }

      const payload = {
        cacheKey,
        meta: cacheMeta,
        items: indexedItems,
        vectors: normalized
      };
      saveVectorIndexCache(cacheFile, payload);
      clearVectorIndexCheckpoint(checkpointFile);
      logRag(`cache saved provider=${name} file=${cacheFile} items=${payload.items.length} vectors=${payload.vectors.length}`);
      return {
        items: payload.items,
        vectors: payload.vectors
      };
    })();
    return indexPromise;
  };

  return {
    name,
    search: async (query, filters, limit) => {
      const prepared = truncateText(normalizeText(query), ragConfig.maxTextChars);
      if (!prepared) return [];
      const index = await loadIndex();
      const queryVector = normalizeVector(await embedder.embed(prepared));
      const bestByUri = new Map();

      for (let i = 0; i < index.vectors.length; i++) {
        const score = dotProduct(queryVector, index.vectors[i]);
        if (ragConfig.minScore && score < ragConfig.minScore) continue;
        const item = index.items[i];
        const entry = resourceIndexByUri.get(item.uri);
        if (!entry || !entryMatchesScope(entry, filters)) continue;
        const existing = bestByUri.get(item.uri);
        if (!existing || score > existing.score) {
          bestByUri.set(item.uri, { entry, score });
        }
      }

      const results = Array.from(bestByUri.values())
        .sort((a, b) => b.score - a.score)
        .map((item) => attachScore(item.entry, item.score));

      if (limit) return results.slice(0, limit);
      return results;
    },
    warm: async () => {
      await loadIndex();
    }
  };
}

export {
  ensureDirectory,
  createVectorProvider
};
