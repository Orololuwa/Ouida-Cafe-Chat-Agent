import express, { type Express, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppDeps } from "../deps.js";
import { buildServer } from "../mcp/server.js";
import { requireBearer } from "./auth.js";
import { paidPage } from "./paid-page.js";

export function createApp(deps: AppDeps, { mcpToken }: { mcpToken: string }): Express {
  const app = express();
  app.set("trust proxy", ["loopback", "uniquelocal"]); // behind Caddy: log the caller's real IP
  app.use(express.json({ limit: "1mb" }));

  const auth = requireBearer(mcpToken);

  // Unauthenticated health check: lets you confirm HTTPS works before involving Chord.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "ouida-mcp", time: new Date().toISOString() });
  });

  // Public: Paystack returns the customer here after checkout. See paid-page.ts.
  app.get("/paid", paidPage(deps));

  app.post("/mcp", auth, async (req, res) => {
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON replies, so no streaming through proxies
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      const method: string = req.body?.method ?? "unknown method";
      const tool: unknown = method === "tools/call" ? req.body?.params?.name : undefined;
      console.log(`[mcp] ${method}${typeof tool === "string" ? ` ${tool}` : ""}`);
      if (method === "tools/call") logRejections(res, String(tool), req.body?.params?.arguments);
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

// The SDK rejects unknown tools and arguments that don't match a tool's schema before our handlers
// run, so nothing else would log them. Watch the response and log those rejections with what was sent.
function logRejections(res: Response, tool: string, args: unknown): void {
  const chunks: Buffer[] = [];
  const collect = (chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => Response;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    collect(chunk);
    return write(chunk, ...rest);
  }) as Response["write"];
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== "function") collect(chunk);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text: unknown = body?.result?.content?.[0]?.text;
      if (body?.result?.isError && typeof text === "string" && text.startsWith("MCP error")) {
        console.warn(`[mcp] ${tool} rejected: ${text} | arguments: ${JSON.stringify(args)?.slice(0, 500)}`);
      }
    } catch {
      // Not a JSON body (or not one we recognise): nothing to log.
    }
    return end(chunk, ...rest);
  }) as Response["end"];
}
