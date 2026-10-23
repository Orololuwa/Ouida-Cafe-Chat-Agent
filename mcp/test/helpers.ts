import { openDatabase } from "../src/db/index.js";
import type { AppDeps } from "../src/deps.js";
import { createOrder } from "../src/domain/orders.js";
import type {
  InitializeRequest,
  InitializeResult,
  PaystackClient,
  Transaction,
  VerifyResult,
} from "../src/integrations/paystack.js";

// In-memory stand-in for Paystack. Initialized transactions start "abandoned", like Paystack's own
// answer for a link nobody has paid on yet.
export class FakePaystack implements PaystackClient {
  transactions = new Map<string, Transaction>();
  initCalls: InitializeRequest[] = [];
  verifyCalls: string[] = [];
  down = false;

  async initialize(req: InitializeRequest): Promise<InitializeResult> {
    if (this.down) return { ok: false, error: "Paystack 401: Invalid key" };
    this.initCalls.push(req);
    this.transactions.set(req.reference, { status: "abandoned", amount: req.amountKobo, currency: "NGN" });
    return { ok: true, authorizationUrl: `https://checkout.paystack.com/${req.reference.toLowerCase()}` };
  }

  async verify(reference: string): Promise<VerifyResult> {
    this.verifyCalls.push(reference);
    if (this.down) return { ok: false, error: "Paystack 401: Invalid key" };
    const tx = this.transactions.get(reference);
    if (!tx) return { ok: false, error: "Paystack 400: Transaction reference not found" };
    return { ok: true, transaction: { ...tx } };
  }

  set(reference: string, change: Partial<Transaction>): void {
    this.transactions.set(reference, { ...this.transactions.get(reference)!, ...change });
  }
  pay(reference: string): void {
    this.set(reference, { status: "success", gatewayResponse: "Successful" });
  }
  decline(reference: string, reason = "Declined"): void {
    this.set(reference, { status: "failed", gatewayResponse: reason });
  }
}

export function makeDeps(): AppDeps & { paystack: FakePaystack } {
  return {
    db: openDatabase(":memory:"),
    paystack: new FakePaystack(),
    publicBaseUrl: "https://ouida-mcp.example.test",
    paymentEmailDomain: "orders.example.test",
  };
}

// The spec's Ororo order: ₦11,400.
export function ororoOrder(deps: AppDeps): string {
  const r = createOrder(deps.db, {
    customer_name: "Ororo",
    plates: [
      { label: "Ororo", items: [{ item_id: "jollof-chicken", qty: 1 }, { item_id: "dodo", qty: 1 }] },
      { label: "Ada", items: [{ item_id: "rice-pepper-sauce-beef", qty: 1 }, { item_id: "boiled-egg", qty: 1 }] },
    ],
    drinks: [{ item_id: "zobo-glass", qty: 2 }],
  });
  if (r.status !== "order_created") throw new Error(JSON.stringify(r));
  return r.order_ref;
}
