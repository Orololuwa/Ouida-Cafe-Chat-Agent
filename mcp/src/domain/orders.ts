import { randomInt } from "node:crypto";
import type { Database } from "../db/index.js";
import { catalogueIsEmpty, getCatalogue, getSettings } from "./menu.js";
import { renderReceipt } from "./receipt.js";
import type { CatalogueItem, Order, OrderLine, Plate } from "./types.js";

// What the agent sends. Deliberately loose: every rule is checked here so problems come back
// as one business result instead of a schema error.
export interface LineInput {
  item_id: string;
  qty: number;
  note?: string;
}
export interface PlateInput {
  label?: string;
  items: LineInput[];
}
export interface CreateOrderInput {
  customer_name: string;
  customer_handle?: string;
  plates?: PlateInput[];
  drinks?: LineInput[];
}

export type ProblemCode = "invalid_order" | "empty_order" | "item_not_found" | "item_unavailable" | "wrong_section";

export interface Problem {
  code: ProblemCode;
  plate?: number; // 1-based; absent for drinks and order-level problems
  item_id?: string;
  message: string;
}

export type CreateOrderResult =
  | {
      status: "order_created";
      order_ref: string;
      customer_name: string;
      plate_count: number;
      plate_fee_ngn: number;
      total_ngn: number;
      order_status: Order["status"];
      plates: Plate[];
      drinks: OrderLine[];
      receipt_text: string;
    }
  | { status: "menu_not_set" }
  | { status: ProblemCode; problems: Problem[] };

export const LIMITS = {
  nameMax: 60,
  qtyMin: 1,
  qtyMax: 20,
  platesMax: 20,
  noteMax: 80,
} as const;

// No 0/O or 1/I/L, so a reference reads clearly at the counter.
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const REF_LENGTH = 4;
const REF_ATTEMPTS = 20;

export function generateRef(): string {
  let ref = "OU-";
  for (let i = 0; i < REF_LENGTH; i++) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return ref;
}

// Validates, prices and saves an order. Saves nothing if any check fails, and reports every problem found.
export function createOrder(db: Database, input: CreateOrderInput, now: Date = new Date()): CreateOrderResult {
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };

  const catalogue = getCatalogue(db);
  const settings = getSettings(db);
  const problems: Problem[] = [];

  // Rule 1: customer name.
  const customerName = (input.customer_name ?? "").trim();
  if (customerName.length < 1 || customerName.length > LIMITS.nameMax) {
    problems.push({
      code: "invalid_order",
      message: `customer_name must be 1–${LIMITS.nameMax} characters.`,
    });
  }

  // Rule 2: something to order.
  const plateInputs = input.plates ?? [];
  const drinkInputs = input.drinks ?? [];
  if (plateInputs.length === 0 && drinkInputs.length === 0) {
    problems.push({ code: "empty_order", message: "The order has no plates and no drinks." });
    return { status: problems[0].code, problems };
  }

  // Rule 3: plate count.
  if (plateInputs.length > LIMITS.platesMax) {
    problems.push({
      code: "invalid_order",
      message: `An order can have at most ${LIMITS.platesMax} plates (got ${plateInputs.length}).`,
    });
  }

  // Rules 3–6, line by line. `plate` is undefined for drinks.
  const priceLine = (raw: LineInput, plate: number | undefined): OrderLine | null => {
    const where = plate === undefined ? "Drinks" : `Plate ${plate}`;
    const itemId = raw.item_id;
    const before = problems.length;

    if (!Number.isInteger(raw.qty) || raw.qty < LIMITS.qtyMin || raw.qty > LIMITS.qtyMax) {
      problems.push({
        code: "invalid_order",
        plate,
        item_id: itemId,
        message: `${where}: qty for "${itemId}" must be a whole number from ${LIMITS.qtyMin} to ${LIMITS.qtyMax} (got ${raw.qty}).`,
      });
    }

    const note = raw.note?.trim() || undefined;
    if (note && note.length > LIMITS.noteMax) {
      problems.push({
        code: "invalid_order",
        plate,
        item_id: itemId,
        message: `${where}: note for "${itemId}" must be at most ${LIMITS.noteMax} characters.`,
      });
    }

    const item: CatalogueItem | undefined = catalogue.get(itemId);
    if (!item) {
      problems.push({
        code: "item_not_found",
        plate,
        item_id: itemId,
        message: `${where}: "${itemId}" is not on the menu. Call get_menu and use an id from it.`,
      });
      return null;
    }
    if (!item.available) {
      problems.push({
        code: "item_unavailable",
        plate,
        item_id: itemId,
        message: `${where}: ${item.name} is finished for today.`,
      });
    }
    if (plate !== undefined && !item.on_plate) {
      problems.push({
        code: "wrong_section",
        plate,
        item_id: itemId,
        message: `${where}: ${item.name} is a drink. Move it from plate ${plate} to drinks.`,
      });
    }
    if (plate === undefined && item.on_plate) {
      problems.push({
        code: "wrong_section",
        item_id: itemId,
        message: `Drinks: ${item.name} goes on a plate, not under drinks.`,
      });
    }

    if (problems.length > before) return null;
    return {
      item_id: item.id,
      name: item.name,
      qty: raw.qty,
      unit_price_ngn: item.price_ngn,
      line_total_ngn: raw.qty * item.price_ngn,
      ...(note ? { note } : {}),
    };
  };

  const plates: Plate[] = plateInputs.map((p, i) => {
    const plateNo = i + 1;
    const items = p.items ?? [];
    if (items.length === 0) {
      problems.push({ code: "invalid_order", plate: plateNo, message: `Plate ${plateNo} has no items.` });
    }
    const lines = items.map((l) => priceLine(l, plateNo)).filter((l): l is OrderLine => l !== null);
    const label = p.label?.trim() || undefined;
    return {
      ...(label ? { label } : {}),
      lines,
      subtotal_ngn: lines.reduce((sum, l) => sum + l.line_total_ngn, 0),
    };
  });
  const drinks = drinkInputs.map((l) => priceLine(l, undefined)).filter((l): l is OrderLine => l !== null);

  if (problems.length > 0) return { status: problems[0].code, problems };

  const plateCount = plates.length;
  const total =
    plates.reduce((sum, p) => sum + p.subtotal_ngn, 0) +
    drinks.reduce((sum, l) => sum + l.line_total_ngn, 0) +
    plateCount * settings.plate_fee_ngn;

  const customerHandle = input.customer_handle?.trim() || undefined;
  const order: Order = {
    ref: "",
    customer_name: customerName,
    ...(customerHandle ? { customer_handle: customerHandle } : {}),
    status: "pending_payment",
    plates,
    drinks,
    plate_count: plateCount,
    plate_fee_ngn: settings.plate_fee_ngn,
    total_ngn: total,
    created_at: now.toISOString(),
  };
  order.ref = saveOrder(db, order);

  return {
    status: "order_created",
    order_ref: order.ref,
    customer_name: order.customer_name,
    plate_count: order.plate_count,
    plate_fee_ngn: order.plate_fee_ngn,
    total_ngn: order.total_ngn,
    order_status: order.status,
    plates: order.plates,
    drinks: order.drinks,
    receipt_text: renderReceipt(order),
  };
}

// Inserts the order under a fresh random reference, regenerating on the rare collision.
function saveOrder(db: Database, order: Omit<Order, "ref">): string {
  const insert = db.prepare(
    `INSERT INTO orders (ref, customer_name, customer_handle, status, plates, drinks,
                         plate_count, plate_fee_ngn, total_ngn, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ref) DO NOTHING`,
  );
  for (let attempt = 0; attempt < REF_ATTEMPTS; attempt++) {
    const ref = generateRef();
    const { changes } = insert.run(
      ref,
      order.customer_name,
      order.customer_handle ?? null,
      order.status,
      JSON.stringify(order.plates),
      JSON.stringify(order.drinks),
      order.plate_count,
      order.plate_fee_ngn,
      order.total_ngn,
      order.created_at,
    );
    if (Number(changes) === 1) return ref;
  }
  throw new Error(`could not find a free order reference after ${REF_ATTEMPTS} attempts`);
}

interface OrderRow {
  ref: string;
  customer_name: string;
  customer_handle: string | null;
  status: Order["status"];
  plates: string;
  drinks: string;
  plate_count: number;
  plate_fee_ngn: number;
  total_ngn: number;
  created_at: string;
}

export function getOrder(db: Database, ref: string): Order | undefined {
  const row = db.prepare("SELECT * FROM orders WHERE ref = ?").get(ref) as OrderRow | undefined;
  if (!row) return undefined;
  return {
    ref: row.ref,
    customer_name: row.customer_name,
    ...(row.customer_handle ? { customer_handle: row.customer_handle } : {}),
    status: row.status,
    plates: JSON.parse(row.plates) as Plate[],
    drinks: JSON.parse(row.drinks) as OrderLine[],
    plate_count: row.plate_count,
    plate_fee_ngn: row.plate_fee_ngn,
    total_ngn: row.total_ngn,
    created_at: row.created_at,
  };
}
