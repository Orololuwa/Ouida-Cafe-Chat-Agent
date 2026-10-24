import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import seedCatalogue from "./seed/catalogue.json" with { type: "json" };

export type Database = DatabaseSync;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS catalogue (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL CHECK (category IN ('food', 'protein', 'sweet', 'hot_drink', 'drink')),
    price_ngn   INTEGER NOT NULL CHECK (price_ngn >= 0),
    description TEXT,
    on_plate    INTEGER NOT NULL CHECK (on_plate IN (0, 1)),
    prep_note   TEXT,
    available   INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Written once in v1, so plates and drinks are stored as JSON text.
  CREATE TABLE IF NOT EXISTS orders (
    ref             TEXT PRIMARY KEY,
    customer_name   TEXT NOT NULL,
    customer_handle TEXT,
    status          TEXT NOT NULL,
    plates          TEXT NOT NULL,
    drinks          TEXT NOT NULL,
    plate_count     INTEGER NOT NULL,
    plate_fee_ngn   INTEGER NOT NULL,
    total_ngn       INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    paid_at         TEXT,
    paid_reference  TEXT
  );

  -- One row per real catalogue change, written in the same transaction as the change.
  CREATE TABLE IF NOT EXISTS menu_changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    TEXT NOT NULL,
    field      TEXT NOT NULL CHECK (field IN ('price_ngn', 'available')),
    old_value  TEXT NOT NULL,
    new_value  TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    via        TEXT NOT NULL
  );

  -- One row per Paystack transaction. Never deleted, so this is each order's payment history.
  CREATE TABLE IF NOT EXISTS payment_attempts (
    paystack_ref      TEXT PRIMARY KEY,
    order_ref         TEXT NOT NULL REFERENCES orders (ref),
    attempt_no        INTEGER NOT NULL,
    amount_kobo       INTEGER NOT NULL,
    email             TEXT NOT NULL,
    authorization_url TEXT,
    status            TEXT NOT NULL,
    gateway_response  TEXT,
    created_at        TEXT NOT NULL,
    checked_at        TEXT,
    UNIQUE (order_ref, attempt_no)
  );
`;

// Columns added after the first release (also listed in SCHEMA for new databases). Added on
// startup if missing, so an existing database upgrades in place with its data intact.
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "orders", column: "paid_at", definition: "TEXT" },
  { table: "orders", column: "paid_reference", definition: "TEXT" },
];

const DEFAULT_SETTINGS: Record<string, string> = {
  plate_fee_ngn: "200",
  currency: "NGN",
};

// Opens (or creates) the database, makes sure the tables exist and seeds an empty catalogue.
// Pass ":memory:" for a throwaway database in tests.
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: Database): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[db] added ${table}.${column}`);
    }
  }
}

// Seeds the catalogue only when it is empty, so owner edits survive restarts.
// Missing settings are always filled in; existing ones are never overwritten.
function seed(db: Database): void {
  db.exec("BEGIN");
  try {
    const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM catalogue").get() as { n: number };
    if (n === 0) {
      const insertItem = db.prepare(
        `INSERT INTO catalogue (id, name, category, price_ngn, description, on_plate, prep_note, available)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      for (const item of seedCatalogue as SeedItem[]) {
        insertItem.run(
          item.id,
          item.name,
          item.category,
          item.price_ngn,
          item.description ?? null,
          item.on_plate ? 1 : 0,
          item.prep_note ?? null,
        );
      }
      console.log(`[db] seeded catalogue with ${seedCatalogue.length} items`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface SeedItem {
  id: string;
  name: string;
  category: string;
  price_ngn: number;
  on_plate: boolean;
  description?: string;
  prep_note?: string;
}
