#!/usr/bin/env bash
set -euo pipefail
BASE="${1:?base URL, e.g. https://ouida-mcp.eleven-sports.com}"
TOKEN="${2:?MCP token}"
HDRS=(-H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "MCP-Protocol-Version: 2025-06-18")

echo "1. Health (no auth):";    curl -sS "$BASE/health"; echo
echo "2. Wrong token (expect 401):"; curl -sS -o /dev/null -w "%{http_code}\n" -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer wrong" -d '{}'
echo "3. Initialize:"
curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1"}}}'; echo
echo "4. List tools:"
curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; echo
echo "5. Call ping:"
curl -sS -X POST "$BASE/mcp" "${HDRS[@]}" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{}}}'; echo
