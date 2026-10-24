import type { Database } from "../db/index.js";
import type { CatalogueItem, Category, Settings } from "./types.js";

interface CatalogueRow {
  id: string;
  name: string;
  category: Category;
  price_ngn: number;
  description: string | null;
  on_plate: number;
  prep_note: string | null;
  available: number;
}

// Empty fields are left out rather than sent as null.
function toItem(row: CatalogueRow): CatalogueItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price_ngn: row.price_ngn,
    ...(row.description ? { description: row.description } : {}),
    on_plate: row.on_plate === 1,
    ...(row.prep_note ? { prep_note: row.prep_note } : {}),
    available: row.available === 1,
  };
}

export function catalogueIsEmpty(db: Database): boolean {
  return db.prepare("SELECT 1 FROM catalogue LIMIT 1").get() === undefined;
}

// Every item, available or not, keyed by id. Used to price and validate orders.
export function getCatalogue(db: Database): Map<string, CatalogueItem> {
  const rows = db.prepare("SELECT * FROM catalogue").all() as unknown as CatalogueRow[];
  return new Map(rows.map((row) => [row.id, toItem(row)]));
}

const MENU_ORDER = `ORDER BY CASE category
         WHEN 'food' THEN 1 WHEN 'protein' THEN 2 WHEN 'sweet' THEN 3
         WHEN 'hot_drink' THEN 4 WHEN 'drink' THEN 5 END,
       name COLLATE NOCASE`;

// Every item in menu order, including ones switched off. The owner list uses this.
export function getAllItems(db: Database): CatalogueItem[] {
  const rows = db.prepare(`SELECT * FROM catalogue ${MENU_ORDER}`).all() as unknown as CatalogueRow[];
  return rows.map(toItem);
}

// Available items in menu order: food, protein, sweet, hot drinks, drinks; then by name.
export function getAvailableItems(db: Database): CatalogueItem[] {
  const rows = db.prepare(`SELECT * FROM catalogue WHERE available = 1 ${MENU_ORDER}`).all() as unknown as CatalogueRow[];
  return rows.map(toItem);
}

export function getSettings(db: Database): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const plateFee = Number(map.get("plate_fee_ngn"));
  if (!Number.isInteger(plateFee) || plateFee < 0) throw new Error("settings.plate_fee_ngn is missing or invalid");
  return { plate_fee_ngn: plateFee, currency: map.get("currency") ?? "NGN" };
}

export type MenuResult =
  | { status: "menu_not_set" }
  | {
      status: "ok";
      currency: string;
      plate_fee_ngn: number;
      items: Omit<CatalogueItem, "available">[];
    };

export function getMenu(db: Database): MenuResult {
  if (catalogueIsEmpty(db)) return { status: "menu_not_set" };
  const settings = getSettings(db);
  return {
    status: "ok",
    currency: settings.currency,
    plate_fee_ngn: settings.plate_fee_ngn,
    items: getAvailableItems(db).map(({ available: _available, ...item }) => item),
  };
}
