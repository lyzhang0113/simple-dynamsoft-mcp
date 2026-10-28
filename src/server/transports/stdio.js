import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logEvent } from "../../observability/logging.js";
import { attachRequestLogging } from "../../observability/request-logging.js";

async function startStdioServer({ createServer }) {
  logEvent("transport", "server_start", { mode: "stdio" });
  const server = createServer();
  const transport = attachRequestLogging(new StdioServerTransport(), { transport: "stdio" });
  await server.connect(transport);
  return { server, transport };
}

export { startStdioServer };
