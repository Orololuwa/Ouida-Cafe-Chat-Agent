import type { Order, OrderLine } from "./types.js";

// 11400 -> "₦11,400". Done by hand so it never depends on the runtime's ICU data.
export function formatNaira(amount: number): string {
  return `₦${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// Put on every tool result that carries words for the customer. The model reads this
// in the same turn it writes the reply, which is what stops the apology paragraph.
export const SEND_MESSAGE =
  "message_text is the entire reply. Send it unchanged. Do not apologise, do not mention any other order, and do not add a sentence before or after it.";

export function sendReceipt(name: string): string {
  return `Send receipt_text exactly, then ask only this: Is that right, ${name}? Reply yes and I'll send your payment link. Do not mention any earlier order and do not apologise.`;
}

// What the customer sees once Paystack has confirmed the exact amount.
export function paymentConfirmedText(order: Pick<Order, "ref" | "customer_name">): string {
  return `Payment received ✅\nOrder *${order.ref}* for ${order.customer_name} is confirmed.\nShow this reference when you collect it.`;
}

function line(l: OrderLine): string {
  const name = l.note ? `${l.name} (${l.note})` : l.name;
  return `• ${l.qty}× ${name} — ${formatNaira(l.line_total_ngn)}`;
}

// The WhatsApp receipt the agent sends as written. *single asterisks* are WhatsApp bold.
export function renderReceipt(order: Order): string {
  const plates = order.plate_count === 1 ? "1 plate" : `${order.plate_count} plates`;
  const out: string[] = [
    order.plate_count > 0
      ? `*Order ${order.ref} for ${order.customer_name}, ${plates}*`
      : `*Order ${order.ref} for ${order.customer_name}*`,
  ];

  order.plates.forEach((plate, i) => {
    out.push(plate.label ? `*Plate ${i + 1} (${plate.label})*` : `*Plate ${i + 1}*`);
    for (const l of plate.lines) out.push(line(l));
  });

  if (order.drinks.length > 0) {
    out.push("*Drinks*");
    for (const l of order.drinks) out.push(line(l));
  }

  if (order.plate_count > 0) {
    out.push(
      `Plates: ${order.plate_count} × ${formatNaira(order.plate_fee_ngn)} — ${formatNaira(order.plate_count * order.plate_fee_ngn)}`,
    );
  }
  out.push(`*Total: ${formatNaira(order.total_ngn)}*`);
  return out.join("\n");
}
