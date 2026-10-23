#!/usr/bin/env bash
# Call one MCP tool by hand.
# Usage: scripts/mcp-call.sh <base-url> <token> <tool> ['<json arguments>']
# e.g.   scripts/mcp-call.sh https://ouida-mcp.eleven-sports.app "$TOKEN" verify_payment '{"order_ref":"OU-7KQ3"}'
set -euo pipefail
BASE="${1:?base URL}"; TOKEN="${2:?MCP token}"; TOOL="${3:?tool name}"; ARGS="${4:-{\}}"
curl -sS -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" -H "Authorization: Bearer $TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"
echo
