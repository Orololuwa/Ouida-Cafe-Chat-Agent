import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "../db/index.js";
import { buildServer } from "../mcp/server.js";
import { requireBearer } from "./auth.js";

export function createApp({ db, mcpToken }: { db: Database; mcpToken: string }): Express {
  const app = express();
  app.set("trust proxy", ["loopback", "uniquelocal"]); // behind Caddy: log the caller's real IP
  app.use(express.json({ limit: "1mb" }));

  const auth = requireBearer(mcpToken);

  // Unauthenticated health check: lets you confirm HTTPS works before involving Chord.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ouida-mcp", time: new Date().toISOString() });
  });

  app.post("/mcp", auth, async (req, res) => {
    const server = buildServer(db);
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
  app.get("/mcp", auth, methodNotAllowed);
  app.delete("/mcp", auth, methodNotAllowed);

  return app;
}
