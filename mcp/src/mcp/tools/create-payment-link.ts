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
        "Returns a Paystack payment link for an order. This is the only tool to call once the customer has said yes to a receipt. Pass the order_ref from that receipt. Do not call get_menu or create_order on that turn. Set new_link to true only if the customer says the previous link failed or didn't work. The whole reply to the customer is message_text.",
      inputSchema: {
        order_ref: z.string().describe("The order reference from create_order, e.g. OU-7KQ3"),
        new_link: z
          .boolean()
          .nullish() // agents often send null for a field they aren't using
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
