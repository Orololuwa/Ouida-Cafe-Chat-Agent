import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "../../db/index.js";
import { getMenu } from "../../domain/menu.js";
import { jsonResult, systemError } from "../result.js";

export function registerGetMenu(server: McpServer, db: Database): void {
  server.registerTool(
    "get_menu",
    {
      title: "Get menu",
      description:
        "Returns today's menu: every available item with its id, name, category, price in naira and any preparation note, plus the per-plate fee. Call this before telling a customer what is available or what anything costs. Use the ids from this result when calling create_order.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const menu = getMenu(db);
        console.log(`[tool] get_menu -> ${menu.status}${menu.status === "ok" ? ` (${menu.items.length} items)` : ""}`);
        return jsonResult(menu);
      } catch (err) {
        return systemError("get_menu", err);
      }
    },
  );
}
