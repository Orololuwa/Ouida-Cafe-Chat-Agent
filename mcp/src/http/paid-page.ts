import type { Request, RequestHandler, Response } from "express";
import type { AppDeps } from "../deps.js";
import { verifyByPaystackRef } from "../domain/payments.js";

// GET /paid: where Paystack sends the customer back after checkout (or after cancelling).
// Public, because Paystack's redirect can't carry a bearer token. It never trusts the query string:
// the reference must match the attempt format and exist, and only Paystack's answer marks an order paid.
// Nothing from the query string is echoed except a known order reference.
export function paidPage(deps: AppDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    if (req.query.cancelled === "1") {
      send(res, "Payment cancelled", "Payment cancelled. Go back to WhatsApp if you'd like a new link.");
      return;
    }

    const reference = typeof req.query.reference === "string" ? req.query.reference : "";
    try {
      const check = await verifyByPaystackRef(deps, reference);
      if (!check.found) {
        console.log("[paid] unknown or missing reference");
        send(res, "Payment not found", "We couldn't find this payment. Go back to WhatsApp.");
        return;
      }
      console.log(`[paid] ${reference} -> ${check.result.status}`);
      if (check.result.status === "payment_confirmed" || check.result.status === "already_paid") {
        send(
          res,
          "Payment received",
          `Payment received for order ${check.order_ref}. Go back to WhatsApp and reply <strong>paid</strong> to confirm.`,
        );
        return;
      }
    } catch (err) {
      console.error("[paid] verification failed", err);
    }
    send(res, "Payment not confirmed", "We couldn't confirm this payment. Go back to WhatsApp and we'll help you finish.");
  };
}

// `body` is trusted markup built above, never raw query input.
function send(res: Response, title: string, body: string): void {
  res
    .status(200)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    })
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ouida Café</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #faf7f2; color: #2b2118;
         font: 18px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 26rem; margin: 1rem; padding: 2rem 1.5rem; background: #fff; border-radius: 16px;
         box-shadow: 0 2px 12px rgb(0 0 0 / 0.08); text-align: center; }
  h1 { margin: 0 0 0.25rem; font-size: 1rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #8a6d4b; }
  p { margin: 0.75rem 0 0; }
</style>
</head>
<body>
<main>
  <h1>Ouida Café</h1>
  <p>${body}</p>
</main>
</body>
</html>`);
}
