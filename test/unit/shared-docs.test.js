import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectSharedDcvDocs, isCompatibleSharedVersion } from "../../src/server/resource-index/shared-docs.js";

const API = "https://www.dynamsoft.com/capture-vision/docs/web/programming/javascript/api-reference/";
const CORE = "https://www.dynamsoft.com/capture-vision/docs/core/";

function dcvArticle(url, path, platform = "web") {
  return { title: path, url, path, content: "body", platform };
}

function withDbrRepo(includes, fn) {
  const dir = mkdtempSync(join(tmpdir(), "shared-docs-"));
  try {
    mkdirSync(join(dir, "_includes", "sidelist-programming"), { recursive: true });
    for (const [name, text] of Object.entries(includes)) {
      writeFileSync(join(dir, "_includes", name), text);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const siteVars = new Map([
  ["dcvb_js_api", API],
  ["dcvb_parameters", `${CORE}parameters/reference/`]
]);

test("selects DCV pages linked from DBR docs or sidebars; ignores unlinked and archived pages", () => {
  withDbrRepo({
    // The single-file processing page is linked only from the DBR sidebar.
    "sidelist-programming/programming-javascript.html": '<a href="{{ site.dcvb_js_api }}capture-vision-router/single-image-processing.html">capture</a>'
  }, (dbrRoot) => {
    const shared = selectSharedDcvDocs({
      dbrArticles: [{
        platform: "web",
        content: `[settings](${API}capture-vision-router/settings.html#getsimplifiedsettings) ` +
          `[double slash](${API}/core/enum-error-code.html) ` +
          "[archived](https://www.dynamsoft.com/capture-vision/docs-archive/web/programming/javascript/api-reference/old.html)"
      }],
      dbrRoot,
      siteVars,
      dbrVersion: "11.6.3200",
      sources: [{
        articles: [
          dcvArticle(`${API}capture-vision-router/single-image-processing.html`, "programming/javascript/api-reference/capture-vision-router/single-image-processing.md"),
          dcvArticle(`${API}capture-vision-router/settings.html`, "programming/javascript/api-reference/capture-vision-router/settings.md"),
          dcvArticle(`${API}core/enum-error-code.html`, "programming/javascript/api-reference/core/enum-error-code.md"),
          dcvArticle(`${API}capture-vision-router/instantiate.html`, "programming/javascript/api-reference/capture-vision-router/instantiate.md")
        ],
        version: "3.6.3200",
        editionSpecific: true,
        slugPrefix: "dcv",
        defaultPlatform: "web"
      }]
    });

    assert.deepEqual(shared.map((doc) => doc.slug).sort(), [
      "dcv/api-reference/capture-vision-router/settings",
      "dcv/api-reference/capture-vision-router/single-image-processing",
      "dcv/api-reference/core/enum-error-code"
    ]);
    assert.ok(shared.every((doc) => doc.sourceVersion === "3.6.3200" && doc.platform === "web"));
  });
});

test("core pages take the platforms of the DBR docs that link them", () => {
  withDbrRepo({
    "sidelist-programming/programming-android.html": `<a href="{{ site.dcvb_parameters }}barcode-format-ids.html">ids</a>`
  }, (dbrRoot) => {
    const shared = selectSharedDcvDocs({
      dbrArticles: [
        { platform: "android", content: "no links" },
        { platform: "ios", content: `[deblur](${CORE}parameters/reference/deblur-modes.html)` }
      ],
      dbrRoot,
      siteVars,
      dbrVersion: "11.6.4000",
      sources: [{
        articles: [
          dcvArticle(`${CORE}parameters/reference/barcode-format-ids.html`, "parameters/reference/barcode-format-ids.md", "core"),
          dcvArticle(`${CORE}parameters/reference/deblur-modes.html`, "parameters/reference/deblur-modes.md", "core")
        ],
        version: "3.6.4000",
        editionSpecific: false,
        slugPrefix: "dcv-core",
        defaultPlatform: "mobile"
      }]
    });

    const bySlug = Object.fromEntries(shared.map((doc) => [doc.slug, doc]));
    assert.deepEqual(bySlug["dcv-core/parameters/reference/barcode-format-ids"].platforms, ["android"]);
    assert.equal(bySlug["dcv-core/parameters/reference/barcode-format-ids"].platform, "android");
    assert.deepEqual(bySlug["dcv-core/parameters/reference/deblur-modes"].platforms, ["ios"]);
  });
});

test("version-incompatible DCV sources are skipped and reported", () => {
  const skipped = [];
  const shared = selectSharedDcvDocs({
    dbrArticles: [{ platform: "web", content: `[settings](${API}capture-vision-router/settings.html)` }],
    dbrRoot: "",
    siteVars,
    dbrVersion: "11.6.3200",
    sources: [{
      articles: [dcvArticle(`${API}capture-vision-router/settings.html`, "programming/javascript/api-reference/capture-vision-router/settings.md")],
      version: "3.7.1000",
      editionSpecific: true,
      slugPrefix: "dcv"
    }],
    onSkip: (details) => skipped.push(details)
  });

  assert.deepEqual(shared, []);
  assert.deepEqual(skipped, [{ dbrVersion: "11.6.3200", dcvVersion: "3.7.1000", slugPrefix: "dcv" }]);
});

test("edition pages need matching minor and build; core pages only the minor", () => {
  assert.equal(isCompatibleSharedVersion("11.6.3200", "3.6.3200", { requireBuild: true }), true);
  assert.equal(isCompatibleSharedVersion("11.6.3200", "3.6.4000", { requireBuild: true }), false);
  assert.equal(isCompatibleSharedVersion("11.6.3200", "3.6.4000", { requireBuild: false }), true);
  assert.equal(isCompatibleSharedVersion("11.6.3200", "3.7.3200", { requireBuild: false }), false);
});
