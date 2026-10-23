import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, type Database } from "../src/db/index.js";
import { createOrder, generateRef, getOrder, type CreateOrderInput } from "../src/domain/orders.js";

const one = (item_id: string, qty = 1) => ({ item_id, qty });
const orderCount = (db: Database) => (db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;

function created(db: Database, input: CreateOrderInput) {
  const result = createOrder(db, input);
  assert.equal(result.status, "order_created", JSON.stringify(result));
  if (result.status !== "order_created") throw new Error("unreachable");
  return result;
}

test("2. Ororo: two labelled plates and zobo come to ₦11,400 with the exact receipt", () => {
  const db = openDatabase(":memory:");
  const r = created(db, {
    customer_name: "Ororo",
    plates: [
      { label: "Ororo", items: [one("jollof-chicken"), one("dodo")] },
      { label: "Ada", items: [one("rice-pepper-sauce-beef"), one("boiled-egg")] },
    ],
    drinks: [one("zobo-glass", 2)],
  });
  assert.equal(r.plate_count, 2);
  assert.equal(r.total_ngn, 11400);
  assert.equal(r.order_status, "pending_payment");
  assert.match(r.order_ref, /^OU-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  assert.deepEqual(
    r.plates.map((p) => p.subtotal_ngn),
    [5500, 3500],
  );
  assert.equal(
    r.receipt_text,
    [
      `*Order ${r.order_ref} for Ororo, 2 plates*`,
      "*Plate 1 (Ororo)*",
      "• 1× Jollof Rice with Chicken — ₦4,500",
      "• 1× Dodo — ₦1,000",
      "*Plate 2 (Ada)*",
      "• 1× Rice and Pepper Sauce (Beef) — ₦3,000",
      "• 1× Boiled egg — ₦500",
      "*Drinks*",
      "• 2× Zobo (glass) — ₦2,000",
      "Plates: 2 × ₦200 — ₦400",
      "*Total: ₦11,400*",
    ].join("\n"),
  );
  assert.equal(orderCount(db), 1);
});

test("3. Ade: three dundu plates and three small waters come to ₦11,100", () => {
  const db = openDatabase(":memory:");
  const plate = { items: [one("dundu-egg-sauce")] };
  const r = created(db, { customer_name: "Ade", plates: [plate, plate, plate], drinks: [one("water-small", 3)] });
  assert.equal(r.plate_count, 3);
  assert.equal(r.total_ngn, 11100);
});

test("4. Five plates and three zobo come to ₦23,500", () => {
  const db = openDatabase(":memory:");
  const jc = { items: [one("jollof-chicken"), one("dodo")] };
  const rb = { items: [one("rice-pepper-sauce-beef"), one("boiled-egg")] };
  const r = created(db, {
    customer_name: "Team",
    plates: [jc, jc, rb, rb, { items: [one("jollof-spaghetti")] }],
    drinks: [one("zobo-glass", 3)],
  });
  assert.equal(r.plate_count, 5);
  assert.equal(r.total_ngn, 23500);
});

test("5. An unknown item is item_not_found and nothing is saved", () => {
  const db = openDatabase(":memory:");
  const r = createOrder(db, { customer_name: "Ade", plates: [{ items: [one("fried-rice")] }] });
  assert.equal(r.status, "item_not_found");
  assert.ok("problems" in r);
  assert.deepEqual(r.problems[0], {
    code: "item_not_found",
    plate: 1,
    item_id: "fried-rice",
    message: 'Plate 1: "fried-rice" is not on the menu. Call get_menu and use an id from it.',
  });
  assert.equal(orderCount(db), 0);
});

test("6. Extra chicken alone on a plate is ₦3,700", () => {
  const db = openDatabase(":memory:");
  const r = created(db, { customer_name: "Ade", plates: [{ items: [one("extra-chicken")] }] });
  assert.equal(r.plate_count, 1);
  assert.equal(r.total_ngn, 3700);
  assert.match(r.receipt_text, /^\*Order OU-\w{4} for Ade, 1 plate\*\n/);
});

test("7. A drink on a plate is wrong_section, and so is food under drinks", () => {
  const db = openDatabase(":memory:");
  const onPlate = createOrder(db, { customer_name: "Ade", plates: [{ items: [one("jollof-beef"), one("water-small")] }] });
  assert.equal(onPlate.status, "wrong_section");
  const inDrinks = createOrder(db, { customer_name: "Ade", drinks: [one("dodo")] });
  assert.equal(inDrinks.status, "wrong_section");
  assert.equal(orderCount(db), 0);
});

test("8. qty 0 is invalid_order; no plates and no drinks is empty_order", () => {
  const db = openDatabase(":memory:");
  assert.equal(createOrder(db, { customer_name: "Ade", plates: [{ items: [one("dodo", 0)] }] }).status, "invalid_order");
  assert.equal(createOrder(db, { customer_name: "Ade" }).status, "empty_order");
  assert.equal(createOrder(db, { customer_name: "Ade", plates: [], drinks: [] }).status, "empty_order");
  assert.equal(orderCount(db), 0);
});

test("9. A later price change never alters a saved order", () => {
  const db = openDatabase(":memory:");
  const r = created(db, { customer_name: "Ororo", plates: [{ items: [one("jollof-chicken")] }] });
  db.prepare("UPDATE catalogue SET price_ngn = 5000 WHERE id = 'jollof-chicken'").run();

  const saved = getOrder(db, r.order_ref)!;
  assert.equal(saved.plates[0].lines[0].unit_price_ngn, 4500);
  assert.equal(saved.total_ngn, 4700);

  // New orders pick up the new price.
  assert.equal(created(db, { customer_name: "Ororo", plates: [{ items: [one("jollof-chicken")] }] }).total_ngn, 5200);
});

test("every problem is reported in one result, in order", () => {
  const db = openDatabase(":memory:");
  const r = createOrder(db, {
    customer_name: "  ",
    plates: [{ items: [] }, { items: [one("dodo", 1.5), one("latte")] }],
    drinks: [one("zobo-glass", 21)],
  });
  assert.ok("problems" in r);
  assert.equal(r.status, "invalid_order");
  assert.deepEqual(
    r.problems.map((p) => [p.code, p.plate, p.item_id]),
    [
      ["invalid_order", undefined, undefined], // blank name
      ["invalid_order", 1, undefined], // empty plate
      ["invalid_order", 2, "dodo"], // fractional qty
      ["wrong_section", 2, "latte"],
      ["invalid_order", undefined, "zobo-glass"], // qty over 20
    ],
  );
});

test("unavailable items, long notes and too many plates are rejected", () => {
  const db = openDatabase(":memory:");
  db.prepare("UPDATE catalogue SET available = 0 WHERE id = 'asun'").run();
  assert.equal(createOrder(db, { customer_name: "Ade", plates: [{ items: [one("asun")] }] }).status, "item_unavailable");
  assert.equal(
    createOrder(db, { customer_name: "Ade", drinks: [{ item_id: "soft-drink", qty: 1, note: "x".repeat(81) }] }).status,
    "invalid_order",
  );
  const plates = Array.from({ length: 21 }, () => ({ items: [one("dodo")] }));
  assert.equal(createOrder(db, { customer_name: "Ade", plates }).status, "invalid_order");
  assert.equal(orderCount(db), 0);
});

test("notes and drink-only orders render on the receipt", () => {
  const db = openDatabase(":memory:");
  const r = created(db, {
    customer_name: "  Ade  ",
    customer_handle: "partner_abc",
    drinks: [{ item_id: "soft-drink", qty: 2, note: "Coke" }],
  });
  assert.equal(r.customer_name, "Ade");
  assert.equal(r.plate_count, 0);
  assert.equal(r.total_ngn, 1600);
  assert.equal(
    r.receipt_text,
    [`*Order ${r.order_ref} for Ade*`, "*Drinks*", "• 2× Soft or energy drink (Coke) — ₦1,600", "*Total: ₦1,600*"].join("\n"),
  );
  assert.equal(getOrder(db, r.order_ref)!.customer_handle, "partner_abc");
});

test("create_order reports menu_not_set when the catalogue is empty", () => {
  const db = openDatabase(":memory:");
  db.exec("DELETE FROM catalogue");
  assert.deepEqual(createOrder(db, { customer_name: "Ade", drinks: [one("zobo-glass")] }), { status: "menu_not_set" });
});

test("references avoid look-alike characters", () => {
  for (let i = 0; i < 500; i++) assert.doesNotMatch(generateRef().slice(3), /[01OIL]/);
});

test("10 (local). Orders and owner edits survive reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ouida-"));
  try {
    const path = join(dir, "ouida.db");
    let db = openDatabase(path);
    const r = created(db, { customer_name: "Ade", plates: [{ items: [one("dodo")] }] });
    db.prepare("UPDATE catalogue SET price_ngn = 1200 WHERE id = 'dodo'").run();
    db.close();

    db = openDatabase(path); // a restart: must not reseed over the edit
    assert.equal(getOrder(db, r.order_ref)!.total_ngn, 1200);
    assert.equal((db.prepare("SELECT price_ngn FROM catalogue WHERE id = 'dodo'").get() as { price_ngn: number }).price_ngn, 1200);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
