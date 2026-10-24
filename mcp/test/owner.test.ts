import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { openDatabase, type Database } from "../src/db/index.js";
import { getMenu } from "../src/domain/menu.js";
import { createOrder, getOrder } from "../src/domain/orders.js";
import {
  listMenu,
  setAvailability,
  setTodaysMenu,
  todaysOrders,
  updatePrice,
} from "../src/domain/owner.js";
import { createApp } from "../src/http/app.js";
import { makeDeps } from "./helpers.js";

const one = (item_id: string) => ({ item_id, qty: 1 });
const ORDERS = "t".repeat(32);
const OWNER = "o".repeat(32);

function changes(db: Database) {
  return db
    .prepare("SELECT item_id, field, old_value, new_value, via FROM menu_changes ORDER BY id")
    .all() as { item_id: string; field: string; old_value: string; new_value: string; via: string }[];
}

function priceOf(db: Database, id: string) {
  return (db.prepare("SELECT price_ngn, available FROM catalogue WHERE id = ?").get(id) as { price_ngn: number; available: number });
}

test("3. list_menu returns every item, including ones that are off", () => {
  const db = openDatabase(":memory:");
  const menu = listMenu(db);
  assert.equal(menu.status, "ok");
  if (menu.status !== "ok") return;
  assert.equal(menu.items.length, 33);
  assert.equal(menu.plate_fee_ngn, 200);
  assert.ok(menu.items.every((item) => item.available));
  assert.match(menu.summary_text, /\*Available:\* 33 items\n\*Off today:\* none/);

  assert.equal(setAvailability(db, { changes: [{ item_id: "asun", available: false }] }).status, "availability_updated");
  const again = listMenu(db);
  assert.equal(again.status, "ok");
  if (again.status !== "ok") return;
  assert.equal(again.items.find((item) => item.id === "asun")?.available, false);
  assert.match(again.summary_text, /\*Available:\* 32 items\n\*Off today:\* Asun/);
});

test("4–6. set_availability hides an item from customers, and one unknown id changes nothing", () => {
  const db = openDatabase(":memory:");
  const off = setAvailability(db, { changes: [{ item_id: "jollof-chicken", available: false }] });
  assert.equal(off.status, "availability_updated");
  if (off.status !== "availability_updated") return;
  assert.equal(off.summary_text, "Off for customers: Jollof Rice with Chicken");
  const hidden = getMenu(db);
  assert.equal(hidden.status, "ok");
  if (hidden.status !== "ok") return;
  assert.equal(hidden.items.some((item) => item.id === "jollof-chicken"), false);
  const refused = createOrder(db, { customer_name: "Chief", plates: [{ items: [one("jollof-chicken")] }] });
  assert.equal(refused.status, "item_unavailable");

  const back = setAvailability(db, { changes: [{ item_id: "jollof-chicken", available: true }] });
  assert.equal(back.status, "availability_updated");
  if (back.status !== "availability_updated") return;
  assert.equal(back.summary_text, "Back for customers: Jollof Rice with Chicken");
  const shown = getMenu(db);
  assert.equal(shown.status, "ok");
  if (shown.status !== "ok") return;
  assert.ok(shown.items.some((item) => item.id === "jollof-chicken"));

  assert.equal(
    setAvailability(db, { changes: [{ item_id: "jollof-chicken", available: true }] }).status,
    "no_changes",
  );
  const before = priceOf(db, "asun").available;
  const mixed = setAvailability(db, {
    changes: [
      { item_id: "not-a-dish", available: false },
      { item_id: "asun", available: false },
    ],
  });
  assert.deepEqual(mixed, { status: "item_not_found", item_ids: ["not-a-dish"] });
  assert.equal(priceOf(db, "asun").available, before);
  assert.deepEqual(
    changes(db).map((row) => row.via),
    ["set_availability", "set_availability"],
  );
});

test("7–10. update_price keeps old orders, blocks a large jump until it is confirmed, and logs each real change", () => {
  const db = openDatabase(":memory:");
  const t0 = new Date("2026-10-24T12:00:00Z");
  const earlier = createOrder(db, { customer_name: "Ororo", plates: [{ items: [one("jollof-chicken")] }] }, t0);
  assert.equal(earlier.status, "order_created");
  if (earlier.status !== "order_created") return;

  assert.equal(setAvailability(db, { changes: [{ item_id: "jollof-chicken", available: false }] }, t0).status, "availability_updated");
  assert.equal(setAvailability(db, { changes: [{ item_id: "jollof-chicken", available: true }] }, t0).status, "availability_updated");

  const updated = updatePrice(db, { item_id: "jollof-chicken", price_ngn: 5000 }, t0);
  assert.equal(updated.status, "price_updated");
  if (updated.status !== "price_updated") return;
  assert.equal(updated.summary_text, "Jollof Rice with Chicken: ₦4,500 → ₦5,000 for new orders");
  assert.equal(getOrder(db, earlier.order_ref)!.total_ngn, earlier.total_ngn);

  const later = createOrder(db, { customer_name: "Ada", plates: [{ items: [one("jollof-chicken")] }] }, t0);
  assert.equal(later.status, "order_created");
  if (later.status !== "order_created") return;
  assert.equal(later.total_ngn, earlier.total_ngn + 500);

  const jump = updatePrice(db, { item_id: "jollof-chicken", price_ngn: 45000 });
  assert.equal(jump.status, "large_change_needs_confirmation");
  if (jump.status !== "large_change_needs_confirmation") return;
  assert.equal(jump.old_price_ngn, 5000);
  assert.equal(jump.price_ngn, 45000);
  assert.equal(jump.change_percent, 800);
  assert.equal(priceOf(db, "jollof-chicken").price_ngn, 5000);

  const saved = updatePrice(db, { item_id: "jollof-chicken", price_ngn: 45000, confirmed_large_change: true });
  assert.equal(saved.status, "price_updated");
  assert.equal(priceOf(db, "jollof-chicken").price_ngn, 45000);

  assert.equal(updatePrice(db, { item_id: "jollof-chicken", price_ngn: 50 }).status, "invalid_price");
  assert.equal(updatePrice(db, { item_id: "jollof-chicken", price_ngn: 45000 }).status, "no_changes");
  assert.deepEqual(updatePrice(db, { item_id: "nope", price_ngn: 5000 }), { status: "item_not_found", item_id: "nope" });

  assert.deepEqual(
    changes(db).map(({ item_id, field, old_value, new_value, via }) => ({ item_id, field, old_value, new_value, via })),
    [
      { item_id: "jollof-chicken", field: "available", old_value: "true", new_value: "false", via: "set_availability" },
      { item_id: "jollof-chicken", field: "available", old_value: "false", new_value: "true", via: "set_availability" },
      { item_id: "jollof-chicken", field: "price_ngn", old_value: "4500", new_value: "5000", via: "update_price" },
      { item_id: "jollof-chicken", field: "price_ngn", old_value: "5000", new_value: "45000", via: "update_price" },
    ],
  );
});

test("A price move of exactly 50% is saved, and one naira past that waits for confirmation", () => {
  const db = openDatabase(":memory:");
  assert.equal(updatePrice(db, { item_id: "jollof-chicken", price_ngn: 6750 }).status, "price_updated");
  assert.equal(updatePrice(db, { item_id: "jollof-chicken", price_ngn: 10126 }).status, "large_change_needs_confirmation");
  assert.equal(priceOf(db, "jollof-chicken").price_ngn, 6750);
});

test("11. todays_orders counts paid orders from the Lagos day only", () => {
  const db = openDatabase(":memory:");
  const today = new Date("2026-10-24T12:00:00Z"); // 13:00 in Lagos
  const ororo = createOrder(
    db,
    {
      customer_name: "Ororo",
      plates: [
        { label: "Ororo", items: [one("jollof-chicken"), one("dodo")] },
        { label: "Ada", items: [one("rice-pepper-sauce-beef"), one("boiled-egg")] },
      ],
      drinks: [{ item_id: "zobo-glass", qty: 2 }],
    },
    today,
  );
  const ade = createOrder(
    db,
    { customer_name: "Ade", plates: [{ items: [one("dundu-egg-sauce")] }, { items: [one("dundu-egg-sauce")] }, { items: [one("dundu-egg-sauce")] }], drinks: [{ item_id: "water-small", qty: 3 }] },
    today,
  );
  const unpaid = createOrder(db, { customer_name: "Sola", drinks: [one("zobo-glass")] }, today);
  assert.equal(ororo.status, "order_created");
  assert.equal(ade.status, "order_created");
  assert.equal(unpaid.status, "order_created");
  if (ororo.status !== "order_created" || ade.status !== "order_created") return;

  const mark = (ref: string, at: Date) =>
    db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, paid_reference = ? WHERE ref = ?").run(at.toISOString(), `${ref}-1`, ref);
  mark(ororo.order_ref, new Date("2026-10-24T11:00:00Z"));
  mark(ade.order_ref, new Date("2026-10-24T12:09:00Z"));
  // 23:30 UTC is 00:30 the next Lagos day, so it must not be counted.
  const tomorrow = createOrder(db, { customer_name: "Bola", plates: [{ items: [one("asun")] }] }, today);
  assert.equal(tomorrow.status, "order_created");
  if (tomorrow.status !== "order_created") return;
  mark(tomorrow.order_ref, new Date("2026-10-24T23:30:00Z"));

  const report = todaysOrders(db, today);
  assert.equal(report.status, "ok");
  if (report.status !== "ok") return;
  assert.equal(report.date, "2026-10-24");
  assert.equal(report.paid_count, 2);
  assert.equal(report.paid_total_ngn, 22500);
  assert.equal(report.pending_count, 1);
  assert.equal(report.plates, 5);
  assert.deepEqual(report.to_prepare[0], { item_id: "dundu-egg-sauce", name: "Dundu and Egg Sauce", qty: 3 });
  assert.deepEqual(
    report.recent.map((order) => order.order_ref),
    [ade.order_ref, ororo.order_ref],
  );
  assert.match(report.summary_text, /\*Today so far:\* 2 paid orders, ₦22,500/);
  assert.match(report.summary_text, /3× Dundu and Egg Sauce/);
  assert.match(report.summary_text, /1 order waiting for payment/);

  assert.equal(todaysOrders(db, new Date("2026-10-23T12:00:00Z")).status, "no_orders_yet");
});

test("12. set_todays_menu switches plate items only", () => {
  const db = openDatabase(":memory:");
  const set = setTodaysMenu(db, { available_item_ids: ["jollof-chicken", "dodo"] });
  assert.equal(set.status, "todays_menu_set");
  if (set.status !== "todays_menu_set") return;
  assert.equal(set.turned_on.length, 0);
  assert.equal(set.turned_off.length, 19);
  assert.equal(priceOf(db, "jollof-chicken").available, 1);
  assert.equal(priceOf(db, "dodo").available, 1);
  assert.equal(priceOf(db, "asun").available, 0);
  assert.equal(priceOf(db, "espresso").available, 1);
  assert.equal(priceOf(db, "water-small").available, 1);
  const menu = getMenu(db);
  assert.equal(menu.status, "ok");
  if (menu.status !== "ok") return;
  assert.equal(menu.items.length, 14);

  const unknown = setTodaysMenu(db, { available_item_ids: ["jollof-chicken", "not-a-dish"] });
  assert.deepEqual(unknown, { status: "item_not_found", item_ids: ["not-a-dish"] });
  assert.equal(priceOf(db, "asun").available, 0);

  const drinks = setTodaysMenu(db, { available_item_ids: ["jollof-chicken", "water-small"] });
  assert.equal(drinks.status, "invalid_input");
  assert.equal(priceOf(db, "jollof-chicken").available, 1);

  const restored = setTodaysMenu(db, { available_item_ids: ["asun", "dodo"] });
  assert.equal(restored.status, "todays_menu_set");
  if (restored.status !== "todays_menu_set") return;
  assert.deepEqual(restored.turned_on, [{ item_id: "asun", name: "Asun" }]);
  assert.ok(restored.turned_off.some((item) => item.item_id === "jollof-chicken"));
});

test("1–2. The owner token and the orders token cannot use each other's tools", async () => {
  const deps = makeDeps();
  const server: Server = createApp(deps, { mcpToken: ORDERS, ownerMcpToken: OWNER }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, token: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  try {
    assert.equal((await post("/mcp", OWNER, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);
    assert.equal((await post("/mcp/owner", ORDERS, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status, 401);

    const names = async (path: string, token: string) => {
      const res = await post(path, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { result: { tools: { name: string }[] } };
      return json.result.tools.map((tool) => tool.name).sort();
    };
    const orders = await names("/mcp", ORDERS);
    const owner = await names("/mcp/owner", OWNER);
    assert.deepEqual(orders, ["create_order", "create_payment_link", "get_menu", "ping", "verify_payment"]);
    assert.deepEqual(owner, ["list_menu", "set_availability", "set_todays_menu", "todays_orders", "update_price"]);

    const off = await post("/mcp/owner", OWNER, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "set_availability", arguments: { changes: [{ item_id: "jollof-chicken", available: false }] } },
    });
    const offBody = (await off.json()) as { result: { content: { text: string }[] } };
    assert.equal(JSON.parse(offBody.result.content[0].text).status, "availability_updated");

    const menu = await post("/mcp", ORDERS, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_menu", arguments: {} },
    });
    const menuBody = (await menu.json()) as { result: { content: { text: string }[] } };
    const items = JSON.parse(menuBody.result.content[0].text).items as { id: string }[];
    assert.equal(items.some((item) => item.id === "jollof-chicken"), false);
  } finally {
    server.close();
  }
});
