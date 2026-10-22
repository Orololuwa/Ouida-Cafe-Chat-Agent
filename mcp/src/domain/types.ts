// Shared shapes for the catalogue and orders. All money is whole naira (`_ngn`).

export const CATEGORIES = ["food", "protein", "sweet", "hot_drink", "drink"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface CatalogueItem {
  id: string;
  name: string;
  category: Category;
  price_ngn: number;
  description?: string;
  on_plate: boolean;
  prep_note?: string;
  available: boolean;
}

export interface Settings {
  plate_fee_ngn: number;
  currency: string;
}

export type OrderStatus = "pending_payment";

export interface OrderLine {
  item_id: string;
  name: string; // snapshot
  qty: number;
  unit_price_ngn: number; // snapshot
  line_total_ngn: number;
  note?: string;
}

export interface Plate {
  label?: string;
  lines: OrderLine[];
  subtotal_ngn: number;
}

export interface Order {
  ref: string;
  customer_name: string;
  customer_handle?: string;
  status: OrderStatus;
  plates: Plate[];
  drinks: OrderLine[];
  plate_count: number;
  plate_fee_ngn: number; // snapshot
  total_ngn: number;
  created_at: string;
}
