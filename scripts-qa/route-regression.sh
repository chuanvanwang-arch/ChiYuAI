#!/usr/bin/env bash
# 全量路由回归验证（重启服务后）
set -u
cd /d/system/CRM-ai-native || exit 1
# 重启服务器
taskkill //F //IM node.exe >/dev/null 2>&1 || true
sleep 1
(nohup node src/http/server.js > /tmp/crm-server3.log 2>&1 &)
sleep 2

echo "=== 5 个 404 页 .html 路由 ==="
for p in index decision-graph page-market sales-decision-monitor meta-attr-drawer; do
  printf '%-25s ' "$p.html"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/$p.html")
  echo "$code"
done

echo
echo "=== 7 个 Render 子模块路由 ==="
for m in approvalFlowRender alertRuleConfigRender mcpIdentityRender businessTierRender decisionScenarioRender rbacMatrixRender userManagementRender; do
  printf '%-26s ' "$m.js"
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/portal/$m.js")
  echo "$code"
done

echo
echo "=== page.css ==="
curl -s -o /dev/null -w 'page.css %{http_code}\n' http://localhost:3000/portal/page.css

echo
echo "=== 关键 API（PG 未启则 500，代码无关） ==="
for a in api/mcp-identities api/page-market; do
  printf '%-22s ' "$a"
  curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3000/$a"
done