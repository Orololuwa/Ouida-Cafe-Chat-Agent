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

export type OrderStatus = "pending_payment" | "paid";

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
  paid_at?: string; // set once, when verified
  paid_reference?: string; // the payment attempt that paid
  notify_status?: "pending" | "sent" | "failed" | "skipped";
  notified_at?: string;
  notify_thread_id?: string;
  notify_error?: string;
}

// One Paystack transaction for an order. `status` is "initialized" when created,
// "init_failed" if Paystack never gave us a link, then Paystack's last reported status.
export interface PaymentAttempt {
  paystack_ref: string; // e.g. OU-7KQ3-2
  order_ref: string;
  attempt_no: number;
  amount_kobo: number;
  email: string;
  authorization_url?: string;
  status: string;
  gateway_response?: string;
  created_at: string;
  checked_at?: string;
}
