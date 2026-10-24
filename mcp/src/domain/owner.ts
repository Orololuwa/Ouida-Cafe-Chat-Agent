import type { Database } from "../db/index.js";
import { catalogueIsEmpty, getAllItems, getSettings } from "./menu.js";
import { formatNaira } from "./receipt.js";
import type { CatalogueItem, Category } from "./types.js";

// Food, protein and sweets go on plates. Drinks and hot drinks are left alone by set_todays_menu,
// so "only jollof and dodo today" does not switch off water.
const PLATE_CATEGORIES = new Set<Category>(["food", "protein", "sweet"]);
const MAX_CHANGES = 33;
const MIN_PRICE = 100;
const MAX_PRICE = 100_000;

export type OwnerTool = "set_availability" | "update_price" | "set_todays_menu";

interface ChangeRow {
  item_id: string;
  field: "price_ngn" | "available";
  old_value: string;
  new_value: string;
  via: OwnerTool;
}

function inTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function logChanges(db: Database, changes: ChangeRow[], at: string): void {
  const insert = db.prepare(
    `INSERT INTO menu_changes (item_id, field, old_value, new_value, changed_at, via)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const change of changes) {
    insert.run(change.item_id, change.field, change.old_value, change.new_value, at, change.via);
    console.log(`[menu] ${change.via} ${change.item_id} ${change.field} ${change.old_value} → ${change.new_value}`);
  }
}

function names(items: CatalogueItem[]): string {
  return items.map((item) => item.name).join(", ");
}

// ---------- list_menu ----------

export type ListMenuResult =
  | { status: "menu_not_set" }
  | {
      status: "ok";
      plate_fee_ngn: number;
      items: { id: string; name: string; category: Category; price_ngn: number; available: boolean }[];
      summary_text: string;
    };

export function listMenu(db: Database): ListMenuResult {
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };
  const items = getAllItems(db);
  const off = items.filter((item) => !item.available);
  const summary_text = `*Available:* ${items.length - off.length} items\n*Off today:* ${off.length === 0 ? "none" : names(off)}`;
  return {
    status: "ok",
    plate_fee_ngn: getSettings(db).plate_fee_ngn,
    items: items.map(({ id, name, category, price_ngn, available }) => ({ id, name, category, price_ngn, available })),
    summary_text,
  };
}

// ---------- set_availability ----------

export interface AvailabilityChange {
  item_id: string;
  available: boolean;
}

export type SetAvailabilityResult =
  | { status: "menu_not_set" }
  | { status: "invalid_input"; message: string }
  | { status: "item_not_found"; item_ids: string[] }
  | { status: "no_changes"; summary_text: string }
  | {
      status: "availability_updated";
      changed: { item_id: string; name: string; available: boolean }[];
      unchanged: { item_id: string; name: string }[];
      summary_text: string;
    };

export function setAvailability(
  db: Database,
  input: { changes?: AvailabilityChange[] | null },
  now: Date = new Date(),
): SetAvailabilityResult {
  const changes = input.changes ?? [];
  if (changes.length < 1 || changes.length > MAX_CHANGES) {
    return { status: "invalid_input", message: `Pass between 1 and ${MAX_CHANGES} changes.` };
  }
  const seen = new Set<string>();
  for (const change of changes) {
    if (!change.item_id?.trim() || typeof change.available !== "boolean") {
      return { status: "invalid_input", message: "Each change needs an item_id and available true or false." };
    }
    if (seen.has(change.item_id)) return { status: "invalid_input", message: "Each item can only appear once." };
    seen.add(change.item_id);
  }
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };

  return inTransaction(db, () => {
    const catalogue = new Map(getAllItems(db).map((item) => [item.id, item]));
    const missing = changes.filter((change) => !catalogue.has(change.item_id)).map((change) => change.item_id);
    if (missing.length > 0) return { status: "item_not_found" as const, item_ids: missing };

    const changed: { item_id: string; name: string; available: boolean }[] = [];
    const unchanged: { item_id: string; name: string }[] = [];
    const rows: ChangeRow[] = [];
    for (const change of changes) {
      const item = catalogue.get(change.item_id)!;
      if (item.available === change.available) {
        unchanged.push({ item_id: item.id, name: item.name });
        continue;
      }
      changed.push({ item_id: item.id, name: item.name, available: change.available });
      rows.push({
        item_id: item.id,
        field: "available",
        old_value: String(item.available),
        new_value: String(change.available),
        via: "set_availability",
      });
    }
    if (changed.length === 0) return { status: "no_changes" as const, summary_text: "Nothing needed changing." };

    const update = db.prepare("UPDATE catalogue SET available = ? WHERE id = ?");
    for (const change of changed) update.run(change.available ? 1 : 0, change.item_id);
    logChanges(db, rows, now.toISOString());

    const off = changed.filter((change) => !change.available);
    const on = changed.filter((change) => change.available);
    const lines: string[] = [];
    if (off.length > 0) lines.push(`Off for customers: ${off.map((change) => change.name).join(", ")}`);
    if (on.length > 0) lines.push(`Back for customers: ${on.map((change) => change.name).join(", ")}`);
    return { status: "availability_updated" as const, changed, unchanged, summary_text: lines.join("\n") };
  });
}

// ---------- update_price ----------

export type UpdatePriceResult =
  | { status: "menu_not_set" }
  | { status: "invalid_price"; message: string }
  | { status: "item_not_found"; item_id: string }
  | { status: "no_changes"; item_id: string; name: string; price_ngn: number; summary_text: string }
  | {
      status: "large_change_needs_confirmation";
      item_id: string;
      name: string;
      old_price_ngn: number;
      price_ngn: number;
      change_percent: number;
      summary_text: string;
    }
  | {
      status: "price_updated";
      item_id: string;
      name: string;
      old_price_ngn: number;
      price_ngn: number;
      summary_text: string;
    };

// More than half the current price, either direction. Exactly 50% is allowed through.
function isLargeJump(current: number, next: number): boolean {
  return Math.abs(next - current) * 2 > current;
}

export function updatePrice(
  db: Database,
  input: { item_id?: string | null; price_ngn?: number | null; confirmed_large_change?: boolean | null },
  now: Date = new Date(),
): UpdatePriceResult {
  const price = input.price_ngn;
  if (typeof price !== "number" || !Number.isInteger(price) || price < MIN_PRICE || price > MAX_PRICE) {
    return { status: "invalid_price", message: `price_ngn must be a whole number from ${MIN_PRICE} to 100,000.` };
  }
  const itemId = input.item_id?.trim() ?? "";
  if (!itemId) return { status: "item_not_found", item_id: input.item_id ?? "" };
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };

  return inTransaction(db, () => {
    const item = getAllItems(db).find((candidate) => candidate.id === itemId);
    if (!item) return { status: "item_not_found" as const, item_id: itemId };
    if (item.price_ngn === price) {
      return {
        status: "no_changes" as const,
        item_id: item.id,
        name: item.name,
        price_ngn: price,
        summary_text: `${item.name} is already ${formatNaira(price)}.`,
      };
    }
    const changePercent = Math.round((Math.abs(price - item.price_ngn) / item.price_ngn) * 100);
    if (isLargeJump(item.price_ngn, price) && input.confirmed_large_change !== true) {
      const direction = price > item.price_ngn ? "increase" : "decrease";
      return {
        status: "large_change_needs_confirmation" as const,
        item_id: item.id,
        name: item.name,
        old_price_ngn: item.price_ngn,
        price_ngn: price,
        change_percent: changePercent,
        summary_text:
          `${item.name}: ${formatNaira(item.price_ngn)} → ${formatNaira(price)} is a ${changePercent}% ${direction}. ` +
          `Ask the owner if that is right before saving.`,
      };
    }
    db.prepare("UPDATE catalogue SET price_ngn = ? WHERE id = ?").run(price, item.id);
    logChanges(
      db,
      [{ item_id: item.id, field: "price_ngn", old_value: String(item.price_ngn), new_value: String(price), via: "update_price" }],
      now.toISOString(),
    );
    return {
      status: "price_updated" as const,
      item_id: item.id,
      name: item.name,
      old_price_ngn: item.price_ngn,
      price_ngn: price,
      summary_text: `${item.name}: ${formatNaira(item.price_ngn)} → ${formatNaira(price)} for new orders`,
    };
  });
}

// ---------- set_todays_menu ----------

export type SetTodaysMenuResult =
  | { status: "menu_not_set" }
  | { status: "invalid_input"; message: string }
  | { status: "item_not_found"; item_ids: string[] }
  | {
      status: "todays_menu_set";
      turned_on: { item_id: string; name: string }[];
      turned_off: { item_id: string; name: string }[];
      summary_text: string;
    };

export function setTodaysMenu(
  db: Database,
  input: { available_item_ids?: string[] | null },
  now: Date = new Date(),
): SetTodaysMenuResult {
  const ids = input.available_item_ids ?? [];
  if (ids.length < 1 || ids.length > MAX_CHANGES) {
    return { status: "invalid_input", message: "Pass at least one food, protein or sweet item id." };
  }
  if (new Set(ids).size !== ids.length) return { status: "invalid_input", message: "Each item can only appear once." };
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };

  return inTransaction(db, () => {
    const items = getAllItems(db);
    const byId = new Map(items.map((item) => [item.id, item]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) return { status: "item_not_found" as const, item_ids: missing };
    const notOnAPlate = ids.filter((id) => !PLATE_CATEGORIES.has(byId.get(id)!.category));
    if (notOnAPlate.length > 0) {
      return {
        status: "invalid_input" as const,
        message: "Drinks and hot drinks stay as they are. Leave them out of available_item_ids.",
      };
    }

    const wanted = new Set(ids);
    const turnedOn: CatalogueItem[] = [];
    const turnedOff: CatalogueItem[] = [];
    const rows: ChangeRow[] = [];
    for (const item of items) {
      if (!PLATE_CATEGORIES.has(item.category)) continue;
      const shouldBeOn = wanted.has(item.id);
      if (item.available === shouldBeOn) continue;
      (shouldBeOn ? turnedOn : turnedOff).push(item);
      rows.push({
        item_id: item.id,
        field: "available",
        old_value: String(item.available),
        new_value: String(shouldBeOn),
        via: "set_todays_menu",
      });
    }

    if (rows.length > 0) {
      const update = db.prepare("UPDATE catalogue SET available = ? WHERE id = ?");
      for (const item of turnedOn) update.run(1, item.id);
      for (const item of turnedOff) update.run(0, item.id);
      logChanges(db, rows, now.toISOString());
    }

    const on = turnedOn.map(({ id, name }) => ({ item_id: id, name }));
    const off = turnedOff.map(({ id, name }) => ({ item_id: id, name }));
    const lines: string[] = [];
    if (on.length > 0) lines.push(`*Switched on:* ${names(turnedOn)}`);
    if (off.length > 0) lines.push(`*Switched off:* ${names(turnedOff)}`);
    return {
      status: "todays_menu_set" as const,
      turned_on: on,
      turned_off: off,
      summary_text: lines.length > 0 ? lines.join("\n") : "Today's menu already matches that list.",
    };
  });
}

// ---------- todays_orders ----------

// The café's calendar day. Africa/Lagos is UTC+1 all year.
export function lagosDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function lagosBounds(now: Date): { date: string; start: string; end: string } {
  const date = lagosDay(now);
  const startMs = new Date(`${date}T00:00:00+01:00`).getTime();
  return { date, start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString() };
}

interface PaidOrderRow {
  ref: string;
  customer_name: string;
  plate_count: number;
  total_ngn: number;
  paid_at: string;
  plates: string;
  drinks: string;
}

interface StoredLine {
  item_id: string;
  name: string;
  qty: number;
}

export type TodaysOrdersResult =
  | { status: "no_orders_yet"; date: string; summary_text: string }
  | {
      status: "ok";
      date: string;
      paid_count: number;
      paid_total_ngn: number;
      pending_count: number;
      plates: number;
      to_prepare: { item_id: string; name: string; qty: number }[];
      recent: { order_ref: string; customer_name: string; plates: number; total_ngn: number; paid_at: string }[];
      summary_text: string;
    };

export function todaysOrders(db: Database, now: Date = new Date()): TodaysOrdersResult {
  const { date, start, end } = lagosBounds(now);
  const paid = db
    .prepare(
      `SELECT ref, customer_name, plate_count, total_ngn, paid_at, plates, drinks
       FROM orders
       WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?
       ORDER BY paid_at DESC`,
    )
    .all(start, end) as unknown as PaidOrderRow[];
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE status = 'pending_payment' AND created_at >= ? AND created_at < ?`,
    )
    .get(start, end) as { n: number };

  if (paid.length === 0 && pending.n === 0) {
    return { status: "no_orders_yet", date, summary_text: "No orders yet today." };
  }

  const totals = new Map<string, { item_id: string; name: string; qty: number }>();
  for (const order of paid) {
    const plates = JSON.parse(order.plates) as { lines: StoredLine[] }[];
    const drinks = JSON.parse(order.drinks) as StoredLine[];
    for (const line of [...plates.flatMap((plate) => plate.lines), ...drinks]) {
      const current = totals.get(line.item_id);
      if (current) current.qty += line.qty;
      else totals.set(line.item_id, { item_id: line.item_id, name: line.name, qty: line.qty });
    }
  }
  const toPrepare = [...totals.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  const paidTotal = paid.reduce((sum, order) => sum + order.total_ngn, 0);
  const plateCount = paid.reduce((sum, order) => sum + order.plate_count, 0);

  const lines = [
    `*Today so far:* ${paid.length === 0 ? "no paid orders yet" : `${paid.length} paid ${paid.length === 1 ? "order" : "orders"}, ${formatNaira(paidTotal)}`}`,
  ];
  if (toPrepare.length > 0) {
    lines.push(`*To prepare:* ${toPrepare.map((item) => `${item.qty}× ${item.name}`).join(", ")}`);
  }
  if (pending.n > 0) lines.push(`${pending.n} ${pending.n === 1 ? "order" : "orders"} waiting for payment`);

  return {
    status: "ok",
    date,
    paid_count: paid.length,
    paid_total_ngn: paidTotal,
    pending_count: pending.n,
    plates: plateCount,
    to_prepare: toPrepare,
    recent: paid.slice(0, 10).map((order) => ({
      order_ref: order.ref,
      customer_name: order.customer_name,
      plates: order.plate_count,
      total_ngn: order.total_ngn,
      paid_at: order.paid_at,
    })),
    summary_text: lines.join("\n"),
  };
}
