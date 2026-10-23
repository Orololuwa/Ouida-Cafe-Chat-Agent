import type { Database } from "./db/index.js";
import type { PaystackClient } from "./integrations/paystack.js";

// What the tools and routes need at runtime, built once at startup (or with fakes in tests).
export interface AppDeps {
  db: Database;
  paystack: PaystackClient;
  publicBaseUrl: string;
  paymentEmailDomain: string;
  now?: () => Date;
}
