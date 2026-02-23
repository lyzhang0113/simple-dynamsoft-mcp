import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function logDataSync(message) {
  console.error(`[data-sync] ${message}`);
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

function parseGitmodules(filePath) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (section) {
      if (current && current.path) entries.push(current);
      current = { name: section[1], path: "", branch: "main" };
      continue;
    }
    if (!current) continue;
    const pathMatch = line.match(/^path\s*=\s*(.+)$/);
    if (pathMatch) {
      current.path = pathMatch[1].trim();
      continue;
    }
    const branchMatch = line.match(/^branch\s*=\s*(.+)$/);
    if (branchMatch) {
      current.branch = branchMatch[1].trim();
    }
  }

  if (current && current.path) entries.push(current);
  return entries;
}

function runGit(args, cwd, timeoutMs) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error
  };
}

function ensureBranch(repoPath, branch, timeoutMs) {
  const hasBranch = runGit(["-C", repoPath, "show-ref", "--verify", `refs/heads/${branch}`], projectRoot, timeoutMs).ok;
  if (hasBranch) {
    return runGit(["-C", repoPath, "checkout", branch], projectRoot, timeoutMs);
  }
  return runGit(["-C", repoPath, "checkout", "-b", branch, `origin/${branch}`], projectRoot, timeoutMs);
}

function syncSubmodule(entry, timeoutMs) {
  const repoPath = join(projectRoot, entry.path);
  const gitMarker = join(repoPath, ".git");
  if (!existsSync(repoPath) || !existsSync(gitMarker)) {
    const initResult = runGit(["submodule", "update", "--init", "--", entry.path], projectRoot, timeoutMs);
    if (!initResult.ok) {
      return { ok: false, step: "init", message: initResult.stderr || initResult.stdout };
    }
  }

  const fetchResult = runGit(["-C", repoPath, "fetch", "origin", entry.branch], projectRoot, timeoutMs);
  if (!fetchResult.ok) {
    return { ok: false, step: "fetch", message: fetchResult.stderr || fetchResult.stdout };
  }

  const checkoutResult = ensureBranch(repoPath, entry.branch, timeoutMs);
  if (!checkoutResult.ok) {
    return { ok: false, step: "checkout", message: checkoutResult.stderr || checkoutResult.stdout };
  }

  const ffResult = runGit(["-C", repoPath, "merge", "--ff-only", `origin/${entry.branch}`], projectRoot, timeoutMs);
  if (!ffResult.ok) {
    return { ok: false, step: "merge", message: ffResult.stderr || ffResult.stdout };
  }

  return { ok: true };
}

async function maybeSyncSubmodulesOnStart() {
  if (!readBoolEnv("DATA_SYNC_ON_START", false)) return;

  const timeoutMs = readIntEnv("DATA_SYNC_TIMEOUT_MS", 30000);
  const gitmodulesPath = join(projectRoot, ".gitmodules");
  const entries = parseGitmodules(gitmodulesPath);
  logDataSync(`start entries=${entries.length} timeout_ms=${timeoutMs}`);
  if (entries.length === 0) {
    logDataSync("no submodules found; skipping");
    return;
  }

  let okCount = 0;
  let failCount = 0;
  for (const entry of entries) {
    logDataSync(`sync path=${entry.path} branch=${entry.branch}`);
    const result = syncSubmodule(entry, timeoutMs);
    if (!result.ok) {
      failCount += 1;
      const details = result.message ? `: ${result.message}` : "";
      console.error(`[data-sync] ${entry.path} ${result.step} failed${details}`);
      continue;
    }
    okCount += 1;
    logDataSync(`ok path=${entry.path}`);
  }
  logDataSync(`done ok=${okCount} failed=${failCount}`);
}

export {
  maybeSyncSubmodulesOnStart
};
