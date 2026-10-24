import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import { listMenu, setAvailability, setTodaysMenu, todaysOrders, updatePrice } from "../../domain/owner.js";
import { jsonResult, systemError } from "../result.js";

export function registerOwnerTools(server: McpServer, db: Database): void {
  server.registerTool(
    "list_menu",
    {
      title: "List menu",
      description:
        "Returns every menu item with its id, name, category, price in naira and whether customers can order it today. Call this before changing anything, and use its ids in other tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = listMenu(db);
        console.log(`[tool] list_menu -> ${result.status}${result.status === "ok" ? ` (${result.items.length} items)` : ""}`);
        return jsonResult(result);
      } catch (err) {
        return systemError("list_menu", err);
      }
    },
  );

  server.registerTool(
    "set_availability",
    {
      title: "Set availability",
      description:
        "Switches menu items on or off for customers, for example when something sells out or comes back. Pass item ids from list_menu. Confirm the exact change with the owner first.",
      inputSchema: {
        changes: z
          .array(
            z.object({
              item_id: z.string().describe("The item's id from list_menu"),
              available: z.boolean().describe("true if customers can order it, false if it is off today"),
            }),
          )
          .describe("The items to switch, from 1 to 33"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = setAvailability(db, input);
        console.log(`[tool] set_availability -> ${result.status}`);
        return jsonResult(result);
      } catch (err) {
        return systemError("set_availability", err);
      }
    },
  );

  server.registerTool(
    "update_price",
    {
      title: "Update price",
      description:
        "Changes the price of one menu item for new orders. Pass the item id from list_menu and the new price in whole naira. Confirm the item and both prices with the owner before calling. Existing orders keep their price.",
      inputSchema: {
        item_id: z.string().describe("The item's id from list_menu"),
        price_ngn: z.number().describe("New price in whole naira, from 100 to 100,000"),
        confirmed_large_change: z
          .boolean()
          .nullish()
          .describe("true only after the owner confirms a change of more than 50% a second time"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = updatePrice(db, input);
        console.log(`[tool] update_price ${input.item_id} -> ${result.status}`);
        return jsonResult(result);
      } catch (err) {
        return systemError("update_price", err);
      }
    },
  );

  server.registerTool(
    "todays_orders",
    {
      title: "Today's orders",
      description:
        "Returns today's paid orders: how many, the total taken, the quantity of each item to prepare, and the most recent orders. Use it when the owner asks about orders, sales or what to cook. Today is the calendar day in Lagos.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = todaysOrders(db);
        console.log(
          `[tool] todays_orders -> ${result.status}${result.status === "ok" ? ` (${result.paid_count} paid)` : ""}`,
        );
        return jsonResult(result);
      } catch (err) {
        return systemError("todays_orders", err);
      }
    },
  );

  server.registerTool(
    "set_todays_menu",
    {
      title: "Set today's menu",
      description:
        "Sets today's food menu in one go: the listed food, protein and sweet items are switched on and every other food, protein and sweet item is switched off. Drinks are not affected. Read the full on/off list back to the owner and get a yes before calling.",
      inputSchema: {
        available_item_ids: z
          .array(z.string())
          .describe("Food, protein and sweet ids that should be on today. Do not include drinks."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const result = setTodaysMenu(db, input);
        console.log(`[tool] set_todays_menu -> ${result.status}`);
        return jsonResult(result);
      } catch (err) {
        return systemError("set_todays_menu", err);
      }
    },
  );
}
