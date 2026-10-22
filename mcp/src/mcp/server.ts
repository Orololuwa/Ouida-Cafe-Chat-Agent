import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../db/index.js";
import { registerCreateOrder } from "./tools/create-order.js";
import { registerGetMenu } from "./tools/get-menu.js";
import { registerPing } from "./tools/ping.js";

// Builds a fresh MCP server with every tool registered.
// Stateless: one server per request, so there are no sessions to keep in memory.
// The database handle is opened once at startup and shared.
export function buildServer(db: Database): McpServer {
  const server = new McpServer({ name: "ouida-order-desk", version: "0.1.1" });
  registerPing(server);
  registerGetMenu(server, db);
  registerCreateOrder(server, db);
  return server;
}
