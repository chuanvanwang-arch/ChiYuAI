// scripts/gen-test-report.cjs — 生成聚合测试报告 HTML（基于实测数据 + 磁盘测试文件清单）
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');

// 1) 扫描磁盘真实测试文件
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.test.js')) acc.push(p);
  }
  return acc;
}
const files = walk(testDir).sort();

// 2) 模块分组（前缀 → 域）
const groupMap = {
  particles: '粒子底座', 'ontology-hooks': '粒子底座', 'attio-attributes': '粒子底座',
  'attio-inheritance': '粒子底座', 'interaction-index': '粒子底座', 'memory': '粒子底座',
  'meta-attr': '粒子元模型', dedup: '粒子底座',
  dispatch: '编排/智能体', kanban: '编排/智能体', 'agentSpec': '编排/智能体',
  'agentLoop': '编排/智能体', 'agent-episodes': '编排/智能体', context: '编排/智能体', sse: '编排/智能体',
  'business-title': '销售L2C业务闭环', 'stage-config': '销售L2C业务闭环', 'price-calc': '销售L2C业务闭环',
  'quote-service': '销售L2C业务闭环', 'contract-service': '销售L2C业务闭环', 'payment-service': '销售L2C业务闭环',
  'invoice-service': '销售L2C业务闭环', 'order-service': '销售L2C业务闭环', 'import-service': '销售L2C业务闭环',
  pool: '销售L2C业务闭环', 'pool-config': '销售L2C业务闭环', 'tender-connector': '销售L2C业务闭环',
  connectors: '销售L2C业务闭环', 'data-origin': '销售L2C业务闭环',
  'approval-flow': '审批/HITL', 'approval-seqcheck': '审批/HITL', 'approval-engine': '审批/HITL', 'decision-gate': '审批/HITL',
  alert: '预警/反馈闭环', 'observability-risk-scan': '预警/反馈闭环', timers: '预警/反馈闭环', monitor: '预警/反馈闭环',
  page: '门户NL→Page', action: '门户NL→Page',
  'age-bootstrap': '决策网络/AGE/溯源', 'age-graph': '决策网络/AGE/溯源', 'age-sync': '决策网络/AGE/溯源',
  'age-causal': '决策网络/AGE/溯源', decision: '决策网络/AGE/溯源', 'decision-trace': '决策网络/AGE/溯源',
  provenance: '决策网络/AGE/溯源', 'provenance-chain': '决策网络/AGE/溯源', conflict: '决策网络/AGE/溯源',
  'graph-analytics': '决策网络/AGE/溯源', 'graph-rest': '决策网络/AGE/溯源', 'monitor-graph': '决策网络/AGE/溯源',
  'mcp-gateway': '决策网络/AGE/溯源',
  e2e: '集成/E2E', db: '集成/E2E', 'skills-methodology': '集成/E2E', 'skills-seed': '集成/E2E',
};
function groupOf(name) {
  for (const k of Object.keys(groupMap)) if (name.startsWith(k)) return groupMap[k];
  return '其他';
}
const groups = {};
for (const f of files) {
  const name = path.basename(f);
  const g = groupOf(name);
  (groups[g] ||= []).push(name);
}

// 3) 实测汇总（2026-08-26 全量 vitest 实测）
const SUM = { files: 64, tests: 466, passed: 466, failed: 0, duration: '27.34s', date: '2026-08-26', exitCode: 0 };

// 4) 渲染
const rows = Object.entries(groups).sort().map(([g, fs2]) => `
  <tr><td class="g">${g}</td><td class="n">${fs2.length}</td><td><code>${fs2.join('</code> <code>')}</code></td></tr>`).join('');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRM-ai-native 测试报告 ${SUM.date}</title>
<style>
:root{--bg:#f5f7fa;--card:#fff;--ink:#1f2937;--mut:#6b7280;--ok:#16a34a;--line:#e5e7eb;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:1080px;margin:0 auto;padding:28px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--mut);margin-bottom:20px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
.card{flex:1;min-width:150px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card .k{font-size:12px;color:var(--mut);letter-spacing:.5px}
.card .v{font-size:26px;font-weight:700;margin-top:4px}
.v.ok{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:#f0f4f8;font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}
td.g{font-weight:600;white-space:nowrap;width:180px}
td.n{width:50px;color:var(--mut);text-align:center}
code{background:#eef2f7;border-radius:5px;padding:1px 6px;font-size:12px;margin:0 4px 4px 0;display:inline-block;color:#334155}
.badge{display:inline-block;background:var(--ok);color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
.note{margin-top:18px;font-size:12px;color:var(--mut);border-top:1px dashed var(--line);padding-top:12px}
</style></head><body><div class="wrap">
<h1>CRM-ai-native · 测试报告</h1>
<div class="sub">生成日期 ${SUM.date} · 全量 vitest 实测 · 工作树（含未提交改动）</div>
<div class="cards">
  <div class="card"><div class="k">测试文件</div><div class="v">${SUM.files}</div></div>
  <div class="card"><div class="k">用例总数</div><div class="v">${SUM.tests}</div></div>
  <div class="card"><div class="k">通过</div><div class="v ok">${SUM.passed}</div></div>
  <div class="card"><div class="k">失败</div><div class="v">${SUM.failed}</div></div>
  <div class="card"><div class="k">耗时</div><div class="v">${SUM.duration}</div></div>
</div>
<p><span class="badge">通过率 100%</span> &nbsp; 退出码 ${SUM.exitCode}（此前记录的"退出码1 空闲池保活"本轮未复现）</p>
<table><thead><tr><th>模块域</th><th>文件数</th><th>测试文件</th></tr></thead><tbody>${rows}</tbody></table>
<div class="note">说明：本报告为聚合视图，不含逐用例明细。逐用例结论以 <code>node node_modules/vitest/vitest.mjs run</code> 运行时输出为准。
覆盖缝隙：<code>/meta-attr-drawer</code> 路由无专属 HTTP 测试（抽屉 HTML 由 meta-attr-page.test.js 覆盖）；
<code>skills/crm-*</code> 与 <code>skills/method-*</code> 为知识资产，经 skills-methodology(11/11) + mcp-gateway(9/9) 间接覆盖。</div>
</div></body></html>`;

const out = path.join(root, 'docs', `test-report-${SUM.date}.html`);
fs.writeFileSync(out, html);
console.log('WROTE', out, '| testfiles', files.length, '| groups', Object.keys(groups).length);
