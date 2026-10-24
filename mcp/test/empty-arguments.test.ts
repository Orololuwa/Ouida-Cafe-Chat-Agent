import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/http/app.js";
import { makeDeps } from "./helpers.js";

const TOKEN = "t".repeat(32);
let server: Server;
let base = "";

before(async () => {
  server = createApp(makeDeps(), { mcpToken: TOKEN }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(name: string, args: unknown) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { id: number; result: { isError?: boolean; content: { text: string }[] } };
}

test("A call that arrives with no arguments gets a plain instruction to call again", async () => {
  for (const args of [{}, undefined, null]) {
    const r = await call("create_payment_link", args);
    assert.equal(r.id, 7);
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /arrived with no arguments.*not a problem with the order.*Call create_payment_link again now with order_ref/s);
  }
  assert.match((await call("create_order", {})).result.content[0].text, /don.t create the order again.*call create_payment_link now.*Otherwise call create_order again now with customer_name/s);
  assert.match((await call("verify_payment", {})).result.content[0].text, /Call verify_payment again now with order_ref/);
});

test("Tools without arguments, and calls with arguments, are not intercepted", async () => {
  const menu = await call("get_menu", {});
  assert.ok(!menu.result.isError);
  assert.equal(JSON.parse(menu.result.content[0].text).status, "ok");
  const notFound = await call("verify_payment", { order_ref: "OU-ZZZZ" });
  assert.equal(JSON.parse(notFound.result.content[0].text).status, "order_not_found");
});
