import test from "node:test";
import assert from "node:assert/strict";
import { assignDocSlugs } from "../../src/server/resource-index/builders.js";

test("doc slugs are short source paths without the programming/<lang> prefix", () => {
  const slugs = assignDocSlugs([
    { path: "programming/javascript/user-guide/use-in-framework.md", platform: "web" },
    { path: "programming/javascript/api-reference/index.md", platform: "web" }
  ], "web");
  assert.deepEqual(slugs, ["user-guide/use-in-framework", "api-reference"]);
});

test("colliding short paths fall back to full source paths, per platform", () => {
  const slugs = assignDocSlugs([
    { path: "programming/python/user-guide.md", platform: "python" },
    { path: "programming/python/user-guide/index.md", platform: "python" },
    { path: "programming/java/user-guide.md", platform: "java" }
  ], "server");
  assert.deepEqual(slugs, [
    "programming/python/user-guide",
    "programming/python/user-guide/index",
    "user-guide"
  ]);
});

test("shared pages keep their namespace and are disambiguated on collision", () => {
  const docs = [
    { path: "programming/javascript/guide.md", platform: "web", slugPrefix: "dcv" },
    { path: "programming/javascript/guide/index.md", platform: "web", slugPrefix: "dcv" },
    { path: "parameters/reference/guide.md", platform: "web", slugPrefix: "dcv-core" },
    { path: "programming/javascript/guide.md", platform: "web" }
  ];
  const slugs = assignDocSlugs(docs, "web");
  assert.deepEqual(slugs, [
    "dcv/programming/javascript/guide",
    "dcv/programming/javascript/guide/index",
    "dcv-core/parameters/reference/guide",
    "guide"
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
});
