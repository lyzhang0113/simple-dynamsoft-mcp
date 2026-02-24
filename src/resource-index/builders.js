import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { DDV_PREFERRED_ENTRY_FILES } from "./config.js";

function mapDocTitlesWithOptionalPlatform(articles, includePlatform = false) {
  return articles.map((article) => ({
    title: article.title,
    category: article.breadcrumb || "",
    ...(includePlatform && article.platform ? { platform: article.platform } : {})
  }));
}

function addMarkdownDocResources({
  addResourceToIndex,
  docs,
  idPrefix,
  uriPrefix,
  product,
  edition,
  version,
  majorVersion,
  defaultPlatform = "web",
  defaultSummary,
  baseTags
}) {
  for (let i = 0; i < docs.length; i++) {
    const article = docs[i];
    if (!article?.title) continue;
    const slug = `${encodeURIComponent(article.title)}-${i}`;
    const platform = article.platform || defaultPlatform;
    const tags = [...baseTags, platform];
    if (article.breadcrumb) tags.push(...article.breadcrumb.toLowerCase().split(/\s*>\s*/));

    addResourceToIndex({
      id: `${idPrefix}-${i}`,
      uri: `${uriPrefix}/${platform}/${version}/${slug}`,
      type: "doc",
      product,
      edition,
      platform,
      version,
      majorVersion,
      title: article.title,
      summary: article.breadcrumb || defaultSummary,
      embedText: article.content,
      mimeType: "text/markdown",
      tags,
      loadContent: async () => ({
        text: [
          `# ${article.title}`,
          "",
          article.breadcrumb ? `**Category:** ${article.breadcrumb}` : "",
          article.url ? `**URL:** ${article.url}` : "",
          "",
          "---",
          "",
          article.content
        ].filter(Boolean).join("\n"),
        mimeType: "text/markdown"
      })
    });
  }
}

function buildIndexData({
  LATEST_VERSIONS,
  LATEST_MAJOR,
  dbrWebDocs,
  dbrMobileDocs,
  dbrServerDocs,
  dwtDocs,
  ddvDocs,
  discoverWebSamples,
  getDbrWebFrameworkPlatforms,
  getDbrMobilePlatforms,
  getDbrServerPlatforms,
  discoverMobileSamples,
  discoverDbrServerSamples,
  discoverDwtSamples,
  discoverDdvSamples,
  getDdvWebFrameworkPlatforms
}) {
  const dbrMobileVersion = LATEST_VERSIONS.dbr.mobile;
  const dbrWebVersion = LATEST_VERSIONS.dbr.web;
  const dbrServerVersion = LATEST_VERSIONS.dbr.server;
  const dwtVersion = LATEST_VERSIONS.dwt.web;
  const ddvVersion = LATEST_VERSIONS.ddv.web;

  const dbrWebSamples = discoverWebSamples();
  const dbrWebFrameworks = getDbrWebFrameworkPlatforms();
  const dbrMobilePlatforms = getDbrMobilePlatforms();
  const dbrServerPlatforms = getDbrServerPlatforms();
  const ddvSamples = discoverDdvSamples();
  const ddvWebFrameworks = getDdvWebFrameworkPlatforms();

  return {
    products: {
      dbr: {
        latestMajor: LATEST_MAJOR.dbr,
        editions: {
          mobile: {
            version: dbrMobileVersion,
            platforms: dbrMobilePlatforms,
            samples: Object.fromEntries(
              dbrMobilePlatforms.map((platform) => [platform, discoverMobileSamples(platform)])
            ),
            docCount: dbrMobileDocs.length,
            docTitles: mapDocTitlesWithOptionalPlatform(dbrMobileDocs, true)
          },
          web: {
            version: dbrWebVersion,
            platforms: ["js", ...dbrWebFrameworks],
            samples: dbrWebSamples,
            docCount: dbrWebDocs.length,
            docTitles: mapDocTitlesWithOptionalPlatform(dbrWebDocs)
          },
          server: {
            version: dbrServerVersion,
            platforms: dbrServerPlatforms,
            samples: Object.fromEntries(
              dbrServerPlatforms.map((platform) => [platform, discoverDbrServerSamples(platform)])
            ),
            docCount: dbrServerDocs.length,
            docTitles: mapDocTitlesWithOptionalPlatform(dbrServerDocs, true)
          }
        }
      },
      dwt: {
        latestMajor: LATEST_MAJOR.dwt,
        editions: {
          web: {
            version: dwtVersion,
            platforms: ["js"],
            sampleCategories: discoverDwtSamples(),
            docCount: dwtDocs.articles.length,
            docTitles: dwtDocs.articles.map((article) => ({
              title: article.title,
              category: article.breadcrumb || ""
            }))
          }
        }
      },
      ddv: {
        latestMajor: LATEST_MAJOR.ddv,
        editions: {
          web: {
            version: ddvVersion,
            platforms: ["js", ...ddvWebFrameworks],
            samples: ddvSamples,
            docCount: ddvDocs.articles.length,
            docTitles: ddvDocs.articles.map((article) => ({
              title: article.title,
              category: article.breadcrumb || ""
            }))
          }
        }
      }
    }
  };
}

function buildResourceIndex({
  addResourceToIndex,
  buildIndexData,
  buildVersionPolicyText,
  LATEST_VERSIONS,
  LATEST_MAJOR,
  dbrWebDocs,
  dbrMobileDocs,
  dbrServerDocs,
  dwtDocs,
  ddvDocs,
  discoverMobileSamples,
  getDbrMobilePlatforms,
  getMobileSamplePath,
  getMainCodeFile,
  readCodeFile,
  getMimeTypeForExtension,
  getDbrServerPlatforms,
  discoverDbrServerSamples,
  getDbrServerSampleContent,
  discoverWebSamples,
  getWebSamplePath,
  discoverDwtSamples,
  getDwtSamplePath,
  discoverDdvSamples,
  getDdvSamplePath,
  findCodeFilesInSample
}) {
  addResourceToIndex({
    id: "index",
    uri: "doc://index",
    type: "index",
    title: "Dynamsoft MCP Index",
    summary: "Compact index of products, editions, versions, samples, and docs.",
    mimeType: "application/json",
    tags: ["index", "overview", "catalog"],
    pinned: true,
    loadContent: async () => ({
      text: JSON.stringify(buildIndexData(), null, 2),
      mimeType: "application/json"
    })
  });

  addResourceToIndex({
    id: "version-policy",
    uri: "doc://version-policy",
    type: "policy",
    title: "Version Policy",
    summary: "Latest major versions only; legacy docs are linked for select versions.",
    mimeType: "text/markdown",
    tags: ["policy", "version", "support"],
    pinned: true,
    loadContent: async () => ({
      text: buildVersionPolicyText(),
      mimeType: "text/markdown"
    })
  });

  const dbrMobileVersion = LATEST_VERSIONS.dbr.mobile;
  const dbrWebVersion = LATEST_VERSIONS.dbr.web;
  const dbrServerVersion = LATEST_VERSIONS.dbr.server;
  const dwtVersion = LATEST_VERSIONS.dwt.web;
  const ddvVersion = LATEST_VERSIONS.ddv.web;

  addMarkdownDocResources({
    addResourceToIndex,
    docs: dbrWebDocs,
    idPrefix: "dbr-web-doc",
    uriPrefix: "doc://dbr/web",
    product: "dbr",
    edition: "web",
    version: dbrWebVersion,
    majorVersion: LATEST_MAJOR.dbr,
    defaultPlatform: "web",
    defaultSummary: "Dynamsoft Barcode Reader Web documentation",
    baseTags: ["doc", "dbr", "web"]
  });

  addMarkdownDocResources({
    addResourceToIndex,
    docs: dbrMobileDocs,
    idPrefix: "dbr-mobile-doc",
    uriPrefix: "doc://dbr/mobile",
    product: "dbr",
    edition: "mobile",
    version: dbrMobileVersion,
    majorVersion: LATEST_MAJOR.dbr,
    defaultPlatform: "mobile",
    defaultSummary: "Dynamsoft Barcode Reader Mobile documentation",
    baseTags: ["doc", "dbr", "mobile"]
  });

  addMarkdownDocResources({
    addResourceToIndex,
    docs: dbrServerDocs,
    idPrefix: "dbr-server-doc",
    uriPrefix: "doc://dbr/server",
    product: "dbr",
    edition: "server",
    version: dbrServerVersion,
    majorVersion: LATEST_MAJOR.dbr,
    defaultPlatform: "server",
    defaultSummary: "Dynamsoft Barcode Reader Server/Desktop documentation",
    baseTags: ["doc", "dbr", "server"]
  });

  for (const platform of getDbrMobilePlatforms()) {
    const samples = discoverMobileSamples(platform);
    for (const level of ["high-level", "low-level"]) {
      for (const sampleName of samples[level]) {
        addResourceToIndex({
          id: `dbr-mobile-${platform}-${level}-${sampleName}`,
          uri: `sample://dbr/mobile/${platform}/${dbrMobileVersion}/${level}/${sampleName}`,
          type: "sample",
          product: "dbr",
          edition: "mobile",
          platform,
          version: dbrMobileVersion,
          majorVersion: LATEST_MAJOR.dbr,
          title: `${sampleName} (${platform}, ${level})`,
          summary: `DBR mobile ${platform} ${level} sample ${sampleName}.`,
          mimeType: "text/plain",
          tags: ["sample", "dbr", "mobile", platform, level, sampleName],
          loadContent: async () => {
            const samplePath = getMobileSamplePath(platform, level, sampleName);
            if (!samplePath || !existsSync(samplePath)) return { text: "Sample not found", mimeType: "text/plain" };
            const mainFile = getMainCodeFile(platform, samplePath);
            if (!mainFile) return { text: "Sample not found", mimeType: "text/plain" };
            const content = readCodeFile(mainFile.path);
            const ext = mainFile.filename.split(".").pop() || "";
            return { text: content, mimeType: getMimeTypeForExtension(ext) };
          }
        });
      }
    }
  }

  for (const platform of getDbrServerPlatforms()) {
    const samples = discoverDbrServerSamples(platform);
    for (const sampleName of samples) {
      const isPython = platform === "python";
      const edition = isPython ? "python" : "server";
      const uri = isPython
        ? `sample://dbr/python/python/${dbrServerVersion}/${sampleName}`
        : `sample://dbr/server/${platform}/${dbrServerVersion}/${sampleName}`;
      addResourceToIndex({
        id: `dbr-${platform}-${sampleName}`,
        uri,
        type: "sample",
        product: "dbr",
        edition,
        platform,
        version: dbrServerVersion,
        majorVersion: LATEST_MAJOR.dbr,
        title: `${platform.toUpperCase()} sample: ${sampleName}`,
        summary: `DBR ${platform} sample ${sampleName}.`,
        mimeType: platform === "python" ? "text/x-python" : (platform === "nodejs" ? "text/javascript" : "text/plain"),
        tags: ["sample", "dbr", "server", platform, sampleName],
        loadContent: async () => getDbrServerSampleContent(platform, sampleName)
      });
    }
  }

  const webCategories = discoverWebSamples();
  for (const [category, samples] of Object.entries(webCategories)) {
    for (const sampleName of samples) {
      addResourceToIndex({
        id: `dbr-web-${category}-${sampleName}`,
        uri: `sample://dbr/web/web/${dbrWebVersion}/${category}/${sampleName}`,
        type: "sample",
        product: "dbr",
        edition: "web",
        platform: "web",
        version: dbrWebVersion,
        majorVersion: LATEST_MAJOR.dbr,
        title: `Web sample: ${sampleName} (${category})`,
        summary: `DBR web sample ${category}/${sampleName}.`,
        mimeType: "text/html",
        tags: ["sample", "dbr", "web", category, sampleName],
        loadContent: async () => {
          const samplePath = getWebSamplePath(category, sampleName);
          const content = samplePath && existsSync(samplePath) ? readCodeFile(samplePath) : "Sample not found";
          return { text: content, mimeType: "text/html" };
        }
      });
    }
  }

  const dwtCategories = discoverDwtSamples();
  for (const [category, samples] of Object.entries(dwtCategories)) {
    for (const sampleName of samples) {
      addResourceToIndex({
        id: `dwt-${category}-${sampleName}`,
        uri: `sample://dwt/web/web/${dwtVersion}/${category}/${sampleName}`,
        type: "sample",
        product: "dwt",
        edition: "web",
        platform: "web",
        version: dwtVersion,
        majorVersion: LATEST_MAJOR.dwt,
        title: `DWT sample: ${sampleName} (${category})`,
        summary: `Dynamic Web TWAIN sample ${category}/${sampleName}.`,
        mimeType: "text/html",
        tags: ["sample", "dwt", category, sampleName],
        loadContent: async () => {
          const samplePath = getDwtSamplePath(category, sampleName);
          const content = samplePath && existsSync(samplePath) ? readCodeFile(samplePath) : "Sample not found";
          return { text: content, mimeType: "text/html" };
        }
      });
    }
  }

  addMarkdownDocResources({
    addResourceToIndex,
    docs: dwtDocs.articles,
    idPrefix: "dwt-doc",
    uriPrefix: "doc://dwt/web",
    product: "dwt",
    edition: "web",
    version: dwtVersion,
    majorVersion: LATEST_MAJOR.dwt,
    defaultPlatform: "web",
    defaultSummary: "Dynamic Web TWAIN documentation",
    baseTags: ["doc", "dwt"]
  });

  for (const sampleName of discoverDdvSamples()) {
    addResourceToIndex({
      id: `ddv-${sampleName}`,
      uri: `sample://ddv/web/web/${ddvVersion}/${sampleName}`,
      type: "sample",
      product: "ddv",
      edition: "web",
      platform: "web",
      version: ddvVersion,
      majorVersion: LATEST_MAJOR.ddv,
      title: `DDV sample: ${sampleName}`,
      summary: `Dynamsoft Document Viewer sample ${sampleName}.`,
      mimeType: "text/plain",
      tags: ["sample", "ddv", "document-viewer", "web", sampleName],
      loadContent: async () => {
        const samplePath = getDdvSamplePath(sampleName);
        if (!samplePath || !existsSync(samplePath)) return { text: "Sample not found", mimeType: "text/plain" };

        const stat = statSync(samplePath);
        if (stat.isDirectory()) {
          const readmePath = join(samplePath, "README.md");
          if (existsSync(readmePath)) return { text: readCodeFile(readmePath), mimeType: "text/markdown" };

          const codeFiles = findCodeFilesInSample(samplePath);
          if (codeFiles.length === 0) {
            const entries = readdirSync(samplePath, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
            return {
              text: entries.length ? entries.join("\n") : "Sample found, but no code files detected.",
              mimeType: "text/plain"
            };
          }

          const preferred = codeFiles.find((file) => DDV_PREFERRED_ENTRY_FILES.includes(file.filename)) || codeFiles[0];
          const content = readCodeFile(preferred.path);
          return { text: content, mimeType: getMimeTypeForExtension(preferred.extension) };
        }

        const ext = extname(samplePath).replace(".", "");
        return { text: readCodeFile(samplePath), mimeType: getMimeTypeForExtension(ext) };
      }
    });
  }

  addMarkdownDocResources({
    addResourceToIndex,
    docs: ddvDocs.articles,
    idPrefix: "ddv-doc",
    uriPrefix: "doc://ddv/web",
    product: "ddv",
    edition: "web",
    version: ddvVersion,
    majorVersion: LATEST_MAJOR.ddv,
    defaultPlatform: "web",
    defaultSummary: "Dynamsoft Document Viewer documentation",
    baseTags: ["doc", "ddv"]
  });
}

export {
  buildIndexData,
  buildResourceIndex
};
