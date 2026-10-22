import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Business outcomes (including "item not found") are normal results carrying a `status`.
export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// Only unexpected failures become tool errors. The detail goes to the logs, never to the agent.
export function systemError(tool: string, err: unknown): CallToolResult {
  console.error(`[tool] ${tool} failed`, err);
  return { isError: true, content: [{ type: "text", text: "Order system unavailable" }] };
}
