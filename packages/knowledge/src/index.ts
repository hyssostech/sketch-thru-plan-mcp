#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createKnowledgeServer } from "./server.js";

const server = createKnowledgeServer();
await server.connect(new StdioServerTransport());
