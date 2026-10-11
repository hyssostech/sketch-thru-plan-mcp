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

let live;
try {
  live = createLiveServer({ config });
} catch (e) {
  // e.g. an STP_ACTION_LOG path that cannot be written: stop now rather than lose the log later
  console.error(`stp-mcp-live: cannot start: ${(e as Error).message}`);
  process.exit(2);
}
const server = live;
await server.mcp.connect(new StdioServerTransport());
console.error(
  `stp-mcp-live: ${server.mode === "off" ? "read-only" : server.mode === "write" ? "write mode (STP_WRITE)" : "write and destructive mode (STP_WRITE, STP_DESTRUCTIVE)"}` +
    `${config.actionLog ? `, action log ${config.actionLog}` : ""}`,
);

// Try the engine once now so the first answer is fast; an unreachable engine is not fatal - every
// call reconnects and explains, and live_status reports the error. stdout is the MCP channel, so
// diagnostics go to stderr.
server.connection.ensureReady().then(
  () => console.error(`stp-mcp-live: connected to ${config.url}, session ${server.connection.session}`),
  (e: Error) => console.error(`stp-mcp-live: ${e.message} (will retry on the first call)`),
);
