#!/usr/bin/env node
/**
 * Smoke test for the HTTP MCP wrapper.
 *
 * Starts the wrapper, waits for /health, then exercises:
 * - POST /mcp initialize (expects capabilities + discovery)
 * - POST /mcp tools/list (expects non-empty tools)
 *
 * Requires: supertest (devDependency). Run via `npm test` (after install).
 */

import { spawn } from "node:child_process";
import request from "supertest";

const PORT = process.env.PORT || 3333;
const BASE_URL = `http://localhost:${PORT}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(attempts = 20, intervalMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(BASE_URL).get("/health");
      if (res.status === 200) return;
    } catch {
      /* retry */
    }
    await delay(intervalMs);
  }
  throw new Error("HTTP wrapper did not become healthy in time");
}

const child = spawn(process.execPath, ["http/wrapper.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (buf) => process.stdout.write(`[WRAPPER] ${buf}`));
child.stderr.on("data", (buf) => process.stderr.write(`[WRAPPER] ${buf}`));

let exitCode = 0;

try {
  await waitForHealth();

  const initBody = {
    jsonrpc: "2.0",
    id: "init-1",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "http-wrapper-test", version: "1.0.0" },
    },
  };

  const initResp = await request(BASE_URL)
    .post("/mcp")
    .set("Accept", "application/json")
    .send(initBody);

  if (initResp.status !== 200) {
    throw new Error(`initialize returned HTTP ${initResp.status}`);
  }

  const initResult = initResp.body?.result;
  if (!initResult?.capabilities) {
    throw new Error("initialize missing capabilities");
  }
  if (!initResult?.discovery?.tools || !initResult?.discovery?.resources) {
    throw new Error("initialize missing discovery payload");
  }

  const toolsResp = await request(BASE_URL)
    .post("/mcp")
    .set("Accept", "application/json")
    .send({
      jsonrpc: "2.0",
      id: "tools-1",
      method: "tools/list",
      params: {},
    });

  if (toolsResp.status !== 200) {
    throw new Error(`tools/list returned HTTP ${toolsResp.status}`);
  }

  const tools = toolsResp.body?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("tools/list returned no tools");
  }

  console.log("HTTP wrapper smoke test: PASS");
} catch (err) {
  exitCode = 1;
  console.error("HTTP wrapper smoke test: FAIL", err?.message || err);
} finally {
  child.kill();
  await delay(300);
  process.exit(exitCode);
}
