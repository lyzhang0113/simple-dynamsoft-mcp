import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");
const bundledDataRoot = join(projectRoot, "data");

function getResolvedDataRoot() {
  const explicit = process.env.MCP_DATA_DIR;
  if (explicit) return resolve(explicit);

  const bootstrapped = process.env.MCP_RESOLVED_DATA_DIR;
  if (bootstrapped) return resolve(bootstrapped);

  return bundledDataRoot;
}

export {
  projectRoot,
  bundledDataRoot,
  getResolvedDataRoot
};
