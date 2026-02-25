const DEFAULT_TRANSPORT = "stdio";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3333;
const SUPPORTED_TRANSPORTS = new Set(["stdio", "http"]);

const MCP_HTTP_PATH = "/mcp";

function parseCliArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const option = token.slice(2);
    if (!option) continue;

    const equalsIndex = option.indexOf("=");
    if (equalsIndex >= 0) {
      const key = option.slice(0, equalsIndex);
      const value = option.slice(equalsIndex + 1);
      if (key) parsed[key] = value;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[option] = next;
      i += 1;
      continue;
    }

    parsed[option] = "true";
  }

  return parsed;
}

function resolveRuntimeConfig(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const transport = String(parsed.transport || DEFAULT_TRANSPORT).toLowerCase();

  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    throw new Error(`Invalid --transport "${transport}". Expected "stdio" or "http".`);
  }

  if (transport === "http") {
    const host = String(parsed.host || DEFAULT_HTTP_HOST);
    const portRaw = String(parsed.port || String(DEFAULT_HTTP_PORT));
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid --port "${portRaw}". Expected an integer between 1 and 65535.`);
    }
    return { transport, host, port };
  }

  return {
    transport,
    host: DEFAULT_HTTP_HOST,
    port: DEFAULT_HTTP_PORT
  };
}

export {
  MCP_HTTP_PATH,
  parseCliArgs,
  resolveRuntimeConfig
};
