import type { Order, OrderLine } from "./types.js";

// 11400 -> "₦11,400". Done by hand so it never depends on the runtime's ICU data.
export function formatNaira(amount: number): string {
  return `₦${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
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
