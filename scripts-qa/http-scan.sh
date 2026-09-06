#!/usr/bin/env bash
# 快速 HTTP 扫描：页面 200 / 模块 200 / 关键资源 200
# 输出每页: URL | HTTP | portal-import-ok | css-ok
set -u
cd "$(dirname "$0")/.." || exit 1
BASE=http://localhost:3000

echo "== 页面 HTTP 状态 =="
for p in home index kanban workbench agent-workbench agent-dashboard agents config business-tier rbac users decision-scenarios decision-graph approval-flow alert-rules mcp-identities pipeline page-market sales-decision-monitor todo account-360 deal-detail quotation-detail contract-detail order-detail payment-detail particle-detail meta-attr-drawer; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$p.html")
  printf "%-26s %s\n" "$p.html" "$code"
done

echo ""
echo "== portal 模块 HTTP 状态（浏览器加载） =="
for m in nav detailSections agentsPage configCenter businessTier rbacMatrix decisionScenario userManagement approvalFlow alertRuleConfig mcpIdentity scoring; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/portal/$m.js")
  printf "%-22s %s\n" "$m.js" "$code"
done

echo ""
echo "== 缺失关键资源 =="
for f in "portal/page.css" "web/sourceClassify.js"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$f")
  printf "%-24s %s\n" "$f" "$code"
done

echo ""
echo "== API 关键端点 =="
for a in "api/mcp-identities" "api/alert-rules" "api/approval-flows" "api/page/contract-detail" "api/particles"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$a")
  printf "%-30s %s\n" "$a" "$code"
done