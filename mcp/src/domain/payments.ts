import type { Database } from "../db/index.js";
import type { AppDeps } from "../deps.js";
import { classifyStatus, type TransactionOutcome } from "../integrations/paystack.js";
import { getOrder } from "./orders.js";
import { formatNaira } from "./receipt.js";
import type { Order, PaymentAttempt } from "./types.js";

// At most 5 payment links per order. Attempts where Paystack never returned a link don't
// count towards that, but the hard cap stops a broken key from creating rows without end.
export const MAX_LINKS = 5;
const MAX_ATTEMPT_ROWS = 20;

// ---------- results ----------

interface PaidResult {
  status: "payment_confirmed" | "already_paid";
  order_ref: string;
  paid_reference: string;
  amount_ngn: number;
  message_text: string;
}
interface LinkReady {
  status: "link_ready";
  order_ref: string;
  paystack_ref: string;
  amount_ngn: number;
  payment_url: string;
  message_text: string;
}
type Bare<S extends string> = { status: S; order_ref: string };

export type CreatePaymentLinkResult =
  | LinkReady
  | (PaidResult & { status: "already_paid" })
  | Bare<"order_not_found" | "too_many_attempts" | "payment_link_failed" | "amount_mismatch" | "payment_reversed">;

export type VerifyPaymentResult =
  | PaidResult
  | { status: "payment_pending"; order_ref: string; paystack_ref: string }
  | {
      status: "payment_not_completed";
      order_ref: string;
      paystack_ref: string;
      amount_ngn: number;
      payment_url: string;
      message_text: string;
    }
  | { status: "payment_failed"; order_ref: string; paystack_ref: string; reason: string }
  | Bare<"amount_mismatch" | "payment_reversed" | "no_payment_started" | "order_not_found" | "payment_check_failed">;

// ---------- messages (rendered here so the customer sees exactly the server's amounts and links) ----------

function linkMessage(orderRef: string, amountNgn: number, url: string): string {
  return `Pay *${formatNaira(amountNgn)}* for order *${orderRef}* here:\n${url}\nReply *paid* when you're done.`;
}

function notCompletedMessage(orderRef: string, amountNgn: number, url: string): string {
  return `Your payment for order *${orderRef}* hasn't gone through yet. You can pay *${formatNaira(amountNgn)}* here:\n${url}\nReply *paid* when you're done.`;
}

function paidResult(status: PaidResult["status"], order: Order): PaidResult {
  const message_text =
    status === "payment_confirmed"
      ? `Payment received ✅\nOrder *${order.ref}* for ${order.customer_name} is confirmed.\nShow this reference when you collect it.`
      : `Order *${order.ref}* for ${order.customer_name} is already paid ✅\nShow this reference when you collect it.`;
  return {
    status,
    order_ref: order.ref,
    paid_reference: order.paid_reference ?? "",
    amount_ngn: order.total_ngn,
    message_text,
  };
}

// ---------- attempts ----------

interface AttemptRow {
  paystack_ref: string;
  order_ref: string;
  attempt_no: number;
  amount_kobo: number;
  email: string;
  authorization_url: string | null;
  status: string;
  gateway_response: string | null;
  created_at: string;
  checked_at: string | null;
}

function toAttempt(row: AttemptRow): PaymentAttempt {
  return {
    paystack_ref: row.paystack_ref,
    order_ref: row.order_ref,
    attempt_no: row.attempt_no,
    amount_kobo: row.amount_kobo,
    email: row.email,
    ...(row.authorization_url ? { authorization_url: row.authorization_url } : {}),
    status: row.status,
    ...(row.gateway_response ? { gateway_response: row.gateway_response } : {}),
    created_at: row.created_at,
    ...(row.checked_at ? { checked_at: row.checked_at } : {}),
  };
}

export function getAttempt(db: Database, paystackRef: string): PaymentAttempt | undefined {
  const row = db.prepare("SELECT * FROM payment_attempts WHERE paystack_ref = ?").get(paystackRef) as AttemptRow | undefined;
  return row ? toAttempt(row) : undefined;
}

// Every attempt for an order, newest first.
export function getAttempts(db: Database, orderRef: string): PaymentAttempt[] {
  const rows = db
    .prepare("SELECT * FROM payment_attempts WHERE order_ref = ? ORDER BY attempt_no DESC")
    .all(orderRef) as unknown as AttemptRow[];
  return rows.map(toAttempt);
}

// Attempts that produced a link the customer could have paid on, newest first.
function linkAttempts(db: Database, orderRef: string): (PaymentAttempt & { authorization_url: string })[] {
  return getAttempts(db, orderRef).filter((a): a is PaymentAttempt & { authorization_url: string } => !!a.authorization_url);
}

const iso = (deps: AppDeps) => (deps.now?.() ?? new Date()).toISOString();
// Accepts the reference however the agent wraps it ("ou-8r9a", "*OU-8R9A*", "Order OU-8R9A").
const normalizeRef = (ref: string) => {
  const upper = ref.trim().toUpperCase();
  return upper.match(/\bOU-[A-Z0-9]{4}\b/)?.[0] ?? upper;
};

// ---------- checking one attempt with Paystack ----------

type Check =
  | { kind: "paid"; claimed: boolean } // passed all three checks; claimed = this call marked the order paid
  | { kind: "mismatch" }
  | { kind: "outcome"; outcome: Exclude<TransactionOutcome, "success"> }
  | { kind: "error" };

async function checkAttempt(deps: AppDeps, order: Order, attempt: PaymentAttempt): Promise<Check> {
  const { db } = deps;
  const r = await deps.paystack.verify(attempt.paystack_ref);
  if (!r.ok) {
    console.warn(`[payments] verify ${attempt.paystack_ref} failed: ${r.error}`);
    return { kind: "error" };
  }

  const tx = r.transaction;
  const now = iso(deps);
  const record = db.prepare(
    "UPDATE payment_attempts SET status = ?, gateway_response = ?, checked_at = ? WHERE paystack_ref = ?",
  );
  const outcome = classifyStatus(tx.status);

  if (outcome !== "success") {
    record.run(tx.status, tx.gatewayResponse ?? null, now, attempt.paystack_ref);
    return { kind: "outcome", outcome };
  }

  // Paid only if all three hold: success, the attempt's exact amount (which must still be the
  // order's total), and naira.
  const orderKobo = order.total_ngn * 100;
  if (tx.amount !== attempt.amount_kobo || tx.amount !== orderKobo || tx.currency !== "NGN") {
    record.run(tx.status, tx.gatewayResponse ?? null, now, attempt.paystack_ref);
    console.warn(
      `[payments] amount_mismatch on ${attempt.paystack_ref}: Paystack says ${tx.amount} ${tx.currency}, ` +
        `attempt ${attempt.amount_kobo} NGN, order ${orderKobo} NGN (kobo)`,
    );
    return { kind: "mismatch" };
  }

  // One transaction, and only if the order is still pending, so two checks arriving together
  // (the callback page and the agent) can't both claim it.
  db.exec("BEGIN IMMEDIATE");
  try {
    record.run(tx.status, tx.gatewayResponse ?? null, now, attempt.paystack_ref);
    const { changes } = db
      .prepare(
        "UPDATE orders SET status = 'paid', paid_at = ?, paid_reference = ? WHERE ref = ? AND status = 'pending_payment'",
      )
      .run(now, attempt.paystack_ref, order.ref);
    db.exec("COMMIT");
    const claimed = Number(changes) === 1;
    if (claimed) console.log(`[payments] ${order.ref} paid via ${attempt.paystack_ref}`);
    return { kind: "paid", claimed };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- create_payment_link ----------

export async function createPaymentLink(
  deps: AppDeps,
  input: { order_ref: string; new_link?: boolean | null },
): Promise<CreatePaymentLinkResult> {
  const { db } = deps;
  const orderRef = normalizeRef(input.order_ref);
  let order = getOrder(db, orderRef);
  if (!order) return { status: "order_not_found", order_ref: orderRef };
  if (order.status === "paid") return { ...paidResult("already_paid", order), status: "already_paid" };

  // Ask Paystack about the current link first, even when a new one is requested,
  // so a customer who actually paid is never sent a second link.
  const latest = linkAttempts(db, orderRef)[0];
  if (latest && latest.status !== "failed") {
    const check = await checkAttempt(deps, order, latest);
    if (check.kind === "paid") {
      order = getOrder(db, orderRef)!;
      return { ...paidResult("already_paid", order), status: "already_paid" };
    }
    if (check.kind === "mismatch") return { status: "amount_mismatch", order_ref: orderRef };
    if (check.kind === "outcome" && check.outcome === "reversed") return { status: "payment_reversed", order_ref: orderRef };

    const stillUsable = check.kind === "error" || check.outcome !== "failed";
    if (stillUsable && !input.new_link) {
      const amountNgn = latest.amount_kobo / 100;
      return {
        status: "link_ready",
        order_ref: orderRef,
        paystack_ref: latest.paystack_ref,
        amount_ngn: amountNgn,
        payment_url: latest.authorization_url,
        message_text: linkMessage(orderRef, amountNgn, latest.authorization_url),
      };
    }
  }

  // New attempt n + 1. Reserved synchronously (count, number and insert in one step) before
  // calling Paystack, so concurrent calls never share a reference and a timed-out call never
  // blocks the next one with a duplicate reference.
  const attempts = getAttempts(db, orderRef);
  const links = attempts.filter((a) => a.authorization_url).length;
  if (links >= MAX_LINKS || attempts.length >= MAX_ATTEMPT_ROWS) {
    console.warn(`[payments] ${orderRef} hit the attempt limit (${links} links, ${attempts.length} attempts)`);
    return { status: "too_many_attempts", order_ref: orderRef };
  }
  const attemptNo = (attempts[0]?.attempt_no ?? 0) + 1;
  const paystackRef = `${orderRef}-${attemptNo}`;
  const amountKobo = order.total_ngn * 100;
  const email = `${orderRef.toLowerCase()}@${deps.paymentEmailDomain}`;
  db.prepare(
    `INSERT INTO payment_attempts (paystack_ref, order_ref, attempt_no, amount_kobo, email, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'initialized', ?)`,
  ).run(paystackRef, orderRef, attemptNo, amountKobo, email, iso(deps));

  const init = await deps.paystack.initialize({
    email,
    amountKobo,
    reference: paystackRef,
    callbackUrl: `${deps.publicBaseUrl}/paid`,
    metadata: { order_ref: orderRef, cancel_action: `${deps.publicBaseUrl}/paid?cancelled=1` },
  });
  if (!init.ok) {
    db.prepare("UPDATE payment_attempts SET status = 'init_failed', gateway_response = ? WHERE paystack_ref = ?").run(
      init.error,
      paystackRef,
    );
    console.warn(`[payments] initialize ${paystackRef} failed: ${init.error}`);
    return { status: "payment_link_failed", order_ref: orderRef };
  }
  db.prepare("UPDATE payment_attempts SET authorization_url = ? WHERE paystack_ref = ?").run(
    init.authorizationUrl,
    paystackRef,
  );

  return {
    status: "link_ready",
    order_ref: orderRef,
    paystack_ref: paystackRef,
    amount_ngn: order.total_ngn,
    payment_url: init.authorizationUrl,
    message_text: linkMessage(orderRef, order.total_ngn, init.authorizationUrl),
  };
}

// ---------- verify_payment ----------

export async function verifyPayment(deps: AppDeps, inputRef: string): Promise<VerifyPaymentResult> {
  const { db } = deps;
  const orderRef = normalizeRef(inputRef);
  let order = getOrder(db, orderRef);
  if (!order) return { status: "order_not_found", order_ref: orderRef };
  if (order.status === "paid") return paidResult("already_paid", order);

  const attempts = linkAttempts(db, orderRef);
  if (attempts.length === 0) return { status: "no_payment_started", order_ref: orderRef };

  // Every open attempt, newest first: a customer may have paid on an older link after a newer one was sent.
  let mismatch = false;
  let checkFailed = false;
  for (const attempt of attempts) {
    if (attempt.status === "failed") continue;
    const check = await checkAttempt(deps, order, attempt);
    if (check.kind === "paid") {
      order = getOrder(db, orderRef)!;
      return paidResult(check.claimed ? "payment_confirmed" : "already_paid", order);
    }
    if (check.kind === "mismatch") mismatch = true;
    if (check.kind === "error") checkFailed = true;
  }

  order = getOrder(db, orderRef)!;
  if (order.status === "paid") return paidResult("already_paid", order); // claimed by a concurrent check
  if (mismatch) return { status: "amount_mismatch", order_ref: orderRef };
  if (checkFailed) return { status: "payment_check_failed", order_ref: orderRef }; // never assume either way

  // Nothing passed: report the newest attempt, as Paystack last described it.
  const newest = getAttempt(db, attempts[0].paystack_ref)!;
  const url = newest.authorization_url!;
  const amountNgn = newest.amount_kobo / 100;
  switch (classifyStatus(newest.status)) {
    case "failed":
      return {
        status: "payment_failed",
        order_ref: orderRef,
        paystack_ref: newest.paystack_ref,
        reason: newest.gateway_response ?? "The payment was declined",
      };
    case "not_completed":
      return {
        status: "payment_not_completed",
        order_ref: orderRef,
        paystack_ref: newest.paystack_ref,
        amount_ngn: amountNgn,
        payment_url: url,
        message_text: notCompletedMessage(orderRef, amountNgn, url),
      };
    case "reversed":
      return { status: "payment_reversed", order_ref: orderRef };
    default:
      return { status: "payment_pending", order_ref: orderRef, paystack_ref: newest.paystack_ref };
  }
}

// ---------- the callback page ----------

export const PAYSTACK_REF_PATTERN = /^OU-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-\d{1,2}$/;

// Runs the same verification as verify_payment for the order behind a Paystack reference.
// The reference itself proves nothing; only Paystack's answer does.
export async function verifyByPaystackRef(
  deps: AppDeps,
  paystackRef: string,
): Promise<{ found: false } | { found: true; order_ref: string; result: VerifyPaymentResult }> {
  if (!PAYSTACK_REF_PATTERN.test(paystackRef)) return { found: false };
  const attempt = getAttempt(deps.db, paystackRef);
  if (!attempt) return { found: false };
  return { found: true, order_ref: attempt.order_ref, result: await verifyPayment(deps, attempt.order_ref) };
}
