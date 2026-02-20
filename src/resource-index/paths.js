import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_DIRS, SAMPLE_DIRS } from "./config.js";
import { getResolvedDataRoot } from "../data-root.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

const dataRoot = getResolvedDataRoot();
const metadataRoot = join(dataRoot, "metadata");
const samplesRoot = join(dataRoot, "samples");
const docsRoot = join(dataRoot, "documentation");

const registryPath = join(metadataRoot, "dynamsoft_sdks.json");

const SAMPLE_ROOTS = {
  dbrWeb: join(samplesRoot, SAMPLE_DIRS.dbrWeb),
  dbrMobile: join(samplesRoot, SAMPLE_DIRS.dbrMobile),
  dbrPython: join(samplesRoot, SAMPLE_DIRS.dbrPython),
  dbrDotnet: join(samplesRoot, SAMPLE_DIRS.dbrDotnet),
  dbrJava: join(samplesRoot, SAMPLE_DIRS.dbrJava),
  dbrCpp: join(samplesRoot, SAMPLE_DIRS.dbrCpp),
  dbrMaui: join(samplesRoot, SAMPLE_DIRS.dbrMaui),
  dbrReactNative: join(samplesRoot, SAMPLE_DIRS.dbrReactNative),
  dbrFlutter: join(samplesRoot, SAMPLE_DIRS.dbrFlutter),
  dbrNodejs: join(samplesRoot, SAMPLE_DIRS.dbrNodejs),
  dwt: join(samplesRoot, SAMPLE_DIRS.dwt),
  ddv: join(samplesRoot, SAMPLE_DIRS.ddv)
};

const DOC_ROOTS = {
  dbrWeb: join(docsRoot, DOC_DIRS.dbrWeb),
  dbrMobile: join(docsRoot, DOC_DIRS.dbrMobile),
  dbrServer: join(docsRoot, DOC_DIRS.dbrServer),
  dwt: join(docsRoot, DOC_DIRS.dwt),
  dwtArticles: join(docsRoot, DOC_DIRS.dwt, "_articles"),
  ddv: join(docsRoot, DOC_DIRS.ddv)
};

function getExistingPath(...candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function readSubmoduleHead(repoPath) {
  try {
    const gitMarker = join(repoPath, ".git");
    if (!existsSync(gitMarker)) return "";
    let gitDir = gitMarker;
    const markerStats = statSync(gitMarker);
    if (!markerStats.isDirectory()) {
      const markerText = readFileSync(gitMarker, "utf8").trim();
      if (!markerText.toLowerCase().startsWith("gitdir:")) return "";
      const relGitDir = markerText.slice("gitdir:".length).trim();
      gitDir = resolve(repoPath, relGitDir);
    }
    const headPath = join(gitDir, "HEAD");
    if (!existsSync(headPath)) return "";
    const headText = readFileSync(headPath, "utf8").trim();
    if (!headText.startsWith("ref:")) return headText;
    const refPath = join(gitDir, headText.slice("ref:".length).trim());
    if (!existsSync(refPath)) return "";
    return readFileSync(refPath, "utf8").trim();
  } catch {
    return "";
  }
}

export {
  projectRoot,
  dataRoot,
  metadataRoot,
  samplesRoot,
  docsRoot,
  registryPath,
  SAMPLE_ROOTS,
  DOC_ROOTS,
  getExistingPath,
  readSubmoduleHead
};
