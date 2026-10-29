// Scope check for retrieval evaluation, using the same normalizers and
// matchers the search path applies to filters.
import {
  normalizeProduct,
  normalizePlatform,
  normalizeEdition,
  editionMatches,
  platformMatches
} from "../../src/server/resource-index.js";
import { normalizeSearchFilters, entryMatchesScope } from "../../src/rag/search-utils.js";

function isResultInScope(result, rawFilters) {
  const filters = normalizeSearchFilters(rawFilters, { normalizeProduct, normalizePlatform, normalizeEdition });
  return entryMatchesScope(result, filters, { editionMatches, platformMatches });
}

export { isResultInScope };
