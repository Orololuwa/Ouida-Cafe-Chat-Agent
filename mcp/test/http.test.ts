import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createPaymentLink } from "../src/domain/payments.js";
import { getOrder } from "../src/domain/orders.js";
import { createApp } from "../src/http/app.js";
import { createPaystackClient } from "../src/integrations/paystack.js";
import { makeDeps, ororoOrder } from "./helpers.js";

// ---------- the /paid callback page ----------

const deps = makeDeps();
let server: Server;
let base = "";

before(async () => {
  server = createApp(deps, { mcpToken: "t".repeat(32), ownerMcpToken: "o".repeat(32) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const page = async (query: string) => {
  const res = await fetch(`${base}/paid${query}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  return res.text();
};

test("4. /paid verifies with Paystack and marks the order paid", async () => {
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });

  assert.match(await page(`?trxref=${ref}-1&reference=${ref}-1`), /couldn't confirm this payment/);
  assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");

  deps.paystack.pay(`${ref}-1`);
  const html = await page(`?trxref=${ref}-1&reference=${ref}-1`);
  assert.match(html, new RegExp(`Payment received for order ${ref}\\. Go back to WhatsApp and reply <strong>paid</strong>`));
  assert.equal(getOrder(deps.db, ref)!.status, "paid");
  assert.doesNotMatch(html, /<script/i);
});

test("10. /paid?cancelled=1 shows the cancelled message", async () => {
  assert.match(await page("?cancelled=1"), /Payment cancelled\. Go back to WhatsApp if you'd like a new link\./);
});

test("/paid never echoes or looks up a malformed reference", async () => {
  const before = deps.paystack.verifyCalls.length;
  for (const q of ["", "?reference=OU-ZZZZ-1", "?reference=%3Cscript%3Ealert(1)%3C%2Fscript%3E", "?reference=OU-ZZZZ"]) {
    const html = await page(q);
    assert.match(html, /We couldn't find this payment/);
    assert.doesNotMatch(html, /alert\(1\)|OU-ZZZZ/);
  }
  assert.equal(deps.paystack.verifyCalls.length, before);
});

test("/mcp still needs the bearer token; /paid does not", async () => {
  assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 401);
});

// Calls a tool through the real MCP endpoint, so the SDK's schema validation runs too.
async function callTool(name: string, args: unknown): Promise<{ isError?: boolean; payload: Record<string, unknown> | string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${"t".repeat(32)}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const { result } = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  const text = result.content[0].text;
  return { isError: result.isError, payload: result.isError ? text : JSON.parse(text) };
}

test("Optional fields sent as null are treated as not given", async () => {
  const order = await callTool("create_order", {
    customer_name: "Feyi",
    customer_handle: null,
    plates: [{ label: null, items: [{ item_id: "catfish-pepper-soup", qty: 1, note: null }] }],
    drinks: null,
  });
  assert.ok(!order.isError, String(order.payload));
  assert.ok(typeof order.payload === "object");
  assert.equal(order.payload.status, "order_created");
  assert.equal(order.payload.total_ngn, 2700);
  const ref = order.payload.order_ref as string;

  const link = await callTool("create_payment_link", { order_ref: ref, new_link: null });
  assert.ok(!link.isError, String(link.payload));
  assert.ok(typeof link.payload === "object");
  assert.equal(link.payload.status, "link_ready");
  assert.equal(link.payload.paystack_ref, `${ref}-1`);

  // The exact shape agents sent in production: get_menu's `id` and `quantity` instead of item_id and qty.
  const aliased = await callTool("create_order", {
    customer_name: "bola",
    plates: [
      { label: "Plate 1", items: [{ id: "asun", quantity: 1 }] },
      { label: "Plate 2", items: [{ id: "asun", quantity: 1 }] },
    ],
    drinks: [],
  });
  assert.ok(!aliased.isError, String(aliased.payload));
  assert.ok(typeof aliased.payload === "object");
  assert.equal(aliased.payload.total_ngn, 6400);

  // A reference wrapped in WhatsApp bold or a sentence still finds the order.
  for (const wrapped of [`*${ref}*`, `Order ${ref}`, ref.toLowerCase()]) {
    const r = await callTool("verify_payment", { order_ref: wrapped });
    assert.ok(typeof r.payload === "object");
    assert.equal(r.payload.status, "payment_not_completed", wrapped);
    assert.equal(r.payload.order_ref, ref);
  }
});

// ---------- the real Paystack client, against a local stand-in for api.paystack.co ----------

test("Paystack client sends the documented fields and reads data.status", async () => {
  const seen: { method?: string; url?: string; auth?: string; body?: unknown }[] = [];
  const mock = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer sk_test_good") {
      res.statusCode = 401;
      res.end(JSON.stringify({ status: false, message: "Invalid key" }));
    } else if (req.url === "/transaction/initialize") {
      res.end(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/abc", reference: "OU-7KQ3-1" } }));
    } else if (req.url === "/transaction/verify/OU-7KQ3-1") {
      res.end(JSON.stringify({ status: true, data: { status: "failed", amount: 1140000, currency: "NGN", gateway_response: "Declined" } }));
    } else if (req.url === "/transaction/verify/slow") {
      setTimeout(() => res.end("{}"), 500);
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ status: false, message: "Transaction reference not found" }));
    }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => mock.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

  try {
    const paystack = createPaystackClient("sk_test_good", { baseUrl, timeoutMs: 200 });
    const init = await paystack.initialize({
      email: "ou-7kq3@orders.example.test",
      amountKobo: 1140000,
      reference: "OU-7KQ3-1",
      callbackUrl: "https://x.test/paid",
      metadata: { order_ref: "OU-7KQ3", cancel_action: "https://x.test/paid?cancelled=1" },
    });
    assert.deepEqual(init, { ok: true, authorizationUrl: "https://checkout.paystack.com/abc" });
    assert.deepEqual(seen[0], {
      method: "POST",
      url: "/transaction/initialize",
      auth: "Bearer sk_test_good",
      body: {
        email: "ou-7kq3@orders.example.test",
        amount: "1140000",
        currency: "NGN",
        reference: "OU-7KQ3-1",
        callback_url: "https://x.test/paid",
        metadata: { order_ref: "OU-7KQ3", cancel_action: "https://x.test/paid?cancelled=1" },
      },
    });

    assert.deepEqual(await paystack.verify("OU-7KQ3-1"), {
      ok: true,
      transaction: { status: "failed", amount: 1140000, currency: "NGN", gatewayResponse: "Declined" },
    });
    assert.deepEqual(await paystack.verify("OU-NOPE-1"), { ok: false, error: "Paystack 400: Transaction reference not found" });

    const timedOut = await paystack.verify("slow");
    assert.equal(timedOut.ok, false);

    const badKey = createPaystackClient("sk_test_wrong", { baseUrl });
    assert.deepEqual(await badKey.verify("OU-7KQ3-1"), { ok: false, error: "Paystack 401: Invalid key" });

    const unreachable = createPaystackClient("sk_test_good", { baseUrl: "http://127.0.0.1:1" });
    const down = await unreachable.verify("OU-7KQ3-1");
    assert.ok(!down.ok && down.error.startsWith("Paystack unreachable"));
  } finally {
    mock.closeAllConnections();
    mock.close();
  }
});
