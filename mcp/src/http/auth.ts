import type { NextFunction, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "node:crypto";

// Bearer-token check so only Chord (which holds the token) can call the tools.
export function requireBearer(token: string): RequestHandler {
  const expected = Buffer.from(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      console.warn(`[auth] rejected request from ${req.ip}`);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
