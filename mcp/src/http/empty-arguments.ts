import type { RequestHandler } from "express";
import type { AppDeps } from "../deps.js";
import { DUPLICATE_WINDOW_MS, listRecentOrders, type RecentOrder } from "../domain/orders.js";

const TOOLS = new Set(["create_order", "create_payment_link", "verify_payment"]);

// Some agent turns start with a tool call that has no arguments ({}), then a second call that has
// them. Answering the first one as a schema error makes the agent tell the customer the order is
// broken. Answer it as a normal result that names the next tool, and say nothing the customer
// should hear. When this café has exactly one recent order, name it so the agent doesn't have to
// reconstruct the reference.
export function retryOnEmptyArguments(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const body = req.body;
    if (body?.method !== "tools/call") return next();
    const tool: unknown = body.params?.name;
    const args: unknown = body.params?.arguments;
    const empty =
      args === undefined || args === null || (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
    if (!empty || typeof tool !== "string" || !TOOLS.has(tool)) return next();

    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
    const recent = listRecentOrders(deps.db, since);
    const order = recent.length === 1 ? recent[0] : undefined;
    const payload = emptyCallResult(tool, order);

    console.warn(
      `[mcp] ${tool} had no arguments (${args === undefined ? "missing" : "empty"})` +
        (order ? `; only recent order is ${order.ref} (${order.status})` : recent.length > 1 ? `; ${recent.length} recent orders` : ""),
    );
    res.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    });
  };
}

function emptyCallResult(tool: string, order: RecentOrder | undefined) {
  const order_ref = order?.ref;
  const where = order_ref
    ? `order_ref ${order_ref}`
    : "the OU-XXXX from the receipt already in this chat";

  let next_step: string;
  if (tool === "verify_payment") {
    next_step =
      `Say nothing to the customer yet. Call verify_payment now with ${where}. ` +
      `Then send only its message_text, as the entire reply.`;
  } else if (tool === "create_payment_link") {
    next_step =
      `Say nothing to the customer yet. Call create_payment_link now with ${where}. ` +
      `Then send only its message_text, as the entire reply.`;
  } else if (order?.status === "paid" && order_ref) {
    next_step =
      `Say nothing to the customer yet. Order ${order_ref} is already paid. ` +
      `If their latest message is paid or about payment, call verify_payment now with order_ref ${order_ref} and send only its message_text, as the entire reply. ` +
      `If they are ordering new food, call create_order with customer_name, plates and drinks. Do not call get_menu.`;
  } else if (order?.status === "pending_payment" && order_ref) {
    next_step =
      `Say nothing to the customer yet. Order ${order_ref} is already saved. ` +
      `If their latest message is yes, call create_payment_link with order_ref ${order_ref} and send only its message_text, as the entire reply. ` +
      `If their latest message is paid, call verify_payment with order_ref ${order_ref} and send only its message_text, as the entire reply. ` +
      `If they changed the order, call create_order with the full new arguments. Do not call get_menu.`;
  } else {
    next_step =
      `Say nothing to the customer yet. ` +
      `If their latest message is paid, call verify_payment with ${where} and send only its message_text, as the entire reply. ` +
      `If their latest message is yes, call create_payment_link with ${where} and send only its message_text, as the entire reply. ` +
      `If they are placing or changing an order, call create_order with customer_name, plates and drinks.`;
  }

  return {
    status: "ignored_empty_call" as const,
    say_nothing_to_customer: true,
    ...(order_ref ? { order_ref } : {}),
    next_step,
  };
}
