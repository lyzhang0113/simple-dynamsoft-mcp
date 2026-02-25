import Fuse from "fuse.js";
import {
  resourceIndex,
  resourceIndexByUri,
  editionMatches,
  platformMatches,
  normalizeProduct,
  normalizePlatform,
  normalizeEdition,
  getRagSignatureData
} from "../server/resource-index.js";
import { ragConfig, pkgVersion } from "./config.js";

const fuseSearch = new Fuse(resourceIndex, {
  keys: ["title", "summary", "tags", "uri"],
  threshold: 0.35,
  ignoreLocation: true,
  includeScore: true
});

function attachScore(entry, score) {
  if (!ragConfig.includeScore || !Number.isFinite(score)) return entry;
  return { ...entry, score };
}

function normalizeSearchFilters({ product, edition, platform, type }) {
  const normalizedProduct = normalizeProduct(product);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedEdition = normalizeEdition(edition, normalizedPlatform, normalizedProduct);
  return {
    product: normalizedProduct,
    edition: normalizedEdition,
    platform: normalizedPlatform,
    type: type || "any"
  };
}

function entryMatchesScope(entry, filters) {
  if (filters.product && entry.product !== filters.product) return false;
  if (filters.edition && !editionMatches(filters.edition, entry.edition)) return false;
  if (filters.platform && !platformMatches(filters.platform, entry)) return false;
  if (filters.type && filters.type !== "any" && entry.type !== filters.type) return false;
  return true;
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function truncateText(text, maxChars) {
  if (!maxChars || maxChars <= 0) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars));
}

function chunkText(text, chunkSize, chunkOverlap, maxChunks) {
  const cleaned = normalizeText(text);
  if (!cleaned) return [];
  if (!chunkSize || chunkSize <= 0) return [cleaned];
  const overlap = Math.min(Math.max(0, chunkOverlap), Math.max(0, chunkSize - 1));
  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + chunkSize, cleaned.length);
    const chunk = cleaned.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= cleaned.length) break;
    start = Math.max(0, end - overlap);
    if (maxChunks && chunks.length >= maxChunks) break;
  }
  return chunks;
}

function buildEntryBaseText(entry) {
  const parts = [entry.title, entry.summary];
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    parts.push(entry.tags.join(", "));
  }
  return normalizeText(parts.filter(Boolean).join("\n"));
}

function buildEmbeddingItems() {
  const items = [];
  for (const entry of resourceIndex) {
    const baseText = buildEntryBaseText(entry);
    if (!baseText) continue;
    if (entry.type === "doc" && entry.embedText) {
      const chunks = chunkText(entry.embedText, ragConfig.chunkSize, ragConfig.chunkOverlap, ragConfig.maxChunksPerDoc);
      if (chunks.length === 0) {
        items.push({
          id: entry.id,
          uri: entry.uri,
          text: truncateText(baseText, ragConfig.maxTextChars)
        });
        continue;
      }
      chunks.forEach((chunk, index) => {
        const combined = [baseText, chunk].filter(Boolean).join("\n\n");
        items.push({
          id: `${entry.id}#${index}`,
          uri: entry.uri,
          text: truncateText(combined, ragConfig.maxTextChars)
        });
      });
      continue;
    }
    items.push({
      id: entry.id,
      uri: entry.uri,
      text: truncateText(baseText, ragConfig.maxTextChars)
    });
  }
  return items;
}

function buildIndexSignature() {
  const signatureData = getRagSignatureData();
  return JSON.stringify({
    packageVersion: pkgVersion,
    resourceCount: signatureData.resourceCount,
    dcvCoreDocCount: signatureData.dcvCoreDocCount,
    dcvWebDocCount: signatureData.dcvWebDocCount,
    dcvMobileDocCount: signatureData.dcvMobileDocCount,
    dcvServerDocCount: signatureData.dcvServerDocCount,
    dbrWebDocCount: signatureData.dbrWebDocCount,
    dbrMobileDocCount: signatureData.dbrMobileDocCount,
    dbrServerDocCount: signatureData.dbrServerDocCount,
    dwtDocCount: signatureData.dwtDocCount,
    ddvDocCount: signatureData.ddvDocCount,
    versions: signatureData.versions,
    dataSources: signatureData.dataSources,
    chunkSize: ragConfig.chunkSize,
    chunkOverlap: ragConfig.chunkOverlap,
    maxChunksPerDoc: ragConfig.maxChunksPerDoc,
    maxTextChars: ragConfig.maxTextChars
  });
}

export {
  resourceIndex,
  resourceIndexByUri,
  fuseSearch,
  attachScore,
  normalizeSearchFilters,
  entryMatchesScope,
  normalizeText,
  truncateText,
  buildEmbeddingItems,
  buildIndexSignature
};
