import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupDir,
  createStdioClient,
  dataRoot,
  npmCommand,
  packProjectToTempDir,
  runCoreAssertions
} from "./helpers.js";

test("[fuse] packaged tgz runs via npx --package with custom MCP_DATA_DIR", async () => {
  const packed = packProjectToTempDir();
  const workspaceDir = mkdtempSync(join(tmpdir(), "simple-dynamsoft-mcp-project-"));

  const env = {
    ...process.env,
    MCP_DATA_DIR: dataRoot,
    MCP_DATA_AUTO_DOWNLOAD: "false",
    MCP_DATA_REFRESH_ON_START: "false",
    RAG_PROVIDER: "fuse",
    RAG_FALLBACK: "none"
  };

  let bundle = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      bundle = await createStdioClient({
        command: npmCommand(),
        args: ["exec", "--yes", "--package", packed.tgzPath, "simple-dynamsoft-mcp"],
        cwd: workspaceDir,
        env,
        name: `integration-package-fuse-${attempt}`
      });
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    }
  }

  if (!bundle) {
    cleanupDir(workspaceDir);
    cleanupDir(packed.tempDir);
    throw lastError;
  }

  const { client, transport, getStderr } = bundle;

  try {
    await runCoreAssertions(client);
    const stderr = getStderr();
    assert.match(stderr, /\[data\] mode=custom/, "Expected custom data mode when MCP_DATA_DIR is supplied");
  } finally {
    await transport.close();
    cleanupDir(workspaceDir);
    cleanupDir(packed.tempDir);
  }
});
