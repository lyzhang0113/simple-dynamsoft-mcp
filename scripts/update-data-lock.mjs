#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const gitmodulesPath = join(projectRoot, ".gitmodules");
const outputPath = join(projectRoot, "data", "metadata", "data-manifest.json");

function parseGitmodules(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const section = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (section) {
      if (current && current.path && current.url) entries.push(current);
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

  if (current && current.path && current.url) entries.push(current);
  return entries;
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

function parseGitHubUrl(url) {
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function toDataRelativePath(submodulePath) {
  return submodulePath.replace(/^data[\\/]/, "").replace(/\\/g, "/");
}

const submodules = parseGitmodules(gitmodulesPath);
if (submodules.length === 0) {
  console.error("No submodules found in .gitmodules.");
  process.exit(1);
}

const repos = [];

for (const entry of submodules) {
  const slug = parseGitHubUrl(entry.url);
  if (!slug) {
    console.error(`Unsupported submodule URL: ${entry.url}`);
    process.exit(1);
  }

  const head = runGit(["-C", join(projectRoot, entry.path), "rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    console.error(`Failed to resolve HEAD for ${entry.path}. Run npm run data:bootstrap first.`);
    if (head.stderr) console.error(head.stderr);
    process.exit(1);
  }

  const relativePath = toDataRelativePath(entry.path);
  repos.push({
    name: entry.name,
    path: relativePath,
    url: entry.url,
    branch: entry.branch || "main",
    owner: slug.owner,
    repo: slug.repo,
    commit: head.stdout,
    archiveUrl: `https://codeload.github.com/${slug.owner}/${slug.repo}/zip/${head.stdout}`
  });
}

repos.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  version: 1,
  repos
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Updated ${outputPath} with ${repos.length} entries.`);
