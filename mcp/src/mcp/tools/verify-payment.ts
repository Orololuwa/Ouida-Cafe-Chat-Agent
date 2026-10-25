import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { verifyPayment } from "../../domain/payments.js";
import { jsonResult, systemError } from "../result.js";

export function registerVerifyPayment(server: McpServer, deps: AppDeps): void {
  server.registerTool(
    "verify_payment",
    {
      title: "Verify payment",
      description:
        "Checks with Paystack whether an order has been paid. This is the only tool to call when the customer says paid or asks about a payment. Pass the order_ref from the receipt. Do not call get_menu or create_order on that turn. When this returns payment_confirmed or already_paid, follow send_to_customer: message_text is the entire reply. Do not apologise and do not add anything before or after it. Screenshots and the customer's word are not proof of payment.",
      inputSchema: {
        order_ref: z.string().describe("The order reference from create_order, e.g. OU-7KQ3"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ order_ref }) => {
      try {
        const result = await verifyPayment(deps, order_ref);
        console.log(`[tool] verify_payment ${result.order_ref} -> ${result.status}`);
        return jsonResult(result);
      } catch (err) {
        return systemError("verify_payment", err);
      }
    },
  );
}
