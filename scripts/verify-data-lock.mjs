#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const manifestPath = join(projectRoot, "data", "metadata", "data-manifest.json");
const gitmodulesPath = join(projectRoot, ".gitmodules");

function logDataVerify(message) {
  console.log(`[data-verify] ${message}`);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8"
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

function parseGitmodules(path) {
  if (!existsSync(path)) return new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const byPath = new Map();
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (section) {
      if (current && current.path && current.url) {
        byPath.set(current.path.replace(/^data[\\/]/, "").replace(/\\/g, "/"), current);
      }
      current = { name: section[1], path: "", url: "", branch: "main" };
      continue;
    }

    if (!current) continue;

    const pathMatch = line.match(/^path\s*=\s*(.+)$/);
    if (pathMatch) {
      current.path = pathMatch[1].trim();
      continue;
    }

    const urlMatch = line.match(/^url\s*=\s*(.+)$/);
    if (urlMatch) {
      current.url = urlMatch[1].trim();
      continue;
    }

    const branchMatch = line.match(/^branch\s*=\s*(.+)$/);
    if (branchMatch) {
      current.branch = branchMatch[1].trim();
    }
  }

  if (current && current.path && current.url) {
    byPath.set(current.path.replace(/^data[\\/]/, "").replace(/\\/g, "/"), current);
  }

  return byPath;
}

if (!existsSync(manifestPath)) {
  console.error(`Missing manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest || !Array.isArray(manifest.repos)) {
  console.error(`Invalid manifest format: ${manifestPath}`);
  process.exit(1);
}
logDataVerify(`loaded manifest repos=${manifest.repos.length}`);

const submodulesByPath = parseGitmodules(gitmodulesPath);
logDataVerify(`loaded gitmodules entries=${submodulesByPath.size}`);
const errors = [];

for (const repo of manifest.repos) {
  const submodule = submodulesByPath.get(repo.path);
  if (!submodule) {
    errors.push(`Manifest entry not found in .gitmodules: ${repo.path}`);
    continue;
  }

  if (repo.url !== submodule.url) {
    errors.push(`URL mismatch for ${repo.path}: manifest=${repo.url} gitmodules=${submodule.url}`);
  }
  if ((repo.branch || "main") !== (submodule.branch || "main")) {
    errors.push(`Branch mismatch for ${repo.path}: manifest=${repo.branch} gitmodules=${submodule.branch}`);
  }

  const head = runGit(["-C", join(projectRoot, "data", repo.path), "rev-parse", "HEAD"]);
  if (!head.ok) {
    errors.push(`Failed to read HEAD for data/${repo.path}. Run npm run data:bootstrap.`);
    continue;
  }
  if (head.stdout !== repo.commit) {
    errors.push(`Commit mismatch for ${repo.path}: manifest=${repo.commit} local=${head.stdout}`);
  }
}

if (errors.length > 0) {
  console.error("data-manifest verification failed:");
  for (const message of errors) {
    console.error(`- ${message}`);
  }
  process.exit(1);
}

logDataVerify(`verification passed repos=${manifest.repos.length}`);
