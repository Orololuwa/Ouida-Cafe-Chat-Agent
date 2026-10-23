// The two Paystack calls the order desk makes. Every failure (network, timeout, Paystack error)
// comes back as { ok: false, error }, never as a thrown exception.
// Docs: https://paystack.com/docs/payments/accept-payments/ and /payments/verify-payments/

export interface InitializeRequest {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}

export interface Transaction {
  status: string; // Paystack's data.status: success, failed, abandoned, ongoing, pending, processing, queued, reversed
  amount: number; // kobo
  currency: string;
  gatewayResponse?: string;
}

export type InitializeResult = { ok: true; authorizationUrl: string } | { ok: false; error: string };
export type VerifyResult = { ok: true; transaction: Transaction } | { ok: false; error: string };

export interface PaystackClient {
  initialize(req: InitializeRequest): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
}

// How the server reads a transaction's data.status.
export type TransactionOutcome = "success" | "failed" | "not_completed" | "in_progress" | "reversed";

export function classifyStatus(status: string): TransactionOutcome {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "abandoned":
    case "initialized": // our own status before Paystack has been asked
      return "not_completed";
    case "reversed":
      return "reversed";
    default:
      // ongoing, pending, processing, queued, and anything new: not paid yet, check again shortly.
      return "in_progress";
  }
}

export function createPaystackClient(
  secretKey: string,
  { baseUrl = "https://api.paystack.co", timeoutMs = 15_000 }: { baseUrl?: string; timeoutMs?: number } = {},
): PaystackClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: unknown } | null;
      // The top-level `status` only says whether the API call worked.
      if (!res.ok || json?.status !== true) {
        return { ok: false as const, error: `Paystack ${res.status}: ${json?.message ?? res.statusText}` };
      }
      return { ok: true as const, data: json.data as Record<string, unknown> | undefined };
    } catch (err) {
      return { ok: false as const, error: `Paystack unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return {
    async initialize(req) {
      const r = await call("POST", "/transaction/initialize", {
        email: req.email,
        amount: String(req.amountKobo), // subunit: ₦11,400 -> "1140000"
        currency: "NGN",
        reference: req.reference,
        callback_url: req.callbackUrl,
        metadata: req.metadata,
      });
      if (!r.ok) return r;
      const url = r.data?.authorization_url;
      if (typeof url !== "string" || !url.startsWith("https://")) {
        return { ok: false, error: "Paystack initialize returned no authorization_url" };
      }
      return { ok: true, authorizationUrl: url };
    },

    async verify(reference) {
      const r = await call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      if (!r.ok) return r;
      const { status, amount, currency, gateway_response } = r.data ?? {};
      if (typeof status !== "string" || typeof amount !== "number" || typeof currency !== "string") {
        return { ok: false, error: "Paystack verify returned an unexpected shape" };
      }
      return {
        ok: true,
        transaction: {
          status,
          amount,
          currency,
          ...(typeof gateway_response === "string" && gateway_response ? { gatewayResponse: gateway_response } : {}),
        },
      };
    },
  };
}
