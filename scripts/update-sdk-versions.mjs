#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const projectRoot = process.cwd();
const metadataPath = join(projectRoot, "data", "metadata", "dynamsoft_sdks.json");
const checkOnly = process.argv.includes("--check");

function logVersionSync(message) {
  console.log(`[version-sync] ${message}`);
}

function walkFiles(rootDir, fileFilter) {
  if (!existsSync(rootDir)) return [];
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".git")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && fileFilter(fullPath, entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files.sort((a, b) => a.localeCompare(b));
}

function normalizeVersion(version) {
  const parts = String(version)
    .trim()
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isInteger(part) && part >= 0);
  if (parts.length < 2) return "";
  return parts.join(".");
}

function compareVersion(a, b) {
  const aParts = String(a).split(".").map((part) => Number.parseInt(part, 10));
  const bParts = String(b).split(".").map((part) => Number.parseInt(part, 10));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isInteger(aParts[i]) ? aParts[i] : 0;
    const bv = Number.isInteger(bParts[i]) ? bParts[i] : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function getHighestVersion(versions) {
  const normalized = versions
    .map((item) => normalizeVersion(item))
    .filter(Boolean);
  if (normalized.length === 0) return "";
  normalized.sort((a, b) => compareVersion(a, b)).reverse();
  return normalized[0];
}

function extractVersionCandidates(text) {
  const values = [];
  const regex = /(?:^|[^0-9])v?(\d{1,2}(?:\.\d+){1,3})(?![\d.])/gi;
  const source = String(text || "");
  let match = regex.exec(source);
  while (match) {
    const normalized = normalizeVersion(match[1]);
    if (normalized) values.push(normalized);
    match = regex.exec(source);
  }
  return values;
}

function detectFromReleaseNoteIndexes(docRoot) {
  const markdownFiles = walkFiles(docRoot, (fullPath, name) => {
    if (!name.toLowerCase().endsWith(".md")) return false;
    const normalized = fullPath.replace(/\\/g, "/").toLowerCase();
    return normalized.endsWith("/release-notes/index.md") || normalized.endsWith("/releasenotes/index.md");
  });

  if (markdownFiles.length === 0) return "";

  const versions = [];
  for (const filePath of markdownFiles) {
    const content = readFileSync(filePath, "utf8");
    versions.push(...extractVersionCandidates(content));
  }

  return getHighestVersion(versions);
}

function detectFromProductVersionYml(docRoot) {
  const filePath = join(docRoot, "_data", "product_version.yml");
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf8");

  const latestLine = content
    .split(/\r?\n/)
    .find((line) => /latest version/i.test(line));
  if (!latestLine) return "";

  return getHighestVersion(extractVersionCandidates(latestLine));
}

function detectFromLatestVersionJs(docRoot, relativeFile) {
  const filePath = join(docRoot, ...relativeFile.split("/"));
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/versionNoteLatestVersion\s*=\s*["']([0-9.]+)["']/i);
  if (!match) return "";
  return normalizeVersion(match[1]);
}

function detectFromStrategies(strategies, source, resolvedVersions, metadata) {
  const docsRoot = source.docsPath ? join(projectRoot, source.docsPath) : "";

  for (const strategy of strategies) {
    if (strategy === "release-note-indexes") {
      if (!docsRoot || !existsSync(docsRoot)) continue;
      const detected = detectFromReleaseNoteIndexes(docsRoot);
      if (detected) return detected;
      continue;
    }

    if (strategy === "product-version-yml") {
      if (!docsRoot || !existsSync(docsRoot)) continue;
      const detected = detectFromProductVersionYml(docsRoot);
      if (detected) return detected;
      continue;
    }

    if (typeof strategy === "object" && strategy.type === "latest-version-js") {
      if (!docsRoot || !existsSync(docsRoot)) continue;
      const detected = detectFromLatestVersionJs(docsRoot, strategy.file);
      if (detected) return detected;
      continue;
    }

    if (typeof strategy === "object" && strategy.type === "max-of-sdks") {
      const candidates = [];
      for (const sdkId of strategy.sdkIds || []) {
        const resolved = resolvedVersions[sdkId] || String(metadata?.sdks?.[sdkId]?.version || "");
        const normalized = normalizeVersion(resolved);
        if (normalized) candidates.push(normalized);
      }
      const detected = getHighestVersion(candidates);
      if (detected) return detected;
      continue;
    }
  }

  return "";
}

const sdkVersionSources = [
  {
    sdkId: "dbr-web",
    docsPath: "data/documentation/barcode-reader-docs-js",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dbr-mobile",
    docsPath: "data/documentation/barcode-reader-docs-mobile",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dbr-server",
    docsPath: "data/documentation/barcode-reader-docs-server",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dwt",
    docsPath: "data/documentation/web-twain-docs",
    strategies: [{ type: "latest-version-js", file: "assets/js/setLatestVersion.js" }]
  },
  {
    sdkId: "ddv",
    docsPath: "data/documentation/document-viewer-docs",
    strategies: ["product-version-yml", "release-note-indexes"]
  },
  {
    sdkId: "dcv-web",
    docsPath: "data/documentation/capture-vision-docs-js",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dcv-mobile",
    docsPath: "data/documentation/capture-vision-docs-mobile",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dcv-server",
    docsPath: "data/documentation/capture-vision-docs-server",
    strategies: ["release-note-indexes"]
  },
  {
    sdkId: "dcv-core",
    docsPath: "data/documentation/capture-vision-docs",
    strategies: ["product-version-yml", { type: "max-of-sdks", sdkIds: ["dcv-server", "dcv-mobile", "dcv-web"] }]
  }
];

if (!existsSync(metadataPath)) {
  console.error(`[version-sync] metadata file not found: ${metadataPath}`);
  process.exit(1);
}

const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const updates = [];
const skipped = [];
const resolvedVersions = {};

for (const source of sdkVersionSources) {
  const sdkEntry = metadata?.sdks?.[source.sdkId];
  if (!sdkEntry) {
    skipped.push(`${source.sdkId} (missing metadata entry)`);
    continue;
  }

  if (source.docsPath) {
    const docsRoot = join(projectRoot, source.docsPath);
    if (!existsSync(docsRoot)) {
      skipped.push(`${source.sdkId} (${source.docsPath} not found)`);
      continue;
    }
  }

  const detected = detectFromStrategies(source.strategies, source, resolvedVersions, metadata);
  if (!detected) {
    skipped.push(`${source.sdkId} (no version found with configured strategies)`);
    continue;
  }

  resolvedVersions[source.sdkId] = detected;
  const current = String(sdkEntry.version || "");
  if (current !== detected) {
    updates.push({
      sdkId: source.sdkId,
      from: current,
      to: detected,
      docsPath: source.docsPath || "n/a"
    });
    sdkEntry.version = detected;
  }
}

if (updates.length === 0) {
  logVersionSync("no version updates detected");
} else {
  for (const update of updates) {
    logVersionSync(`update ${update.sdkId}: ${update.from} -> ${update.to} (source=${update.docsPath})`);
  }
}

if (skipped.length > 0) {
  for (const item of skipped) {
    logVersionSync(`skip ${item}`);
  }
}

if (checkOnly) {
  if (updates.length > 0) {
    console.error("[version-sync] version metadata is stale. Run: npm run data:versions");
    process.exit(1);
  }
  process.exit(0);
}

if (updates.length > 0) {
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  logVersionSync(`updated ${relative(projectRoot, metadataPath)}`);
}
