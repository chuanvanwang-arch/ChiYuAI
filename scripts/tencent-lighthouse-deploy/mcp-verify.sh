#!/usr/bin/env bash
# MCP 生产通道验收：V3(tools/list) + V5(crm_login 握手) + V6(只读工具返回生产库数据)
#
# 用法（在任意有 curl 的机器上执行）：
#   bash mcp-verify.sh <BASIC_USER> <BASIC_PASS> <CRM_USER> <CRM_PASS> [URL]
# 例：
#   bash mcp-verify.sh crm-mcp '<网关密码>' admin '<CRM密码>' http://81.70.184.198/mcp
set -u
BU="${1:?参数1: Basic 用户名}"
BP="${2:?参数2: Basic 密码}"
CU="${3:?参数3: CRM 用户名}"
CP="${4:?参数4: CRM 密码}"
URL="${5:-http://81.70.184.198/mcp}"

CT='Content-Type: application/json'
ACC='Accept: application/json, text/event-stream'

# SSE 响应形如 "event: message\ndata: {...}"，取 data 行
extract_data() { sed -n 's/^data: //p'; }

post() {  # $1=payload  $2=session(可空)
  local payload="$1" sid="${2:-}"
  local hdrs=(-H "$CT" -H "$ACC")
  if [ -n "$sid" ]; then hdrs+=(-H "mcp-session-id: $sid"); fi
  curl -s -u "$BU:$BP" -X POST "$URL" "${hdrs[@]}" -d "$payload" -m 30
}

echo "=== [1] initialize ==="
# 注意：Mcp-Session-Id 在**响应头**中，必须用 -D - 让 curl 把头也输出到 stdout，
# 否则只能拿到 SSE 响应体、永远提取不到 session（实测踩坑）。
INIT_RAW=$(curl -s -D - -u "$BU:$BP" -X POST "$URL" -H "$CT" -H "$ACC" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' -m 30)
SID=$(printf '%s\n' "$INIT_RAW" | grep -i '^mcp-session-id' | head -1 | tr -d '\r' | awk '{print $2}')
echo "SessionId: ${SID:-（未取得，后续调用会失败）}"
printf '%s\n' "$INIT_RAW" | extract_data | head -c 300; echo

if [ -z "${SID:-}" ]; then echo "✗ 未取得 SessionId，终止。"; exit 1; fi

echo ""
echo "=== [2] notifications/initialized ==="
post '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$SID" >/dev/null 2>&1 && echo "sent"

echo ""
echo "=== [3] V3 tools/list ==="
TOOLS=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$SID" | extract_data)
N=$(printf '%s' "$TOOLS" | grep -o '"name":' | wc -l | tr -d ' ')
echo "工具总数: $N"
printf '%s' "$TOOLS" | tr ',' '\n' | grep -o '"name":"[^"]*"' | head -12
printf '%s' "$TOOLS" | grep -q 'crm_login' && echo "✓ 含 crm_login" || echo "✗ 缺 crm_login"

echo ""
echo "=== [4] V5 crm_login 握手 ==="
LOGIN=$(post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"crm_login\",\"arguments\":{\"username\":\"$CU\",\"password\":\"$CP\"}}}" "$SID" | extract_data)
echo "$LOGIN" | head -c 600; echo

echo ""
echo "=== [5] V6 只读工具 data-particle-read（应返回生产库数据）==="
# 关键：crm_login 的 token 必须在后续调用的 arguments.api_token 中携带，
# 否则工具返回 gate=auth_required（实测踩坑）。
TOKEN=$(printf '%s' "$LOGIN" | sed 's/\\"/"/g' | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "token: ${TOKEN:+已取得(${#TOKEN} 字符)}${TOKEN:-（未取得）}"
READ=$(post "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"data-particle-read\",\"arguments\":{\"type\":\"CRM_DEAL\",\"api_token\":\"$TOKEN\"}}}" "$SID" | extract_data)
echo "$READ" | head -c 600; echo
