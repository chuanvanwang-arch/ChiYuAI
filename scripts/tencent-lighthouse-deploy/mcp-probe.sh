#!/usr/bin/env bash
# MCP 通道探测（在服务器上执行）：验证 StreamableHTTP /mcp 是否可用
# 用法: bash mcp-probe.sh [URL]   默认 http://127.0.0.1/mcp
set -u
URL="${1:-http://127.0.0.1/mcp}"

echo "=== 1) POST initialize ==="
RESP=$(curl -s -D /tmp/mcp_headers.txt -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
  -m 20)
echo "--- 响应头 ---"
cat /tmp/mcp_headers.txt | head -15
echo "--- 响应体（前 600 字符）---"
echo "$RESP" | head -c 600
echo ""

SID=$(grep -i '^mcp-session-id:' /tmp/mcp_headers.txt | tr -d '\r' | awk '{print $2}')
echo "--- 提取 Mcp-Session-Id: ${SID:-（无）} ---"

if [ -n "${SID:-}" ]; then
  echo ""
  echo "=== 2) POST notifications/initialized ==="
  curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -m 15

  echo ""
  echo "=== 3) POST tools/list ==="
  curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' -m 20 \
    | head -c 400
  echo ""
else
  echo "⚠ 未拿到 Mcp-Session-Id，无法继续会话级探测"
fi
