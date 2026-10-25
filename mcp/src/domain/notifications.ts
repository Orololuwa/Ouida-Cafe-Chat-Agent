import type { AppDeps, Notifier } from "../deps.js";
import type { ChordClient, ChordFailure, OwnerThread } from "../integrations/chord.js";
import { getOrder } from "./orders.js";
import { todaysOrders } from "./owner.js";
import { formatNaira } from "./receipt.js";
import type { Order, OrderLine } from "./types.js";

// Chord rejects operator messages longer than this. The plate list is what gets cut.
const MAX_CHARS = 4000;
const CUT = "… ask for today's orders for the rest";
const REQUEUE_WINDOW_MS = 60 * 60 * 1000;
const JOB_DELAYS_MS = [5_000, 30_000]; // after the 1st and 2nd try
const HAND_BACK_DELAYS_MS = [1_000, 5_000, 30_000];

export interface PaidOrderNotice {
  paidAt: Date;
  paidCount: number;
  paidTotalNgn: number;
}

// The kitchen reads this as-is. Numbers come from the saved order and from todays_orders.
export function renderPaidOrderNotice(order: Order, notice: PaidOrderNotice): string {
  const plates = order.plate_count === 1 ? "1 plate" : `${order.plate_count} plates`;
  const head = [
    `🧾 *New paid order ${order.ref}* · ${lagosClock(notice.paidAt)}`,
    order.plate_count > 0
      ? `${order.customer_name} · ${plates} · *${formatNaira(order.total_ngn)}*`
      : `${order.customer_name} · *${formatNaira(order.total_ngn)}*`,
  ].join("\n");

  const body: string[] = order.plates.map((plate, i) => {
    const title = plate.label ? `*Plate ${i + 1} (${plate.label}):*` : `*Plate ${i + 1}:*`;
    return `${title} ${plate.lines.map(itemText).join(", ")}`;
  });
  if (order.drinks.length > 0) body.push(`*Drinks:* ${order.drinks.map(itemText).join(", ")}`);

  const orders = notice.paidCount === 1 ? "1 paid order" : `${notice.paidCount} paid orders`;
  const today = `Today: ${orders} · ${formatNaira(notice.paidTotalNgn)}`;
  const full = [...(body.length > 0 ? [head, ...body, today] : [head, today])].join("\n");
  if (full.length <= MAX_CHARS) return full;

  const kept = [...body];
  while (kept.length > 0) {
    const candidate = [head, ...kept, CUT, today].join("\n");
    if (candidate.length <= MAX_CHARS) return candidate;
    kept.pop();
  }
  const minimal = [head, CUT, today].join("\n");
  return minimal.length <= MAX_CHARS ? minimal : `${minimal.slice(0, MAX_CHARS - 1)}…`;
}

function itemText(line: OrderLine): string {
  return line.note ? `${line.qty}× ${line.name} (${line.note})` : `${line.qty}× ${line.name}`;
}

function lagosClock(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

export interface NotifierHandle extends Notifier {
  requeueRecentPending(): void;
  whenIdle(): Promise<void>;
}

// One in-process queue. One job at a time, so two payments can't both hold the owner's thread.
export function createNotifier(
  deps: AppDeps & { chord: ChordClient },
  { sleep = delay }: { sleep?: (ms: number) => Promise<void> } = {},
): NotifierHandle {
  const queue: string[] = [];
  const waiting = new Set<string>();
  let running = false;
  let idle = Promise.resolve();
  let markIdle = (): void => {};

  function enqueue(orderRef: string): void {
    if (waiting.has(orderRef)) return;
    waiting.add(orderRef);
    queue.push(orderRef);
    if (running) return;
    running = true;
    idle = new Promise((resolve) => {
      markIdle = resolve;
    });
    void pump();
  }

  async function pump(): Promise<void> {
    try {
      while (queue.length > 0) {
        const ref = queue.shift()!;
        try {
          await runJob(deps, ref, 1, sleep);
        } catch (err) {
          console.error(`[notify] ${ref} job crashed`, err);
        } finally {
          waiting.delete(ref);
        }
      }
    } finally {
      // Nothing else runs until this function awaits, so the queue can't grow between these lines.
      if (queue.length > 0) {
        void pump();
        return;
      }
      running = false;
      markIdle();
    }
  }

  return {
    enqueue,
    requeueRecentPending() {
      const since = new Date((deps.now?.() ?? new Date()).getTime() - REQUEUE_WINDOW_MS).toISOString();
      const rows = deps.db
        .prepare(
          `SELECT ref FROM orders
           WHERE status = 'paid' AND notify_status = 'pending' AND paid_at >= ?
           ORDER BY paid_at ASC`,
        )
        .all(since) as { ref: string }[];
      for (const row of rows) enqueue(row.ref);
    },
    whenIdle: () => idle,
  };
}

async function runJob(deps: AppDeps & { chord: ChordClient }, ref: string, attempt: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const order = getOrder(deps.db, ref);
  if (!order || order.status !== "paid" || (order.notify_status && order.notify_status !== "pending")) return;

  const found = await deps.chord.findOwnerThread();
  if (!found.ok) {
    if (found.failure.kind === "auth") return finish(deps, order, "failed", "chord_auth");
    if (found.failure.kind === "rejected" || found.failure.kind === "busy") return finish(deps, order, "failed", found.failure.kind === "busy" ? "thread_busy" : found.failure.error);
    return retry(deps, ref, attempt, sleep, found.failure);
  }
  if (!found.thread) return finish(deps, order, "skipped", "no_owner_thread");

  const thread = found.thread;
  const held = await takeOver(deps.chord, thread.id, ref, sleep);
  if (!held.ok) {
    if (held.failure.kind === "auth") return finish(deps, order, "failed", "chord_auth", thread);
    if (held.failure.kind === "busy") return finish(deps, order, "failed", "thread_busy", thread);
    if (held.failure.kind === "rejected") return finish(deps, order, "failed", held.failure.error, thread);
    return retry(deps, ref, attempt, sleep, held.failure);
  }

  const now = deps.now?.() ?? new Date();
  const today = todaysOrders(deps.db, now);
  const text = renderPaidOrderNotice(order, {
    paidAt: order.paid_at ? new Date(order.paid_at) : now,
    paidCount: today.status === "ok" ? today.paid_count : 0,
    paidTotalNgn: today.status === "ok" ? today.paid_total_ngn : 0,
  });
  const posted = await deps.chord.postMessage(thread.id, text);
  if (!posted.ok) {
    if (!(await handBack(deps.chord, thread.id, ref, sleep))) return stuck(deps, order, thread);
    if (posted.failure.kind === "auth") return finish(deps, order, "failed", "chord_auth", thread);
    if (posted.failure.kind === "rejected") return finish(deps, order, "failed", posted.failure.error, thread);
    return retry(deps, ref, attempt, sleep, posted.failure);
  }
  if (posted.deliveryStatus === "failed") {
    if (!(await handBack(deps.chord, thread.id, ref, sleep))) logStuck(thread, order.ref);
    return finish(deps, order, "failed", posted.deliveryError || "not_delivered", thread, posted.deliveryStatus);
  }

  if (!(await handBack(deps.chord, thread.id, ref, sleep))) return stuck(deps, order, thread);
  finish(deps, order, "sent", null, thread, posted.deliveryStatus);
}

// A busy thread is tried once more after 5s. Giving up does not hand back: we never held it.
async function takeOver(
  chord: ChordClient,
  threadId: string,
  ref: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; failure: ChordFailure }> {
  const first = await chord.takeOver(threadId, ref);
  if (first.ok || first.failure.kind !== "busy") return first;
  await sleep(5_000);
  return chord.takeOver(threadId, ref);
}

// Hand-back is the step that must succeed: a thread left human_active stops the menu teammate.
async function handBack(chord: ChordClient, threadId: string, ref: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const reason = `notification ${ref}`;
  let result = await chord.handBack(threadId, reason);
  for (const wait of HAND_BACK_DELAYS_MS) {
    if (result.ok || result.failure.kind === "auth") break;
    await sleep(wait);
    result = await chord.handBack(threadId, reason);
  }
  if (!result.ok && result.failure.kind === "auth") logStuck({ id: threadId }, ref);
  return result.ok;
}

async function retry(
  deps: AppDeps & { chord: ChordClient },
  ref: string,
  attempt: number,
  sleep: (ms: number) => Promise<void>,
  failure: ChordFailure,
): Promise<void> {
  const wait = JOB_DELAYS_MS[attempt - 1];
  if (wait === undefined) {
    const order = getOrder(deps.db, ref);
    if (order) finish(deps, order, "failed", failure.kind === "auth" ? "chord_auth" : "chord_unavailable");
    return;
  }
  await sleep(wait);
  await runJob(deps, ref, attempt + 1, sleep);
}

function finish(
  deps: AppDeps,
  order: Order,
  status: NonNullable<Order["notify_status"]>,
  error: string | null,
  thread?: OwnerThread,
  delivery?: string,
): void {
  const at = (deps.now?.() ?? new Date()).toISOString();
  deps.db
    .prepare(
      `UPDATE orders SET notify_status = ?, notified_at = ?, notify_thread_id = ?, notify_error = ? WHERE ref = ?`,
    )
    .run(status, at, thread?.id ?? null, error ? error.slice(0, 200) : null, order.ref);
  console.log(
    `[notify] ${order.ref} thread=${thread?.id ?? "-"} participant=${thread?.participantId ?? "-"} delivery=${delivery ?? "-"} status=${status}`,
  );
}

function stuck(deps: AppDeps, order: Order, thread: OwnerThread): void {
  const at = (deps.now?.() ?? new Date()).toISOString();
  // Status stays pending so a restart sends the order again. The thread itself needs a manual hand-back.
  deps.db.prepare("UPDATE orders SET notified_at = ?, notify_thread_id = ?, notify_error = ? WHERE ref = ?").run(
    at,
    thread.id,
    "hand_back_failed",
    order.ref,
  );
  logStuck(thread, order.ref);
}

function logStuck(thread: { id: string }, ref: string): void {
  console.error(`[notify] ERROR owner thread stuck human_active thread=${thread.id} ref=${ref}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
