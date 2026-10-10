#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "./config.js";
import { createLiveServer } from "./server.js";

let config;
try {
  config = configFromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const live = createLiveServer({ config });
await live.mcp.connect(new StdioServerTransport());

// Try the engine once now so the first answer is fast; an unreachable engine is not fatal - every
// call reconnects and explains, and live_status reports the error. stdout is the MCP channel, so
// diagnostics go to stderr.
live.connection.ensureReady().then(
  () => console.error(`stp-mcp-live: connected to ${config.url}, session ${live.connection.session}`),
  (e: Error) => console.error(`stp-mcp-live: ${e.message} (will retry on the first call)`),
);
