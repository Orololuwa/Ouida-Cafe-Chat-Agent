import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createOrder } from "../src/domain/orders.js";
import { createApp } from "../src/http/app.js";
import type { AppDeps } from "../src/deps.js";
import { makeDeps, ororoOrder } from "./helpers.js";

const TOKEN = "t".repeat(32);
let server: Server;
let base = "";

before(async () => {
  server = createApp(makeDeps(), { mcpToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(url: string, name: string, args: unknown) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { id: number; result: { isError?: boolean; content: { text: string }[] } };
}

function body(r: { result: { content: { text: string }[] } }) {
  return JSON.parse(r.result.content[0].text) as {
    status: string;
    say_nothing_to_customer?: boolean;
    order_ref?: string;
    next_step: string;
  };
}

test("A call that arrives with no arguments names the next tool and is not an error", async () => {
  for (const args of [{}, undefined, null]) {
    const r = await call(base, "create_payment_link", args);
    assert.equal(r.id, 7);
    assert.equal(r.result.isError, undefined);
    const parsed = body(r);
    assert.equal(parsed.status, "ignored_empty_call");
    assert.equal(parsed.say_nothing_to_customer, true);
    assert.match(parsed.next_step, /Say nothing to the customer.*Call create_payment_link now/s);
    assert.doesNotMatch(parsed.next_step, /retry|filled in/i);
  }
  const order = body(await call(base, "create_order", {}));
  assert.match(order.next_step, /If their latest message is paid, call verify_payment/);
  assert.match(order.next_step, /If their latest message is yes, call create_payment_link/);
  const verify = body(await call(base, "verify_payment", {}));
  assert.match(verify.next_step, /Call verify_payment now/);
});

test("Tools without arguments, and calls with arguments, are not intercepted", async () => {
  const menu = await call(base, "get_menu", {});
  assert.ok(!menu.result.isError);
  assert.equal(JSON.parse(menu.result.content[0].text).status, "ok");
  const notFound = await call(base, "verify_payment", { order_ref: "OU-ZZZZ" });
  assert.equal(JSON.parse(notFound.result.content[0].text).status, "order_not_found");
});

async function withOrders(setup: (deps: AppDeps) => void, run: (url: string) => Promise<void>) {
  const deps = makeDeps();
  setup(deps);
  const s = createApp(deps, { mcpToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => s.once("listening", resolve));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    await run(url);
  } finally {
    s.close();
  }
}

test("An empty create_order names the only recent order, and a paid one points at verify_payment", async () => {
  await withOrders(
    (deps) => {
      const ref = ororoOrder(deps);
      deps.db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE ref = ?").run(new Date().toISOString(), ref);
    },
    async (url) => {
      const parsed = body(await call(url, "create_order", {}));
      assert.equal(parsed.status, "ignored_empty_call");
      assert.match(parsed.next_step, new RegExp(`Order ${parsed.order_ref} is already paid`));
      assert.match(parsed.next_step, /call verify_payment now/);
      assert.doesNotMatch(parsed.next_step, /call create_order again now with customer_name/);
    },
  );
});

test("An empty create_order for one unpaid order offers the payment link or a payment check", async () => {
  await withOrders(
    (deps) => {
      ororoOrder(deps);
    },
    async (url) => {
      const parsed = body(await call(url, "create_order", {}));
      assert.match(parsed.next_step, /already saved/);
      assert.match(parsed.next_step, new RegExp(`create_payment_link with order_ref ${parsed.order_ref}`));
      assert.match(parsed.next_step, new RegExp(`verify_payment with order_ref ${parsed.order_ref}`));
    },
  );
});

test("Several recent orders are not collapsed onto one reference", async () => {
  await withOrders(
    (deps) => {
      ororoOrder(deps);
      const second = createOrder(deps.db, { customer_name: "Chief", plates: [{ items: [{ item_id: "asun", qty: 1 }] }] });
      assert.equal(second.status, "order_created");
    },
    async (url) => {
      const parsed = body(await call(url, "create_order", {}));
      assert.equal(parsed.order_ref, undefined);
      assert.match(parsed.next_step, /the OU-XXXX from the receipt already in this chat/);
    },
  );
});
