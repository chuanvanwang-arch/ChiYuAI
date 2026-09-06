#!/usr/bin/env bash
# 全量页面浏览器探测：逐页 open → wait → console 收集 → 判断渲染
# 用法: bash scripts-qa/probe-pages.sh
set -u
cd "$(dirname "$0")/.." || exit 1

PAGES="home index kanban workbench agent-workbench agent-dashboard agents config business-tier rbac users decision-scenarios decision-graph approval-flow alert-rules mcp-identities pipeline page-market sales-decision-monitor todo account-360 deal-detail quotation-detail contract-detail order-detail payment-detail particle-detail meta-attr-drawer"

echo "PAGE | HTTP | console_errors | express_broken | rendered"
for p in $PAGES; do
  url="http://localhost:3000/$p.html"
  http=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  playwright-cli open "$url" >/dev/null 2>&1
  playwright-cli wait --load networkidle >/dev/null 2>&1
  con=$(playwright-cli console 2>&1)
  errs=$(printf '%s' "$con" | grep -ciE "error|failed" || true)
  expr=$(printf '%s' "$con" | grep -ciE "Failed to resolve module specifier \"express\"" || true)
  # 判断是否渲染出内容：取 body 下第一个有文本的 main/div
  snap=$(playwright-cli snapshot 2>&1)
  has_content=$(printf '%s' "$snap" | grep -ciE "text:|button|input|table|加载中|共 " || true)
  echo "$p | $http | $errs | $expr | $has_content"
done