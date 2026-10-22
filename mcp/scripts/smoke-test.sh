#!/usr/bin/env bash
# Usage: scripts/smoke-test.sh <base-url> <token>
# Note: steps 7 and 8 create real pending_payment orders. That is harmless in v1 (unpaid orders never reach the kitchen).
set -euo pipefail
BASE="${1:?base URL, e.g. https://ouida-mcp.eleven-sports.com}"
TOKEN="${2:?MCP token}"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18")

rpc() { curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer $TOKEN" -d "$1"; echo; }
call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }

echo "1. Health (no auth):";    curl -sS "$BASE/health"; echo
echo "2. Wrong token (expect 401):"; curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer wrong" -d '{}'
echo "3. Initialize:"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}'
echo "4. List tools (expect ping, get_menu, create_order):"
rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo "5. Call ping:"
call ping '{}'
echo "6. get_menu (expect ok, 33 items, plate_fee_ngn 200):"
call get_menu '{}'
echo "7. create_order, Ororo (expect order_created, 2 plates, total_ngn 11400):"
call create_order '{"customer_name":"Ororo","plates":[{"label":"Ororo","items":[{"item_id":"jollof-chicken","qty":1},{"item_id":"dodo","qty":1}]},{"label":"Ada","items":[{"item_id":"rice-pepper-sauce-beef","qty":1},{"item_id":"boiled-egg","qty":1}]}],"drinks":[{"item_id":"zobo-glass","qty":2}]}'
echo "8. create_order, Ade (expect order_created, 3 plates, total_ngn 11100):"
call create_order '{"customer_name":"Ade","plates":[{"items":[{"item_id":"dundu-egg-sauce","qty":1}]},{"items":[{"item_id":"dundu-egg-sauce","qty":1}]},{"items":[{"item_id":"dundu-egg-sauce","qty":1}]}],"drinks":[{"item_id":"water-small","qty":3}]}'
echo "9. create_order with fried-rice (expect item_not_found):"
call create_order '{"customer_name":"Ade","plates":[{"items":[{"item_id":"fried-rice","qty":1}]}]}'
echo "10. create_order with water on a plate (expect wrong_section):"
call create_order '{"customer_name":"Ade","plates":[{"items":[{"item_id":"water-small","qty":1}]}]}'
echo "11. create_order with qty 0 (expect invalid_order):"
call create_order '{"customer_name":"Ade","plates":[{"items":[{"item_id":"dodo","qty":0}]}]}'
echo "12. create_order with nothing (expect empty_order):"
call create_order '{"customer_name":"Ade"}'
