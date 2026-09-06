#!/usr/bin/env bash
# 全路由验证（服务器已重启，新代码已生效）
set -u
BASE=http://localhost:3000
echo "=== 5 个 404 页 .html ==="
for p in index decision-graph page-market sales-decision-monitor meta-attr-drawer; do
  printf '%-26s ' "$p.html"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$p.html")
  echo "$code"
done
echo
echo "=== 7 Render 模块 ==="
for m in approvalFlowRender alertRuleConfigRender mcpIdentityRender businessTierRender decisionScenarioRender rbacMatrixRender userManagementRender; do
  printf '%-28s ' "$m.js"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/portal/$m.js")
  echo "$code"
done
echo
echo "=== page.css ==="
curl -s -o /dev/null -w 'page.css %{http_code}\n' "$BASE/portal/page.css"
echo
echo "=== 配置页 ==="
for p in mcp-identities approval-flow alert-rules business-tier decision-scenarios rbac users; do
  printf '%-26s ' "$p.html"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$p.html")
  echo "$code"
done