// scripts/verify-sales-menu-order.mjs — 运行期取证：侧栏「销售」组真实渲染次序 + 显示名（2026-09-18 用户指定）
// 只读，不改数据。断言对象 = navHtml 输出的真实 HTML（非 FULL_MENU 数组），可捕获中间层重排。
// 2026-09-18 二次裁定（两个改名）后：显示名也进断言 —— 只断言 href 的探针**看不见改名**。
import { navHtml } from '../src/web/layout.js';

const EXPECT = ['/discovery.html', '/lead-pool.html', '/pipeline.html', '/named-accounts.html', '/sales-behavior-board.html'];
// 期望显示名（顺序同 EXPECT）：与 src/portal/layoutMenu.js 的 label 逐字一致
const EXPECT_LABELS = ['线索发现', '公海池', '销售管道', '客户跟踪', '销售过程看板'];

function salesSegment(role, ents) {
  const html = navHtml(role, {}, ents);
  const m = html.match(/<div class="nav-group"><div class="nav-group-title">销售<\/div>([\s\S]*?)<\/div>/);
  const seg = m ? m[1] : '';
  return {
    labels: [...seg.matchAll(/<span class="nav-label">([^<]+)<\/span>/g)].map((x) => x[1]),
    hrefs: [...seg.matchAll(/href="([^"]+)"/g)].map((x) => x[1]),
  };
}

const FULL = new Set(['core_crm', 'customer_360', 'decision_autonomy', 'ai_agents']);
const cases = [
  ['sales / 权益全开', 'sales', FULL, EXPECT, EXPECT_LABELS],
  ['manager / 权益全开', 'manager', FULL, EXPECT, EXPECT_LABELS],
  // 无 customer_360 → 客户跟踪被裁剪，其余四项相对次序与显示名必须保持不变
  ['sales / 仅 core_crm', 'sales', new Set(['core_crm']),
    EXPECT.filter((h) => h !== '/named-accounts.html'),
    EXPECT_LABELS.filter((l) => l !== '客户跟踪')],
  ['sales / 权益入参 null', 'sales', null, EXPECT, EXPECT_LABELS],
];

let allPass = true;
for (const [name, role, ents, expect, expectLabels] of cases) {
  const { labels, hrefs } = salesSegment(role, ents);
  const okHref = JSON.stringify(hrefs) === JSON.stringify(expect);
  const okLabel = JSON.stringify(labels) === JSON.stringify(expectLabels);
  allPass = allPass && okHref && okLabel;
  console.log(`\n[${name}]`);
  hrefs.forEach((h, i) => console.log(`  ${i + 1}. ${labels[i]}  →  ${h}`));
  console.log(`  次序: ${okHref ? 'PASS' : 'FAIL'}  期望 ${expect.join(' → ')}`);
  console.log(`  显示名: ${okLabel ? 'PASS' : 'FAIL'}  期望 ${expectLabels.join(' → ')}`);
}
console.log(`\n总判定: ${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
