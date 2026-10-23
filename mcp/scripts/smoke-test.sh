#!/usr/bin/env bash
# Usage: scripts/smoke-test.sh <base-url> <token>
# Note: steps 7, 8 and 13 create real pending_payment orders and a Paystack test-mode transaction.
# That is harmless: unpaid orders never reach the kitchen, and test mode moves no money.
set -euo pipefail
BASE="${1:?base URL, e.g. https://ouida-mcp.eleven-sports.app}"
TOKEN="${2:?MCP token}"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18")

rpc() { curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer $TOKEN" -d "$1"; echo; }
call() { rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"; }

echo "1. Health (no auth):";    curl -sS "$BASE/health"; echo
echo "2. Wrong token (expect 401):"; curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer wrong" -d '{}'
echo "3. Initialize:"
rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}'
echo "4. List tools (expect ping, get_menu, create_order, create_payment_link, verify_payment):"
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

echo "13. create_payment_link for a new order (expect link_ready, paystack_ref ...-1, amount_ngn 3700):"
ORDER=$(call create_order '{"customer_name":"Smoke test","plates":[{"items":[{"item_id":"extra-chicken","qty":1}]}]}' | grep -o 'OU-[A-Z0-9]\{4\}' | head -1)
call create_payment_link "{\"order_ref\":\"$ORDER\"}"
echo "14. create_payment_link again (expect the same link and ...-1):"
call create_payment_link "{\"order_ref\":\"$ORDER\"}"
echo "15. verify_payment before paying (expect payment_not_completed):"
call verify_payment "{\"order_ref\":\"$ORDER\"}"
echo "16. verify_payment for an unknown order (expect order_not_found):"
call verify_payment '{"order_ref":"OU-ZZZZ"}'
echo "17. /paid?cancelled=1 (expect 'Payment cancelled'):"
curl -sS "$BASE/paid?cancelled=1" | grep -o 'Payment cancelled[^<]*' || echo "MISSING"
echo "18. /paid with an unknown reference (expect 'We couldn't find this payment'):"
curl -sS "$BASE/paid?reference=OU-ZZZZ-1" | grep -o "We couldn't find this payment[^<]*" || echo "MISSING"

echo
echo "To finish by hand: open the link from step 13, pay with test card 4084 0840 8408 4081 (CVV 408, any future expiry),"
echo "check the page says 'Payment received', then:"
echo "  scripts/mcp-call.sh $BASE \"\$TOKEN\" verify_payment '{\"order_ref\":\"$ORDER\"}'   # expect already_paid"
