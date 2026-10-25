import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";
import type { AppDeps } from "../src/deps.js";
import { renderPaidOrderNotice, createNotifier } from "../src/domain/notifications.js";
import { createOrder, getOrder } from "../src/domain/orders.js";
import { createPaymentLink, verifyPayment } from "../src/domain/payments.js";
import type { Order, OrderLine, Plate } from "../src/domain/types.js";
import { createChordClient, type ChordClient, type ChordFailure } from "../src/integrations/chord.js";
import { makeDeps, ororoOrder, type FakePaystack } from "./helpers.js";

const THREAD = { id: "thr_owner", participantId: "owner-1" };
const PAID_AT = new Date("2026-10-24T11:09:00.000Z");

type Call = { method: string; args: unknown[] };

function fakeChord(script: {
  find?: () => Promise<{ ok: true; thread: typeof THREAD | null } | { ok: false; failure: ChordFailure }>;
  takeOver?: () => Promise<{ ok: true } | { ok: false; failure: ChordFailure }>;
  post?: () => Promise<{ ok: true; deliveryStatus: string; deliveryError?: string } | { ok: false; failure: ChordFailure }>;
  handBack?: () => Promise<{ ok: true } | { ok: false; failure: ChordFailure }>;
}): { chord: ChordClient; calls: Call[]; posts: string[] } {
  const calls: Call[] = [];
  const posts: string[] = [];
  const chord: ChordClient = {
    async findOwnerThread() {
      calls.push({ method: "find", args: [] });
      return script.find ? script.find() : { ok: true, thread: THREAD };
    },
    async takeOver(threadId, reason) {
      calls.push({ method: "takeOver", args: [threadId, reason] });
      return script.takeOver ? script.takeOver() : { ok: true };
    },
    async postMessage(threadId, text) {
      calls.push({ method: "post", args: [threadId, text] });
      posts.push(text);
      return script.post ? script.post() : { ok: true, deliveryStatus: "sent" };
    },
    async handBack(threadId, reason) {
      calls.push({ method: "handBack", args: [threadId, reason] });
      return script.handBack ? script.handBack() : { ok: true };
    },
  };
  return { chord, calls, posts };
}

function withNotifier(
  deps: AppDeps & { paystack: FakePaystack },
  chord: ChordClient,
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  deps.now = () => PAID_AT;
  const notifier = createNotifier({ ...deps, chord }, { sleep });
  deps.notifier = notifier;
  return notifier;
}

async function pay(deps: AppDeps & { paystack: FakePaystack }, ref: string) {
  await createPaymentLink(deps, { order_ref: ref });
  deps.paystack.pay(`${ref}-1`);
  return verifyPayment(deps, ref);
}

test("a paid Ororo order renders the owner notice at Lagos time", () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  const text = renderPaidOrderNotice(getOrder(deps.db, ref)!, {
    paidAt: PAID_AT,
    paidCount: 1,
    paidTotalNgn: 11_400,
  });
  assert.equal(
    text,
    [
      `🧾 *New paid order ${ref}* · 12:09`,
      "Ororo · 2 plates · *₦11,400*",
      "*Plate 1 (Ororo):* 1× Jollof Rice with Chicken, 1× Dodo",
      "*Plate 2 (Ada):* 1× Rice and Pepper Sauce (Beef), 1× Boiled egg",
      "*Drinks:* 2× Zobo (glass)",
      "Today: 1 paid order · ₦11,400",
    ].join("\n"),
  );
});

test("a notice longer than 4000 characters drops plate lines and keeps the totals", () => {
  const line: OrderLine = { item_id: "x", name: "X".repeat(500), qty: 1, unit_price_ngn: 100, line_total_ngn: 100 };
  const plate: Plate = { label: "A", lines: [line], subtotal_ngn: 100 };
  const order: Order = {
    ref: "OU-LONG",
    customer_name: "Ada",
    status: "paid",
    plates: [plate, plate, plate, plate, plate, plate, plate, plate, plate, plate],
    drinks: [],
    plate_count: 10,
    plate_fee_ngn: 200,
    total_ngn: 100,
    created_at: PAID_AT.toISOString(),
  };
  const text = renderPaidOrderNotice(order, { paidAt: PAID_AT, paidCount: 2, paidTotalNgn: 200 });
  assert.ok(text.length <= 4000);
  assert.match(text, /… ask for today's orders for the rest/);
  assert.match(text, /Today: 2 paid orders · ₦200/);
  assert.match(text, /12:09/);
});

test("paying once posts one notice and a second check does not", async () => {
  const deps = makeDeps();
  const { chord, calls, posts } = fakeChord({});
  const notifier = withNotifier(deps, chord);
  const ref = ororoOrder(deps);
  assert.equal((await pay(deps, ref)).status, "payment_confirmed");
  await notifier.whenIdle();

  const order = getOrder(deps.db, ref)!;
  assert.equal(order.status, "paid");
  assert.equal(order.notify_status, "sent");
  assert.equal(order.notify_thread_id, THREAD.id);
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(`New paid order ${ref}`));
  assert.match(posts[0], /Today: 1 paid order · ₦11,400/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["find", "takeOver", "post", "handBack"],
  );
  assert.deepEqual(calls[1].args, [THREAD.id, ref]);

  assert.equal((await verifyPayment(deps, ref)).status, "already_paid");
  await notifier.whenIdle();
  assert.equal(posts.length, 1);
});

test("no open owner thread skips the notice and leaves the order paid", async () => {
  const deps = makeDeps();
  const { chord, posts } = fakeChord({ find: async () => ({ ok: true, thread: null }) });
  const notifier = withNotifier(deps, chord);
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.status, "paid");
  assert.equal(order.notify_status, "skipped");
  assert.equal(order.notify_error, "no_owner_thread");
  assert.equal(posts.length, 0);
});

test("a 401 fails once as chord_auth", async () => {
  const deps = makeDeps();
  const { chord, calls } = fakeChord({ find: async () => ({ ok: false, failure: { kind: "auth" } }) });
  const notifier = withNotifier(deps, chord);
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.notify_status, "failed");
  assert.equal(order.notify_error, "chord_auth");
  assert.equal(calls.filter((call) => call.method === "find").length, 1);
});

test("a 5xx is retried twice then recorded as chord_unavailable", async () => {
  const deps = makeDeps();
  const sleeps: number[] = [];
  const { chord, calls } = fakeChord({
    find: async () => ({ ok: false, failure: { kind: "unavailable", error: "Chord 503" } }),
  });
  const notifier = withNotifier(deps, chord, async (ms) => {
    sleeps.push(ms);
  });
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  assert.deepEqual(sleeps, [5_000, 30_000]);
  assert.equal(calls.filter((call) => call.method === "find").length, 3);
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.notify_status, "failed");
  assert.equal(order.notify_error, "chord_unavailable");
});

test("a busy thread is tried once more, then given up without a hand-back", async () => {
  const deps = makeDeps();
  const sleeps: number[] = [];
  const { chord, calls } = fakeChord({
    takeOver: async () => ({ ok: false, failure: { kind: "busy" } }),
  });
  const notifier = withNotifier(deps, chord, async (ms) => {
    sleeps.push(ms);
  });
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(calls.filter((call) => call.method === "takeOver").length, 2);
  assert.equal(calls.some((call) => call.method === "post" || call.method === "handBack"), false);
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.notify_status, "failed");
  assert.equal(order.notify_error, "thread_busy");
});

test("a failed post still hands the thread back, then the job retries", async () => {
  const deps = makeDeps();
  const sleeps: number[] = [];
  const { chord, calls } = fakeChord({
    post: async () => ({ ok: false, failure: { kind: "unavailable", error: "socket hang up" } }),
  });
  const notifier = withNotifier(deps, chord, async (ms) => {
    sleeps.push(ms);
  });
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  assert.equal(calls.filter((call) => call.method === "post").length, 3);
  assert.equal(calls.filter((call) => call.method === "handBack").length, 3);
  assert.deepEqual(sleeps, [5_000, 30_000]);
  assert.equal(getOrder(deps.db, ref)!.notify_error, "chord_unavailable");
});

test("a delivered-then-failed message is not retried", async () => {
  const deps = makeDeps();
  const { chord, calls } = fakeChord({
    post: async () => ({ ok: true, deliveryStatus: "failed", deliveryError: "line closed" }),
  });
  const notifier = withNotifier(deps, chord);
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  assert.equal(calls.filter((call) => call.method === "post").length, 1);
  assert.equal(calls.filter((call) => call.method === "handBack").length, 1);
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.notify_status, "failed");
  assert.equal(order.notify_error, "line closed");
});

test("a hand-back that never succeeds leaves the order pending", async () => {
  const deps = makeDeps();
  const sleeps: number[] = [];
  const { chord, calls } = fakeChord({
    handBack: async () => ({ ok: false, failure: { kind: "unavailable", error: "Chord 500" } }),
  });
  const notifier = withNotifier(deps, chord, async (ms) => {
    sleeps.push(ms);
  });
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  await notifier.whenIdle();
  assert.deepEqual(sleeps, [1_000, 5_000, 30_000]);
  assert.equal(calls.filter((call) => call.method === "handBack").length, 4);
  assert.equal(calls.filter((call) => call.method === "post").length, 1);
  const order = getOrder(deps.db, ref)!;
  assert.equal(order.notify_status, "pending");
  assert.equal(order.notify_error, "hand_back_failed");
  assert.equal(order.notify_thread_id, THREAD.id);
});

test("two payments post in the order they were paid", async () => {
  const deps = makeDeps();
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let finds = 0;
  const { chord, posts } = fakeChord({
    find: async () => {
      finds += 1;
      if (finds === 1) await gate;
      return { ok: true, thread: THREAD };
    },
  });
  const notifier = withNotifier(deps, chord);
  const first = ororoOrder(deps);
  const secondResult = createOrder(deps.db, {
    customer_name: "Ada",
    plates: [{ label: "Ada", items: [{ item_id: "dodo", qty: 1 }] }],
  });
  if (secondResult.status !== "order_created") throw new Error(JSON.stringify(secondResult));
  const second = secondResult.order_ref;
  await pay(deps, first);
  await pay(deps, second);
  releaseFirst();
  await notifier.whenIdle();
  assert.equal(posts.length, 2);
  assert.match(posts[0], new RegExp(first));
  assert.match(posts[1], new RegExp(second));
});

test("startup requeues pending payments from the last hour only", async () => {
  const deps = makeDeps();
  deps.now = () => PAID_AT;
  const insert = (ref: string, paidAt: string, status: string) => {
    deps.db
      .prepare(
        `INSERT INTO orders (ref, customer_name, status, plates, drinks, plate_count, plate_fee_ngn, total_ngn, created_at, paid_at, notify_status)
         VALUES (?, 'Ororo', 'paid', '[]', '[]', 0, 200, 1000, ?, ?, ?)`,
      )
      .run(ref, paidAt, paidAt, status);
  };
  const recent = "OU-RECENT";
  insert(recent, new Date(PAID_AT.getTime() - 30 * 60 * 1000).toISOString(), "pending");
  insert("OU-OLD", new Date(PAID_AT.getTime() - 2 * 60 * 60 * 1000).toISOString(), "pending");
  insert("OU-SENT", new Date(PAID_AT.getTime() - 10 * 60 * 1000).toISOString(), "sent");

  const { chord, posts } = fakeChord({});
  const notifier = createNotifier({ ...deps, chord }, { sleep: async () => {} });
  notifier.requeueRecentPending();
  await notifier.whenIdle();
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(recent));
});

test("without a notifier a payment leaves notify_status empty", async () => {
  const deps = makeDeps();
  const ref = ororoOrder(deps);
  await pay(deps, ref);
  assert.equal(getOrder(deps.db, ref)!.notify_status, undefined);
});

test("NOTIFY_OWNER stays off unless it is true, and then every Chord value is required", () => {
  const env = {
    MCP_TOKEN: "x".repeat(32),
    OWNER_MCP_TOKEN: "y".repeat(32),
    PAYSTACK_SECRET_KEY: "sk_test_abc",
    PUBLIC_BASE_URL: "https://ouida-mcp.eleven-sports.app",
    PAYMENT_EMAIL_DOMAIN: "orders.eleven-sports.app",
  };
  assert.equal(loadConfig(env).notifyOwner, false);
  assert.equal(loadConfig({ ...env, NOTIFY_OWNER: "false" }).chord, undefined);

  const on = {
    ...env,
    NOTIFY_OWNER: "TRUE",
    CHORD_BASE_URL: "https://api.chordhq.xyz/",
    CHORD_API_KEY: "key",
    CHORD_WORKSPACE_ID: "ws",
    MENU_TEAMMATE_ID: "menu",
  };
  const loaded = loadConfig(on);
  assert.equal(loaded.notifyOwner, true);
  assert.equal(loaded.chord?.baseUrl, "https://api.chordhq.xyz");
  assert.throws(() => loadConfig({ ...on, MENU_TEAMMATE_ID: "" }), ConfigError);
  assert.throws(() => loadConfig({ ...on, CHORD_API_KEY: "" }), ConfigError);
});

test("the Chord client sends the spec's paths and classifies auth, busy, and delivery", async () => {
  const seen: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  let mode = "ok";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: raw ? (JSON.parse(raw) as unknown) : null,
        auth: req.headers.authorization,
      });
      if (mode === "auth") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no" }));
        return;
      }
      if (mode === "busy") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "INVALID_STATE" }));
        return;
      }
      if ((req.url ?? "").startsWith("/v1/threads?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "thr_1", participant_id: "p1" }] }));
        return;
      }
      if ((req.url ?? "").endsWith("/messages")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ delivery_status: "failed", delivery_error: "line closed" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const client = createChordClient(
      { baseUrl: `http://127.0.0.1:${port}`, apiKey: "secret", workspaceId: "ws", menuTeammateId: "menu" },
      { timeoutMs: 1000 },
    );
    const found = await client.findOwnerThread();
    assert.equal(found.ok && found.thread && found.thread.id, "thr_1");
    assert.equal(found.ok && found.thread && found.thread.participantId, "p1");
    assert.equal(seen[0].auth, "Bearer secret");
    assert.match(seen[0].url, /workspace_id=ws/);
    assert.match(seen[0].url, /agent_id=menu/);
    assert.match(seen[0].url, /channel_id=external_chat/);
    assert.match(seen[0].url, /status=open/);
    assert.match(seen[0].url, /limit=1/);

    assert.equal((await client.takeOver("thr_1", "OU-1")).ok, true);
    assert.equal(seen[1].method, "POST");
    assert.equal(seen[1].url, "/v1/threads/thr_1/take-over");
    assert.deepEqual(seen[1].body, { operator_user_id: "ouida-mcp", reason: "OU-1" });

    const posted = await client.postMessage("thr_1", "hello");
    assert.equal(posted.ok && posted.deliveryStatus, "failed");
    assert.equal(posted.ok && posted.deliveryError, "line closed");
    assert.deepEqual(seen[2].body, { operator_user_id: "ouida-mcp", text: "hello" });

    mode = "auth";
    const auth = await client.findOwnerThread();
    assert.equal(auth.ok, false);
    if (!auth.ok) assert.equal(auth.failure.kind, "auth");

    mode = "busy";
    const busy = await client.takeOver("thr_1", "OU-1");
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.failure.kind, "busy");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
