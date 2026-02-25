import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function startStdioServer({ createServer }) {
  console.error("[transport] mode=stdio");
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

export { startStdioServer };
