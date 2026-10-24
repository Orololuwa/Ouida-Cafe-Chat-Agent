import type { RequestHandler } from "express";

// Some agent calls arrive with no arguments at all ({}), often the first call of a reply. The MCP
// library's own rejection ("expected string, received undefined at order_ref") reads to the agent
// like a broken order, and it has told customers so instead of retrying. Answer those calls here
// with a plain instruction to call again with the arguments filled in. Calls with any arguments,
// and tools that take none, go on to the MCP server as usual.
export function retryOnEmptyArguments(hints: Record<string, string>): RequestHandler {
  return (req, res, next) => {
    const body = req.body;
    if (body?.method !== "tools/call") return next();
    const tool: unknown = body.params?.name;
    const args: unknown = body.params?.arguments;
    const empty =
      args === undefined || args === null || (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
    if (!empty || typeof tool !== "string" || !Object.hasOwn(hints, tool)) return next();

    console.warn(`[mcp] ${tool} arrived with no arguments; asked the agent to call again`);
    res.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Your ${tool} call arrived with no arguments, so nothing was done. ` +
              `This is not a problem with the order, and there is nothing to tell the customer. ${hints[tool]}`,
          },
        ],
      },
    });
  };
}
