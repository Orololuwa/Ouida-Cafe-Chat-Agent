import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "../result.js";

export function registerPing(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Connectivity check. Returns 'pong' and the server time. Call this only when someone asks you to test the connection to the order system.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const at = new Date().toISOString();
      console.log(`[tool] ping at ${at}`);
      return jsonResult({ status: "pong", server_time: at });
    },
  );
}
