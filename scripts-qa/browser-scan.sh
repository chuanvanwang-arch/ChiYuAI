#!/usr/bin/env bash
# 全量页面浏览器实测（playwright-cli 单 daemon 连续导航）
# 每页：open → wait load → console 收集 → 快照提取渲染内容 → 汇总
# 用法: bash scripts-qa/browser-scan.sh
set -u
cd "$(dirname "$0")/.." || exit 1
BASE=http://localhost:3000

PAGES="home kanban workbench agent-workbench agent-dashboard agents config business-tier rbac users decision-scenarios approval-flow alert-rules mcp-identities pipeline todo account-360 deal-detail quotation-detail contract-detail order-detail payment-detail particle-detail"

echo "PAGE | console_errors | express_broken | rendered_marker"
for p in $PAGES; do
  # 打开（若默认 daemon 已关则自动开）
  playwright-cli open "$BASE/$p.html" >/dev/null 2>&1
  timeout 8 playwright-cli wait --load load >/dev/null 2>&1
  con=$(playwright-cli console 2>&1)
  errs=$(printf '%s' "$con" | grep -ciE "error|failed" || true)
  expr=$(printf '%s' "$con" | grep -c "Failed to resolve module specifier" || true)
  # 页面快照：取正文可见文本行（text:）
  snap=$(timeout 8 playwright-cli snapshot 2>&1)
  # 渲染标记：有 text: 或 button 或 input 或 table 即认为有内容
  marker=$(printf '%s' "$snap" | grep -oE "text: [^ ]+.{0,28}" | head -3 | tr '\n' '|')
  echo "$p | $errs | $expr | ${marker:-EMPTY}"
done
playwright-cli close >/dev/null 2>&1
true