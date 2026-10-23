import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { createPaymentLink } from "../../domain/payments.js";
import { jsonResult, systemError } from "../result.js";

export function registerCreatePaymentLink(server: McpServer, deps: AppDeps): void {
  server.registerTool(
    "create_payment_link",
    {
      title: "Create payment link",
      description:
        "Returns a Paystack payment link for an order. Call this once the customer has confirmed the order. Pass the order_ref from create_order. Set new_link to true only if the customer says the previous link failed or didn't work. Send the link and amount to the customer as returned.",
      inputSchema: {
        order_ref: z.string().describe("The order reference from create_order, e.g. OU-7KQ3"),
        new_link: z
          .boolean()
          .optional()
          .describe("true only if the customer says the previous link failed or didn't work"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const result = await createPaymentLink(deps, input);
        console.log(
          `[tool] create_payment_link ${result.order_ref} -> ${result.status}` +
            (result.status === "link_ready" ? ` ${result.paystack_ref}` : ""),
        );
        return jsonResult(result);
      } catch (err) {
        return systemError("create_payment_link", err);
      }
    },
  );
}
