#!/usr/bin/env node

import { resourceIndex, readResourceContent } from "../src/server/resource-index.js";

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

async function main() {
  const concurrency = parsePositiveInt(process.env.DOC_VERIFY_CONCURRENCY, 8);
  const docs = resourceIndex.filter((entry) => entry.type === "doc");
  const total = docs.length;

  console.log(`[doc-verify] start total_docs=${total} concurrency=${concurrency}`);

  if (total === 0) {
    console.log("[doc-verify] no docs found; skipping");
    return;
  }

  let index = 0;
  let checked = 0;
  const failures = [];
  const workers = [];

  const runOne = async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= total) return;

      const entry = docs[current];
      try {
        const content = await readResourceContent(entry.uri);
        if (!content) {
          throw new Error("readResourceContent returned null");
        }
        const hasText = typeof content.text === "string" && content.text.length > 0;
        const hasBlob = typeof content.blob === "string" && content.blob.length > 0;
        if (!hasText && !hasBlob) {
          throw new Error("resource content is empty");
        }
      } catch (error) {
        failures.push({
          uri: entry.uri,
          error: error?.message || String(error)
        });
      } finally {
        checked += 1;
        if (checked % 250 === 0 || checked === total) {
          console.log(`[doc-verify] progress checked=${checked}/${total} failures=${failures.length}`);
        }
      }
    }
  };

  for (let i = 0; i < Math.min(concurrency, total); i += 1) {
    workers.push(runOne());
  }
  await Promise.all(workers);

  if (failures.length > 0) {
    console.error(`[doc-verify] failed count=${failures.length}`);
    for (const failure of failures.slice(0, 20)) {
      console.error(`[doc-verify] error uri=${failure.uri} message=${failure.error}`);
    }
    if (failures.length > 20) {
      console.error(`[doc-verify] ... truncated ${failures.length - 20} additional failures`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[doc-verify] success checked=${checked}`);
}

await main();
