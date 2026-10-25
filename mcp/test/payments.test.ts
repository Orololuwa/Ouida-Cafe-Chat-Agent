import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { getOrder } from "../src/domain/orders.js";
import { createPaymentLink, getAttempts, MAX_LINKS, verifyPayment } from "../src/domain/payments.js";
import { makeDeps, ororoOrder } from "./helpers.js";

test("1. create_payment_link returns link_ready for attempt -1 at the order total", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  const r = await createPaymentLink(deps, { order_ref: ref });

  assert.equal(r.status, "link_ready");
  if (r.status !== "link_ready") return;
  assert.equal(r.paystack_ref, `${ref}-1`);
  assert.equal(r.amount_ngn, 11400);
  assert.equal(r.message_text, `Pay *₦11,400* for order *${ref}* here:\n${r.payment_url}\nReply *paid* when you're done.`);

  assert.deepEqual(deps.paystack.initCalls, [
    {
      email: `${ref.toLowerCase()}@orders.example.test`,
      amountKobo: 1140000,
      reference: `${ref}-1`,
      callbackUrl: "https://ouida-mcp.example.test/paid",
      metadata: { order_ref: ref, cancel_action: "https://ouida-mcp.example.test/paid?cancelled=1" },
    },
  ]);
});

test("2. Asking again before paying returns the same link and creates no new attempt", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  const first = await createPaymentLink(deps, { order_ref: ref });
  const second = await createPaymentLink(deps, { order_ref: ref.toLowerCase() }); // refs are case-insensitive
  assert.deepEqual(second, first);
  assert.equal(deps.paystack.initCalls.length, 1);
  assert.equal(getAttempts(deps.db, ref).length, 1);
});

test("3. verify_payment before paying is payment_not_completed and resends the same link", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  const link = await createPaymentLink(deps, { order_ref: ref });
  const r = await verifyPayment(deps, ref);
  assert.equal(r.status, "payment_not_completed");
  if (r.status !== "payment_not_completed" || link.status !== "link_ready") return;
  assert.equal(r.payment_url, link.payment_url);
  assert.match(r.message_text, /hasn't gone through yet.*₦11,400/s);
  assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");
});

test("4–5. Paying confirms once; afterwards already_paid without asking Paystack", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.pay(`${ref}-1`);

  const confirmed = await verifyPayment(deps, ref);
  assert.deepEqual(confirmed, {
    status: "payment_confirmed",
    order_ref: ref,
    paid_reference: `${ref}-1`,
    amount_ngn: 11400,
    message_text: `Payment received ✅\nOrder *${ref}* for Ororo is confirmed.\nShow this reference when you collect it.`,
  });
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.status, "paid");
  assert.equal(order.paid_reference, `${ref}-1`);
  assert.ok(order.paid_at);

  const calls = deps.paystack.verifyCalls.length;
  const again = await verifyPayment(deps, ref);
  assert.equal(again.status, "already_paid");
  assert.equal(deps.paystack.verifyCalls.length, calls, "already_paid must not call Paystack");
  assert.equal((await createPaymentLink(deps, { order_ref: ref, new_link: true })).status, "already_paid");
});

test("6–7. A declined card is payment_failed with the reason; the next link is -2 and can pay", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.decline(`${ref}-1`, "Declined");

  const failed = await verifyPayment(deps, ref);
  assert.deepEqual(failed, { status: "payment_failed", order_ref: ref, paystack_ref: `${ref}-1`, reason: "Declined" });

  const link = await createPaymentLink(deps, { order_ref: ref, new_link: true });
  assert.equal(link.status, "link_ready");
  if (link.status !== "link_ready") return;
  assert.equal(link.paystack_ref, `${ref}-2`);

  // Even without new_link, a failed latest attempt gets a fresh link rather than the dead one.
  const deps2 = makeDeps();
  const ref2 = ororoOrder(deps2);
  await createPaymentLink(deps2, { order_ref: ref2 });
  deps2.paystack.decline(`${ref2}-1`);
  const fresh = await createPaymentLink(deps2, { order_ref: ref2 });
  assert.equal(fresh.status === "link_ready" && fresh.paystack_ref, `${ref2}-2`);

  deps.paystack.pay(`${ref}-2`);
  const r = await verifyPayment(deps, ref);
  assert.equal(r.status, "payment_confirmed");
  assert.equal(r.status === "payment_confirmed" && r.paid_reference, `${ref}-2`);
});

test("8. Paying on the older of two links still confirms, via the older reference", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  await createPaymentLink(deps, { order_ref: ref, new_link: true });
  assert.equal(getAttempts(deps.db, ref).length, 2);

  deps.paystack.pay(`${ref}-1`);
  const r = await verifyPayment(deps, ref);
  assert.equal(r.status, "payment_confirmed");
  assert.equal(r.status === "payment_confirmed" && r.paid_reference, `${ref}-1`);
});

test("9. A changed order total is amount_mismatch and the order stays pending", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.pay(`${ref}-1`);
  deps.db.prepare("UPDATE orders SET total_ngn = 12000 WHERE ref = ?").run(ref);

  assert.deepEqual(await verifyPayment(deps, ref), { status: "amount_mismatch", order_ref: ref });
  assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");
  assert.equal((await createPaymentLink(deps, { order_ref: ref })).status, "amount_mismatch");
});

test("Paystack reporting a different amount or currency is amount_mismatch", async () => {
  for (const change of [{ amount: 1000000 }, { currency: "USD" }]) {
    const deps = makeDeps();
    const ref = ororoOrder(deps);
    await createPaymentLink(deps, { order_ref: ref });
    deps.paystack.set(`${ref}-1`, { status: "success", ...change });
    assert.equal((await verifyPayment(deps, ref)).status, "amount_mismatch");
    assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");
  }
});

test("11. Paystack failures become payment_link_failed / payment_check_failed, and recover", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  deps.paystack.down = true;
  assert.deepEqual(await createPaymentLink(deps, { order_ref: ref }), { status: "payment_link_failed", order_ref: ref });
  assert.equal(getAttempts(deps.db, ref)[0].status, "init_failed");
  // A link that was never created doesn't count as a payment started.
  assert.equal((await verifyPayment(deps, ref)).status, "no_payment_started");

  deps.paystack.down = false;
  const link = await createPaymentLink(deps, { order_ref: ref });
  assert.equal(link.status === "link_ready" && link.paystack_ref, `${ref}-2`); // -1 is never reused

  deps.paystack.down = true;
  assert.deepEqual(await verifyPayment(deps, ref), { status: "payment_check_failed", order_ref: ref });
  assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");
  // The current link is still handed back when Paystack can't be asked about it.
  assert.equal((await createPaymentLink(deps, { order_ref: ref })).status, "link_ready");
});

test("12. The server refuses a live key", () => {
  const env = {
    MCP_TOKEN: "x".repeat(32),
    OWNER_MCP_TOKEN: "y".repeat(32),
    PUBLIC_BASE_URL: "https://ouida-mcp.eleven-sports.app/",
    PAYMENT_EMAIL_DOMAIN: "orders.eleven-sports.app",
  };
  assert.throws(() => loadConfig({ ...env, PAYSTACK_SECRET_KEY: "sk_live_abc" }), ConfigError);
  assert.throws(() => loadConfig(env), ConfigError);
  assert.throws(() => loadConfig({ ...env, PAYSTACK_SECRET_KEY: "sk_test_abc", PUBLIC_BASE_URL: "ouida" }), ConfigError);
  const ok = loadConfig({ ...env, PAYSTACK_SECRET_KEY: "sk_test_abc" });
  assert.equal(ok.publicBaseUrl, "https://ouida-mcp.eleven-sports.app"); // trailing slash trimmed
  assert.throws(() => loadConfig({ ...env, PAYSTACK_SECRET_KEY: "sk_test_abc", OWNER_MCP_TOKEN: "x".repeat(32) }), ConfigError);
  assert.throws(() => loadConfig({ ...env, PAYSTACK_SECRET_KEY: "sk_test_abc", OWNER_MCP_TOKEN: "short" }), ConfigError);
});

test("13. An existing database upgrades in place with its orders intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "ouida-"));
  try {
    const path = join(dir, "ouida.db");
    // The first release's orders table, with one order in it.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE orders (ref TEXT PRIMARY KEY, customer_name TEXT NOT NULL, customer_handle TEXT,
      status TEXT NOT NULL, plates TEXT NOT NULL, drinks TEXT NOT NULL, plate_count INTEGER NOT NULL,
      plate_fee_ngn INTEGER NOT NULL, total_ngn INTEGER NOT NULL, created_at TEXT NOT NULL)`);
    old.prepare("INSERT INTO orders VALUES ('OU-4AGR', 'Ororo', NULL, 'pending_payment', '[]', '[]', 0, 200, 11400, '2026-10-22T20:25:51Z')").run();
    old.close();

    const db = openDatabase(path);
    const order = getOrder(db, "OU-4AGR")!;
    assert.equal(order.total_ngn, 11400);
    assert.equal(order.status, "pending_payment");
    const cols = (db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("paid_at") && cols.includes("paid_reference"));
    assert.ok(["notify_status", "notified_at", "notify_thread_id", "notify_error"].every((name) => cols.includes(name)));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'payment_attempts'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'menu_changes'").get());
    db.close();
    openDatabase(path).close(); // a second start is a no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Unknown orders, no link yet, in-progress and reversed payments", async () => {
  const deps = makeDeps();
  assert.deepEqual(await createPaymentLink(deps, { order_ref: "OU-ZZZZ" }), { status: "order_not_found", order_ref: "OU-ZZZZ" });
  assert.deepEqual(await verifyPayment(deps, "OU-ZZZZ"), { status: "order_not_found", order_ref: "OU-ZZZZ" });

  const ref = ororoOrder(deps);
  assert.deepEqual(await verifyPayment(deps, ref), { status: "no_payment_started", order_ref: ref });

  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.set(`${ref}-1`, { status: "ongoing" });
  assert.equal((await verifyPayment(deps, ref)).status, "payment_pending");

  deps.paystack.set(`${ref}-1`, { status: "reversed" });
  assert.equal((await verifyPayment(deps, ref)).status, "payment_reversed");
  assert.equal((await createPaymentLink(deps, { order_ref: ref })).status, "payment_reversed");
  assert.equal(getOrder(deps.db, ref)!.status, "pending_payment");
});

test(`At most ${MAX_LINKS} links per order`, async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  for (let i = 1; i <= MAX_LINKS; i++) {
    const r = await createPaymentLink(deps, { order_ref: ref, new_link: true });
    assert.equal(r.status === "link_ready" && r.paystack_ref, `${ref}-${i}`);
  }
  assert.deepEqual(await createPaymentLink(deps, { order_ref: ref, new_link: true }), {
    status: "too_many_attempts",
    order_ref: ref,
  });
});

test("Two checks arriving together claim the order once", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.pay(`${ref}-1`);
  const results = await Promise.all([verifyPayment(deps, ref), verifyPayment(deps, ref)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["already_paid", "payment_confirmed"]);
});

test("A link whose payment already succeeded returns already_paid instead of a new link", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.pay(`${ref}-1`);
  const r = await createPaymentLink(deps, { order_ref: ref, new_link: true });
  assert.equal(r.status, "already_paid");
  assert.equal(getOrder(deps.db, ref)!.status, "paid");
  assert.equal(getAttempts(deps.db, ref).length, 1);
});
