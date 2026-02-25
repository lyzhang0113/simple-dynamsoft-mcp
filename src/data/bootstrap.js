import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import extractZip from "extract-zip";
import { bundledDataRoot } from "./root.js";

const manifestPath = join(bundledDataRoot, "metadata", "data-manifest.json");
const sdkRegistryPath = join(bundledDataRoot, "metadata", "dynamsoft_sdks.json");

function logData(message) {
  console.error(`[data] ${message}`);
}

function readBoolEnv(key, fallback = false) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function readIntEnv(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readManifest(rootDir = bundledDataRoot) {
  const path = join(rootDir, "metadata", "data-manifest.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || !Array.isArray(parsed.repos)) return null;
  return parsed;
}

function isDirectoryReady(path) {
  try {
    if (!existsSync(path)) return false;
    const entries = readdirSync(path, { withFileTypes: true });
    // A non-initialized submodule usually has only a `.git` marker entry.
    // Treat that as not ready so runtime bootstrap can download real content.
    return entries.some((entry) => entry.name !== ".git");
  } catch {
    return false;
  }
}

function isDataRootReady(rootDir) {
  const registryPath = join(rootDir, "metadata", "dynamsoft_sdks.json");
  if (!existsSync(registryPath)) return false;

  const manifest = readManifest(rootDir) || readManifest(bundledDataRoot);
  if (!manifest) return false;

  for (const repo of manifest.repos) {
    const target = join(rootDir, repo.path);
    if (!isDirectoryReady(target)) return false;
  }
  return true;
}

function getManifestSignature(manifest) {
  const payload = manifest.repos.map((repo) => `${repo.path}@${repo.commit}`).join("|");
  return createHash("sha256").update(payload).digest("hex");
}

function parseGithubSlug(repo) {
  if (repo.owner && repo.name) {
    return { owner: repo.owner, name: repo.name };
  }
  const url = String(repo.url || "");
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!httpsMatch) return null;
  return { owner: httpsMatch[1], name: httpsMatch[2] };
}

async function downloadFile(url, outputPath, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    writeFileSync(outputPath, Buffer.from(arrayBuffer));
    const elapsedMs = Date.now() - startedAt;
    logData(`downloaded file=${basename(outputPath)} size=${arrayBuffer.byteLength}B elapsed_ms=${elapsedMs}`);
  } finally {
    clearTimeout(timer);
  }
}

function copyBundledMetadata(targetRoot) {
  const metadataDir = join(targetRoot, "metadata");
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(join(metadataDir, "dynamsoft_sdks.json"), readFileSync(sdkRegistryPath, "utf8"));
  writeFileSync(join(metadataDir, "data-manifest.json"), readFileSync(manifestPath, "utf8"));
}

async function populateFromManifest(targetRoot, manifest, timeoutMs) {
  const tempZipRoot = join(tmpdir(), `simple-dynamsoft-mcp-zips-${Date.now()}`);
  mkdirSync(tempZipRoot, { recursive: true });
  logData(`populate start repos=${manifest.repos.length} timeout_ms=${timeoutMs} staging=${targetRoot}`);

  try {
    for (const repo of manifest.repos) {
      const slug = parseGithubSlug(repo);
      if (!slug) {
        throw new Error(`Unable to parse GitHub slug for ${repo.path}`);
      }

      const archiveUrl = repo.archiveUrl || `https://codeload.github.com/${slug.owner}/${slug.name}/zip/${repo.commit}`;
      const zipPath = join(tempZipRoot, `${repo.path.replace(/[\\/]/g, "_")}.zip`);
      const extractRoot = join(tempZipRoot, `${repo.path.replace(/[\\/]/g, "_")}-extract`);
      const targetPath = join(targetRoot, repo.path);
      const targetParent = dirname(targetPath);

      logData(`repo start path=${repo.path} commit=${String(repo.commit || "").slice(0, 12)} host=codeload.github.com`);
      mkdirSync(targetParent, { recursive: true });
      await downloadFile(archiveUrl, zipPath, timeoutMs);
      await extractZip(zipPath, { dir: extractRoot });

      let extractedFolder = join(extractRoot, `${slug.name}-${repo.commit}`);
      if (!existsSync(extractedFolder)) {
        const children = readdirSync(extractRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(extractRoot, entry.name));
        if (children.length === 1) {
          extractedFolder = children[0];
        } else {
          const fallbackName = basename(extractRoot);
          throw new Error(`Archive layout is not recognized for ${repo.path} (${fallbackName})`);
        }
      }

      if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true });
      renameSync(extractedFolder, targetPath);
      logData(`repo ready path=${repo.path}`);
    }
    logData(`populate done repos=${manifest.repos.length}`);
  } finally {
    rmSync(tempZipRoot, { recursive: true, force: true });
  }
}

function finalizeCacheRoot(cacheRoot, stagingRoot, signature) {
  const parent = dirname(cacheRoot);
  mkdirSync(parent, { recursive: true });

  if (existsSync(cacheRoot)) {
    rmSync(cacheRoot, { recursive: true, force: true });
  }

  renameSync(stagingRoot, cacheRoot);
  writeFileSync(join(cacheRoot, ".manifest-signature"), signature);
}

async function ensureDownloadedData(cacheRoot) {
  const manifest = readManifest(bundledDataRoot);
  if (!manifest) {
    throw new Error(`Missing manifest at ${manifestPath}. Run npm run data:lock.`);
  }

  const signature = getManifestSignature(manifest);
  const signaturePath = join(cacheRoot, ".manifest-signature");
  const refresh = readBoolEnv("MCP_DATA_REFRESH_ON_START", false);
  logData(
    `download plan repos=${manifest.repos.length} cache_root=${cacheRoot} refresh=${refresh} signature=${signature.slice(0, 12)}`
  );

  if (!refresh && existsSync(signaturePath)) {
    const existingSignature = readFileSync(signaturePath, "utf8").trim();
    if (existingSignature === signature && isDataRootReady(cacheRoot)) {
      logData(`cache hit signature=${signature.slice(0, 12)} root=${cacheRoot}`);
      return { downloaded: false };
    }
    logData(`cache refresh required reason=signature_or_readiness_mismatch root=${cacheRoot}`);
  } else if (refresh) {
    logData(`cache refresh forced by MCP_DATA_REFRESH_ON_START root=${cacheRoot}`);
  } else {
    logData(`cache miss signature_file=${signaturePath}`);
  }

  const timeoutMs = readIntEnv("MCP_DATA_DOWNLOAD_TIMEOUT_MS", 180000);
  const stagingRoot = join(dirname(cacheRoot), `.tmp-data-${Date.now()}`);
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  logData(`download start staging_root=${stagingRoot} timeout_ms=${timeoutMs}`);

  try {
    copyBundledMetadata(stagingRoot);
    await populateFromManifest(stagingRoot, manifest, timeoutMs);
    finalizeCacheRoot(cacheRoot, stagingRoot, signature);
    logData(`download complete root=${cacheRoot} repos=${manifest.repos.length}`);
    return { downloaded: true };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    logData(`download failed root=${cacheRoot} error=${error.message}`);
    throw error;
  }
}

async function ensureDataReady() {
  const explicitRoot = process.env.MCP_DATA_DIR ? resolve(process.env.MCP_DATA_DIR) : "";
  logData(`resolve start explicit_root=${explicitRoot || "(none)"} bundled_root=${bundledDataRoot}`);
  if (explicitRoot) {
    if (!isDataRootReady(explicitRoot)) {
      logData(`custom data root invalid root=${explicitRoot}`);
      throw new Error(`MCP_DATA_DIR is set but data is incomplete: ${explicitRoot}`);
    }
    process.env.MCP_RESOLVED_DATA_DIR = explicitRoot;
    logData(`resolve done mode=custom root=${explicitRoot}`);
    return { dataRoot: explicitRoot, mode: "custom", downloaded: false };
  }

  if (isDataRootReady(bundledDataRoot)) {
    process.env.MCP_RESOLVED_DATA_DIR = bundledDataRoot;
    logData(`resolve done mode=bundled root=${bundledDataRoot}`);
    return { dataRoot: bundledDataRoot, mode: "bundled", downloaded: false };
  }

  const autoDownload = readBoolEnv("MCP_DATA_AUTO_DOWNLOAD", true);
  logData(`bundled data not ready auto_download=${autoDownload}`);
  if (!autoDownload) {
    throw new Error(
      "Bundled data is not available and MCP_DATA_AUTO_DOWNLOAD is disabled. " +
      "Set MCP_DATA_AUTO_DOWNLOAD=true or provide MCP_DATA_DIR."
    );
  }

  const defaultCacheRoot = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "simple-dynamsoft-mcp", "data");
  const cacheRoot = resolve(process.env.MCP_DATA_CACHE_DIR || defaultCacheRoot);
  const result = await ensureDownloadedData(cacheRoot);
  process.env.MCP_RESOLVED_DATA_DIR = cacheRoot;
  logData(`resolve done mode=downloaded root=${cacheRoot} source=${result?.downloaded ? "fresh-download" : "cache"}`);
  return {
    dataRoot: cacheRoot,
    mode: "downloaded",
    downloaded: Boolean(result?.downloaded)
  };
}

export {
  ensureDataReady
};
