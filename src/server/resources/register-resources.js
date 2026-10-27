import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResourceHandlers({
  server,
  getPinnedResources,
  readResourceContent,
  readIndexedResource
}) {
  for (const entry of getPinnedResources()) {
    server.registerResource(
      entry.title,
      entry.uri,
      {
        description: entry.summary,
        mimeType: entry.mimeType
      },
      async (uri) => {
        const resource = await readResourceContent(uri.toString());
        if (!resource) {
          throw new Error(`Resource not found: ${uri}`);
        }
        return { contents: [resource] };
      }
    );
  }

  async function templateReadHandler(uri) {
    return { contents: [await readIndexedResource(uri.toString())] };
  }

  server.registerResource(
    "doc-resource",
    new ResourceTemplate("doc://{product}/{edition}/{platform}/{version}/{+slug}", {}),
    { description: "Dynamsoft documentation resource" },
    templateReadHandler
  );

  server.registerResource(
    "sample-resource",
    new ResourceTemplate("sample://{product}/{edition}/{platform}/{version}/{+rest}", {}),
    { description: "Dynamsoft sample code resource" },
    templateReadHandler
  );
}
