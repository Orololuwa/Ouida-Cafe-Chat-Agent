import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db/index.js";
import { getMenu } from "../src/domain/menu.js";

test("1. get_menu returns 33 items and the ₦200 plate fee", () => {
  const db = openDatabase(":memory:");
  const menu = getMenu(db);
  assert.equal(menu.status, "ok");
  if (menu.status !== "ok") return;
  assert.equal(menu.currency, "NGN");
  assert.equal(menu.plate_fee_ngn, 200);
  assert.equal(menu.items.length, 33);

  // Food first, drinks last; no nulls, no `available` flag.
  assert.equal(menu.items[0].category, "food");
  assert.equal(menu.items.at(-1)!.category, "drink");
  for (const item of menu.items) {
    assert.ok(Object.values(item).every((v) => v !== null), `${item.id} has a null field`);
    assert.ok(!("available" in item));
  }
  const puff = menu.items.find((i) => i.id === "puff-puff")!;
  assert.equal(puff.prep_note, "Takes about 30 minutes");
  assert.ok(!("description" in puff));
});

test("get_menu hides unavailable items", () => {
  const db = openDatabase(":memory:");
  db.prepare("UPDATE catalogue SET available = 0 WHERE id = 'asun'").run();
  const menu = getMenu(db);
  assert.equal(menu.status, "ok");
  if (menu.status !== "ok") return;
  assert.equal(menu.items.length, 32);
  assert.ok(!menu.items.some((i) => i.id === "asun"));
});

test("get_menu reports menu_not_set when the catalogue is empty", () => {
  const db = openDatabase(":memory:");
  db.exec("DELETE FROM catalogue");
  assert.deepEqual(getMenu(db), { status: "menu_not_set" });
});
