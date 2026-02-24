import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function parseFrontMatter(markdown) {
  if (!markdown || !markdown.startsWith("---")) {
    return { meta: {}, body: markdown || "" };
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { meta: {}, body: markdown };
  }
  const metaBlock = match[1];
  const body = markdown.slice(match[0].length);
  const meta = {};
  for (const rawLine of metaBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body };
}

function getHeadingTitle(markdownBody) {
  if (!markdownBody) return "";
  for (const line of markdownBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
  }
  return "";
}

function formatSegmentLabel(segment) {
  if (!segment) return "";
  const cleaned = segment.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildBreadcrumbFromPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  const directory = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
  if (!directory) return "";
  const segments = directory.split("/").filter(Boolean).map(formatSegmentLabel).filter(Boolean);
  return segments.join(" > ");
}

function collectMarkdownFiles(rootDir, options = {}) {
  const files = [];
  const excludeDirs = new Set(options.excludeDirs || []);
  const excludeFiles = new Set(options.excludeFiles || []);
  const includeDirNames = new Set(options.includeDirNames || []);

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && !includeDirNames.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (excludeFiles.has(entry.name)) continue;
        files.push(join(dir, entry.name));
      }
    }
  }

  walk(rootDir);
  return files.sort();
}

function markdownPathToUrl(baseUrl, relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.md$/i, ".html");
  return `${baseUrl}${normalized}`;
}

function loadMarkdownDocs({ rootDir, urlBase, includeDirNames = [], excludeDirs = [], excludeFiles = [] }) {
  if (!existsSync(rootDir)) return { articles: [] };

  const files = collectMarkdownFiles(rootDir, { includeDirNames, excludeDirs, excludeFiles });
  const articles = [];

  for (const filePath of files) {
    const relativePath = relative(rootDir, filePath).replace(/\\/g, "/");
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseFrontMatter(raw);
    const title = parsed.meta.title || getHeadingTitle(parsed.body) || formatSegmentLabel(relativePath.replace(/\.md$/i, "").split("/").pop());
    if (!title) continue;
    const breadcrumb = parsed.meta.breadcrumbText || buildBreadcrumbFromPath(relativePath) || title;
    articles.push({
      title,
      url: markdownPathToUrl(urlBase, relativePath),
      content: parsed.body.trim(),
      breadcrumb,
      path: relativePath
    });
  }

  return { articles };
}

export {
  loadMarkdownDocs
};
