import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../deps.js";
import { registerCreateOrder } from "./tools/create-order.js";
import { registerCreatePaymentLink } from "./tools/create-payment-link.js";
import { registerGetMenu } from "./tools/get-menu.js";
import { registerPing } from "./tools/ping.js";
import { registerVerifyPayment } from "./tools/verify-payment.js";

// What to tell the agent when one of these tools is called with no arguments (see http/empty-arguments.ts).
export const RETRY_HINTS: Record<string, string> = {
  create_order:
    "Call create_order again now with customer_name, the plates (item_id and qty for each item) and any drinks from the conversation.",
  create_payment_link:
    "Call create_payment_link again now with order_ref set to the OU-XXXX reference from your latest receipt in this conversation.",
  verify_payment: "Call verify_payment again now with order_ref set to the order's OU-XXXX reference from this conversation.",
};

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
