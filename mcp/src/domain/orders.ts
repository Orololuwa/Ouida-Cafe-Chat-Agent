import { randomInt } from "node:crypto";
import type { Database } from "../db/index.js";
import { catalogueIsEmpty, getCatalogue, getSettings } from "./menu.js";
import { renderReceipt } from "./receipt.js";
import type { CatalogueItem, Order, OrderLine, Plate } from "./types.js";

// What the agent sends. Deliberately loose: every rule is checked here so problems come back
// as one business result instead of a schema error.
// Optional fields may arrive as null; null means "not given".
export interface LineInput {
  item_id: string;
  qty: number;
  note?: string | null;
}
export interface PlateInput {
  label?: string | null;
  items: LineInput[];
}
export interface CreateOrderInput {
  customer_name: string;
  customer_handle?: string | null;
  plates?: PlateInput[] | null;
  drinks?: LineInput[] | null;
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
      // order_already_created: the same unpaid order already exists, so it is returned instead of a duplicate.
      status: "order_created" | "order_already_created";
      order_ref: string;
      customer_name: string;
      plate_count: number;
      plate_fee_ngn: number;
      total_ngn: number;
      order_status: Order["status"];
      plates: Plate[];
      drinks: OrderLine[];
      receipt_text: string;
      next_step?: string;
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

// Agents sometimes call create_order again when the customer says "yes" to a receipt.
// An identical unpaid order for the same name within this window is returned instead of duplicated.
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

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
    // "Plate 2" says nothing the receipt doesn't already say, so only real names are kept.
    const rawLabel = p.label?.trim();
    const label = rawLabel && !/^plate\s*\d*$/i.test(rawLabel) ? rawLabel : undefined;
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
  const existing = findDuplicate(db, order, now);
  if (existing) {
    console.log(`[orders] ${existing.ref} already exists for ${existing.customer_name}; not creating a duplicate`);
    return {
      status: "order_already_created",
      order_ref: existing.ref,
      customer_name: existing.customer_name,
      plate_count: existing.plate_count,
      plate_fee_ngn: existing.plate_fee_ngn,
      total_ngn: existing.total_ngn,
      order_status: existing.status,
      plates: existing.plates,
      drinks: existing.drinks,
      receipt_text: renderReceipt(existing),
      next_step:
        `This exact order already exists as ${existing.ref} and the customer has seen its receipt. ` +
        `If the customer has just confirmed it, call create_payment_link with order_ref ${existing.ref} now. ` +
        `Do not call create_order again unless the customer changes the order.`,
    };
  }

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

// What makes two orders "the same": every plate (label and lines) and every drink, in order.
function orderContent(o: Pick<Order, "plates" | "drinks">): string {
  const line = (l: OrderLine) => [l.item_id, l.qty, l.note ?? ""];
  return JSON.stringify({
    plates: o.plates.map((p) => [p.label ?? "", p.lines.map(line)]),
    drinks: o.drinks.map(line),
  });
}

// The most recent unpaid order with the same name and contents, created within the window.
function findDuplicate(db: Database, order: Omit<Order, "ref">, now: Date): Order | undefined {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString();
  const refs = db
    .prepare(
      `SELECT ref FROM orders
       WHERE status = 'pending_payment' AND customer_name = ? COLLATE NOCASE AND created_at >= ?
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all(order.customer_name, since) as { ref: string }[];
  const wanted = orderContent(order);
  for (const { ref } of refs) {
    const candidate = getOrder(db, ref);
    if (candidate && orderContent(candidate) === wanted) return candidate;
  }
  return undefined;
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
  paid_at: string | null;
  paid_reference: string | null;
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
    ...(row.paid_at ? { paid_at: row.paid_at } : {}),
    ...(row.paid_reference ? { paid_reference: row.paid_reference } : {}),
  };
}
