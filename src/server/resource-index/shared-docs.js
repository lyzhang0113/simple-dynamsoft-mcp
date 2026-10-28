import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveSiteLinks } from "./docs-loader.js";

// DBR's public API is built on shared Capture Vision (DCV) modules such as
// CaptureVisionRouter, whose reference pages live only in the DCV docs. DBR's
// own docs and navigation sidebars link to exactly the DCV pages DBR relies on,
// so those links are the dependency map: only linked pages are indexed under
// DBR, never the whole DCV corpus.

const DCV_CURRENT_DOCS_PREFIX = "https://www.dynamsoft.com/capture-vision/docs/";

// Sidebar include `sidelist-programming/programming-<segment>.html` scopes its
// links to one DBR platform; other includes apply to the whole edition.
const SIDEBAR_PLATFORM_BY_SEGMENT = {
  javascript: "web",
  android: "android",
  oc: "ios",
  ios: "ios",
  flutter: "flutter",
  maui: "maui",
  "react-native": "react-native",
  cpp: "cpp",
  dotnet: "dotnet",
  java: "java",
  python: "python",
  nodejs: "nodejs"
};

function normalizeDocUrl(url) {
  // Some DBR links contain `//` inside the path (e.g. `api-reference//core/`).
  let normalized = String(url || "").split("#")[0].split("?")[0].replace(/([^:])\/{2,}/g, "$1/");
  if (!normalized) return "";
  if (normalized.endsWith("/")) return `${normalized}index.html`;
  const lastSegment = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!lastSegment.includes(".")) normalized = `${normalized}.html`;
  return normalized;
}

function extractDcvLinks(text) {
  const links = new Set();
  const pattern = /https:\/\/www\.dynamsoft\.com\/capture-vision\/docs\/[^\s)"'<>\]`]+/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const normalized = normalizeDocUrl(match[0]);
    if (normalized.startsWith(DCV_CURRENT_DOCS_PREFIX)) links.add(normalized);
  }
  return links;
}

function listIncludeFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listIncludeFiles(fullPath));
    } else if (/\.(html|md)$/i.test(entry.name)) {
      files.push({ path: fullPath, name: entry.name });
    }
  }
  return files;
}

function sidebarPlatform(fileName) {
  const match = String(fileName).match(/^programming-(.+)\.html$/i);
  return match ? SIDEBAR_PLATFORM_BY_SEGMENT[match[1].toLowerCase()] || "" : "";
}

// url -> Set of DBR platforms whose docs link to it ("*" = whole edition).
function buildDcvLinkMap({ dbrArticles, dbrRoot, siteVars }) {
  const linkMap = new Map();
  const addLinks = (links, platform) => {
    for (const url of links) {
      if (!linkMap.has(url)) linkMap.set(url, new Set());
      linkMap.get(url).add(platform);
    }
  };

  for (const article of dbrArticles || []) {
    addLinks(extractDcvLinks(article.content), article.platform || "*");
  }
  for (const file of listIncludeFiles(join(dbrRoot || "", "_includes"))) {
    const text = resolveSiteLinks(readFileSync(file.path, "utf8"), siteVars);
    addLinks(extractDcvLinks(text), sidebarPlatform(file.name) || "*");
  }
  return linkMap;
}

function parseVersionParts(version) {
  return String(version || "").split(".").map((part) => Number.parseInt(part, 10));
}

// DBR and DCV ship in lockstep: 11.6.3200 pairs with 3.6.3200. Edition pages
// must match minor and build; core reference pages are edition-neutral and
// only need the same minor.
function isCompatibleSharedVersion(dbrVersion, dcvVersion, { requireBuild }) {
  const [, dbrMinor, dbrBuild] = parseVersionParts(dbrVersion);
  const [, dcvMinor, dcvBuild] = parseVersionParts(dcvVersion);
  if (!Number.isFinite(dbrMinor) || dbrMinor !== dcvMinor) return false;
  if (requireBuild && dbrBuild !== dcvBuild) return false;
  return true;
}

/**
 * Select DCV pages linked from one DBR edition.
 *
 * @param {object} options
 * @param {Array} options.dbrArticles DBR edition articles (with platform).
 * @param {string} options.dbrRoot DBR docs repo root (for `_includes`).
 * @param {Map} options.siteVars DBR repo `{{ site.* }}` variables.
 * @param {string} options.dbrVersion DBR edition version.
 * @param {Array<{articles: Array, version: string, editionSpecific: boolean, slugPrefix: string}>} options.sources
 * @param {Function} [options.onSkip] Called with details when a source is version-incompatible.
 * @returns {Array} Articles with `slugPrefix` (doc:// namespace), `platform`, `platforms`, `sourceVersion`.
 */
function selectSharedDcvDocs({ dbrArticles, dbrRoot, siteVars, dbrVersion, sources, onSkip }) {
  const linkMap = buildDcvLinkMap({ dbrArticles, dbrRoot, siteVars });
  const editionPlatforms = [...new Set((dbrArticles || []).map((article) => article.platform).filter(Boolean))].sort();
  const selected = [];

  for (const source of sources) {
    if (!isCompatibleSharedVersion(dbrVersion, source.version, { requireBuild: source.editionSpecific })) {
      onSkip?.({ dbrVersion, dcvVersion: source.version, slugPrefix: source.slugPrefix });
      continue;
    }
    for (const article of source.articles || []) {
      const linkedFrom = linkMap.get(normalizeDocUrl(article.url));
      if (!linkedFrom) continue;

      let platforms;
      if (source.editionSpecific) {
        // An edition page belongs to one platform (its programming/<lang>/ dir).
        if (!editionPlatforms.includes(article.platform) && editionPlatforms.length > 0) continue;
        platforms = [article.platform];
      } else {
        platforms = linkedFrom.has("*")
          ? editionPlatforms
          : [...linkedFrom].filter((platform) => editionPlatforms.includes(platform)).sort();
      }
      if (platforms.length === 0) continue;

      selected.push({
        ...article,
        slugPrefix: source.slugPrefix,
        platform: platforms.length === 1 ? platforms[0] : (source.defaultPlatform || platforms[0]),
        platforms,
        sourceVersion: source.version
      });
    }
  }

  return selected;
}

export {
  buildDcvLinkMap,
  extractDcvLinks,
  isCompatibleSharedVersion,
  normalizeDocUrl,
  selectSharedDcvDocs
};
