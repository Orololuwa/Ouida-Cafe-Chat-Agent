import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8020);
// 127.0.0.1 when run directly; Docker sets HOST=0.0.0.0 so Caddy can reach it over the "web" network.
const HOST = process.env.HOST ?? "127.0.0.1";
const MCP_TOKEN = process.env.MCP_TOKEN;

if (!MCP_TOKEN || MCP_TOKEN.length < 32) {
  console.error("MCP_TOKEN is missing or shorter than 32 characters. Set it in .env.");
  process.exit(1);
}

// Builds a fresh MCP server with every tool registered.
// Stateless: one server per request, so there are no sessions to keep in memory.
function buildServer(): McpServer {
  const server = new McpServer({ name: "ouida-order-desk", version: "0.1.0" });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Connectivity check. Returns 'pong' and the server time. Call this only when someone asks you to test the connection to the order system.",
      inputSchema: {},
    },
    async () => {
      const at = new Date().toISOString();
      console.log(`[tool] ping at ${at}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "pong", server_time: at }) }],
      };
    },
  );

  return server;
}

// Bearer-token check so only Chord (which holds the token) can call the tools.
function requireBearer(req: Request, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(MCP_TOKEN!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    console.warn(`[auth] rejected request from ${req.ip}`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const app = express();
app.set("trust proxy", ["loopback", "uniquelocal"]); // behind Caddy: log the caller's real IP
app.use(express.json({ limit: "1mb" }));

// Unauthenticated health check: lets you confirm HTTPS works before involving Chord.
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ouida-mcp", time: new Date().toISOString() });
});

app.post("/mcp", requireBearer, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true, // plain JSON replies, so no streaming through proxies
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    console.log(`[mcp] ${req.body?.method ?? "unknown method"}`);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error handling request", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Stateless servers don't support the GET (server-to-client stream) or DELETE (end session) routes.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", requireBearer, methodNotAllowed);
app.delete("/mcp", requireBearer, methodNotAllowed);

app.listen(PORT, HOST, () => {
  console.log(`ouida-mcp listening on http://${HOST}:${PORT}`);
});
