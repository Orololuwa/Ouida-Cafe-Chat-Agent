import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import { createOrder, LIMITS } from "../../domain/orders.js";
import { jsonResult, systemError } from "../result.js";

// The schema only fixes the shape. Ranges and lengths are checked in createOrder so that every
// problem comes back in one result with a status code, rather than as a schema error.
// Optional fields are .nullish(): agents often send null for a field they aren't using.
const lineShape = z.object({
  item_id: z.string().describe("The item's `id` from get_menu, e.g. jollof-chicken"),
  qty: z.number().describe(`How many: a whole number from ${LIMITS.qtyMin} to ${LIMITS.qtyMax}`),
  note: z
    .string()
    .nullish()
    .describe(`Optional brand choice or kitchen request, max ${LIMITS.noteMax} characters`),
});

// Agents copy get_menu's field names and send { id, quantity }. Accept those as aliases.
// The advertised schema still shows only item_id and qty.
const line = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { id, quantity, ...rest } = value as Record<string, unknown>;
  return { ...rest, item_id: rest.item_id ?? id, qty: rest.qty ?? quantity };
}, lineShape);

const inputSchema = {
  customer_name: z.string().describe(`Name on the order, 1–${LIMITS.nameMax} characters`),
  customer_handle: z
    .string()
    .nullish()
    .describe("The customer's WhatsApp or simulator identity, if the conversation provides it"),
  plates: z
    .array(
      z.object({
        label: z.string().nullish().describe("Whose plate this is, e.g. Ada. Leave it out unless the plate is for a named person"),
        items: z.array(line).describe("Food, protein and sweet items on this plate"),
      }),
    )
    .nullish()
    .describe(`Plates of food, at most ${LIMITS.platesMax}`),
  drinks: z.array(line).nullish().describe("Drinks and hot drinks; these never go on a plate"),
};

export function registerCreateOrder(server: McpServer, db: Database): void {
  server.registerTool(
    "create_order",
    {
      title: "Create order",
      description:
        "Creates a lunch order and calculates its total. Pass the customer's name, each plate's items (ids from get_menu and quantities) and any drinks. Never pass prices: the server prices everything. Returns an order reference and a receipt to send to the customer as written, or a status explaining what needs fixing. Call this once per order, before the customer confirms. When the customer confirms, call create_payment_link instead: never create_order again unless the order changed.",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = createOrder(db, input);
        console.log(
          result.status === "order_created" || result.status === "order_already_created"
            ? `[tool] create_order -> ${result.status} ${result.order_ref} (plates: ${result.plate_count}, total: ₦${result.total_ngn})`
            : `[tool] create_order -> ${result.status}`,
        );
        return jsonResult(result);
      } catch (err) {
        return systemError("create_order", err);
      }
    },
  );
}
