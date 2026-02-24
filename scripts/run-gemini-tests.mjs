#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  ["--test", "test/integration/stdio.test.js", "test/integration/http-gateway.test.js"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_FUSE_PROVIDER_TESTS: "false",
      RUN_LOCAL_PROVIDER_TESTS: "false",
      RUN_GEMINI_PROVIDER_TESTS: "true"
    }
  }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

