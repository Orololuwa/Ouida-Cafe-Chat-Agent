import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../deps.js";
import { registerCreateOrder } from "./tools/create-order.js";
import { registerCreatePaymentLink } from "./tools/create-payment-link.js";
import { registerGetMenu } from "./tools/get-menu.js";
import { registerOwnerTools } from "./tools/owner.js";
import { registerPing } from "./tools/ping.js";
import { registerVerifyPayment } from "./tools/verify-payment.js";

// Builds a fresh MCP server with every tool registered.
// Stateless: one server per request, so there are no sessions to keep in memory.
// The database handle and Paystack client are created once at startup and shared.
export function buildServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: "ouida-order-desk", version: "0.1.1" });
  registerPing(server);
  registerGetMenu(server, deps.db);
  registerCreateOrder(server, deps.db);
  registerCreatePaymentLink(server, deps);
  registerVerifyPayment(server, deps);
  return server;
}

// The menu teammate's server. Only owner tools: a customer assignment cannot change prices.
export function buildOwnerServer(deps: AppDeps): McpServer {
  const server = new McpServer({ name: "ouida-menu-desk", version: "0.1.1" });
  registerOwnerTools(server, deps.db);
  return server;
}
