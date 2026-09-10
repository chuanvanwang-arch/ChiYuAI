# K 页重做（知识原料看板）实施计划

- 设计文档：docs/2026-09-10-system-overview-k-redesign-design.md（契约 valid:true，已批准：作用域=租户默认+admin可切全租户；主面板=四源并列看板 A）
- 范式：概览页=看板（状态+趋势+四源面板），点面板/行 data-dk 下钻；与 M（图）、D（阶段卡）形态差异化。
- 契约：5 任务均 agent=decision-retro / contract_task_id=ct-retro-decision（继承设计文档）。

## 背景：真实 K = 决策原料库（四源，非 SKILL 治理）

| 源 | 位置 | 查询 |
|---|---|---|
| ① 知识粒子 | `crm.particles WHERE type='CRM_KNOWLEDGE'`（particleModel.js:78-92） | `queryParticles({type:'CRM_KNOWLEDGE',tenantId,excludeStates})` |
| ② 来源边 | `crm.edges` sourcedFrom → KNOWLEDGE（connectorActions.js:41,85；lifecycle.js:36） | 新增 `countEdgesToKnowledge`（轻量计数） |
| ③ L-Knowledge 注入 | `knowledge-injection-map` 配置 + scenario→kind 命中（assembler.js:195） | `readConfig('knowledge-injection-map')` + 粒子 kind 命中计数 |
| ④ 历史先例 | `crm.decision_precedent_rel` REFERENCED_PRECEDENT（ageGraph.js:232-246；searchPrecedents） | `decision_precedent_rel` 按 precedent_id 聚合 Top-N |

- `queryParticles` 已原生支持 `tenantId:'*'` 跨租户通配（particleRepo.js:177-191）——admin 开关直接传 `'*'`。
- 采样器 `scripts/sample-system-overview.mjs` 现写 `k_method_skill`（偏离语义）→ **改 `k_knowledge_count`**（scope 内 CRM_KNOWLEDGE 粒子数；全租户额外写 `tenant_id:'*'` 聚合行）。

## File Structure

- 改 `src/http/render/systemOverviewK.js`：四源看板重写（顶部状态 → 趋势 → 四源面板 → 下钻），方法 SKILL 治理降级角落小卡。
- 改 `scripts/sample-system-overview.mjs`：`computeMetrics` 加 `k_knowledge_count`；`sampleAll` 补 `'*'` 聚合行。
- 新增轻量查询 `countEdgesToKnowledge`（建议放 `src/http/render/systemOverviewK.js` 内，仅本页使用）。
- 改 `src/http/routes.js`：admin 全租户开关传参（读取 `?scope=all` → `tenantId:'*'`）。
- 改 `test/http/system-overview-pages.test.js`：K 四源结构断言（既有 25 测保留，新增）。
- 保留：shell 页 `src/web/system-overview-k.html` 与 `/api/page/system-overview-k` 路由不变。

## T1 — 数据层：四源查询（含 `countEdgesToKnowledge` + `queryKnowledgeBuckets`）

**文件：** 改 `src/http/render/systemOverviewK.js`（新增查询函数）

- [ ] **Step 1: 写失败测试**（临时冒烟脚本，非正式测试——渲染器数据函数）

```js
// scripts/tmp-k-smoke.mjs（临时，跑完即删）
process.env.PGDATABASE = 'crm_native';
const { renderKnowledge } = await import('../src/http/render/systemOverviewK.js');
const r = await renderKnowledge({ me: { role: 'admin', tenantId: '*' } });
const html = r.html || '';
const required = ['knowledge-particles', 'source-edges', 'injection-coverage', 'precedent-graph'];
for (const k of required) console.log(html.includes(k) ? `OK ${k}` : `FAIL ${k}`);
```

- [ ] **Step 2: 跑冒烟确认失败**（新函数未实现，渲染缺段名）

Run: `node scripts/tmp-k-smoke.mjs` → FAIL（含知识原料四源段）

- [ ] **Step 3: 添加查询函数**

在 `systemOverviewK.js` 顶部 imports 区追加：

```js
import { query } from '../../db.js';
import { queryParticles } from '../../particles/particleRepo.js';
import { readConfig } from '../../configStore.js';
```

新增三函数（放 `safeSkew` 附近）：

```js
// ① 知识粒子按 kind 分桶（scope: tenantId 或 '*'）
async function queryKnowledgeBuckets(tenantId = 'system') {
  try {
    const parts = await queryParticles({
      type: 'CRM_KNOWLEDGE',
      tenantId,
      limit: 2000,
      excludeStates: ['deprecated'],
    });
    const buckets = {};
    let total = 0;
    for (const p of parts || []) {
      const kind = p.payload?.kind || '未分类';
      buckets[kind] = (buckets[kind] || 0) + 1;
      total++;
    }
    return { total, buckets };
  } catch { return { total: 0, buckets: {} }; }
}

// ② 来源边计数：edges → target_type='CRM_KNOWLEDGE'（scope）
async function countEdgesToKnowledge(tenantId = 'system') {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM crm.edges
       WHERE target_type='CRM_KNOWLEDGE'
         AND ($1::text IS NULL OR tenant_id=$1)`,
      [tenantId === '*' ? null : tenantId]
    );
    return Number(r.rows?.[0]?.n ?? 0);
  } catch { return 0; }
}

// ③ L-Knowledge 注入覆盖：读配置 + 各 scenario 命中知识条目数
async function injectionCoverage(tenantId = 'system') {
  try {
    const cfg = await readConfig('knowledge-injection-map', { tenantId: tenantId === '*' ? 'system' : tenantId })
      .catch(() => null);
    const map = cfg?.value || {};
    const kinds = new Set(Object.values(map).flat());
    const parts = await queryParticles({
      type: 'CRM_KNOWLEDGE',
      tenantId,
      limit: 5000,
      excludeStates: ['deprecated'],
    });
    let injected = 0;
    for (const p of parts || []) {
      const kind = p.payload?.kind;
      if (kind && kinds.has(kind)) injected++;
    }
    return { scenarios: Object.keys(map).length, injected };
  } catch { return { scenarios: 0, injected: 0 }; }
}

// ④ 历史先例被引用 Top-N（decision_precedent_rel 聚合）
async function precedentTop(tenantId = 'system', limit = 8) {
  try {
    const r = await query(
      `SELECT r.precedent_id, COUNT(*)::int AS refs
       FROM crm.decision_precedent_rel r
       LEFT JOIN crm.decision d ON d.decision_id = r.precedent_id
       WHERE ($1::text IS NULL OR COALESCE(d.tenant_id, 'system') = $1)
       GROUP BY 1 ORDER BY refs DESC LIMIT $2`,
      [tenantId === '*' ? null : tenantId, limit]
    );
    return r.rows || [];
  } catch { return []; }
}
```

- [ ] **Step 4: 跑冒烟确认数据非空**

Run: `node scripts/tmp-k-smoke.mjs` → 四源计数 > 0（真实库）

## T2 — 采样器：`k_knowledge_count` + `'*'` 聚合行

**文件：** 改 `scripts/sample-system-overview.mjs`

- [ ] **Step 1: 写失败测试**（临时 verify 脚本）

```js
// scripts/tmp-k-sampler.mjs（临时）
process.env.PGDATABASE = 'crm_native';
const { computeMetrics } = await import('../scripts/sample-system-overview.mjs');
const m = await computeMetrics('system', {});
console.log('has k_knowledge_count:', m.some((x) => x.metric === 'k_knowledge_count'));
```

- [ ] **Step 2: 跑确认失败**（computeMetrics 尚无 k_knowledge_count）

- [ ] **Step 3: 实现**

`computeMetrics` 内加（在 `const skills = ...` 后）：

```js
  // 知识粒子数（scope 内，全租户聚合单独处理）
  const kRes = await q(
    `SELECT COUNT(*)::int AS n FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND tenant_id=$1 AND state='registered'`,
    [tenantId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const kCount = Number(kRes.rows?.[0]?.n ?? 0);
```

返回数组追加：

```js
    { metric: 'k_knowledge_count', value: kCount },
```

`sampleAll` 补 `'*'` 聚合行（在 for 循环后）：

```js
  // 全租户聚合行（admin 全租户开关读取）
  const allRes = await q(
    `SELECT COUNT(*)::int AS n FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND state='registered'`
  ).catch(() => ({ rows: [{ n: 0 }] }));
  await qw(
    `INSERT INTO crm.system_overview_sample (tenant_id, sample_date, metric, value)
     VALUES ('*', $1, 'k_knowledge_count', $2)
     ON CONFLICT (tenant_id, sample_date, metric) DO UPDATE SET value = EXCLUDED.value`,
    [today, Number(allRes.rows?.[0]?.n ?? 0)]
  );
```

- [ ] **Step 4: 跑确认通过**

Run: `node scripts/tmp-k-sampler.mjs` → has k_knowledge_count: true

## T3 — 渲染层：四源看板重写

**文件：** 改 `src/http/render/systemOverviewK.js`（renderKnowledge 重写 + 样式 + 下钻）

- [ ] **Step 1: 替换 renderKnowledge 主体**（保留 `renderTopState` 但数据源改为四源）

在 `export async function renderKnowledge({ deps } = {})` 内替换数据获取与 html：

```js
export async function renderKnowledge({ me, deps } = {}) {
  // admin 且 scope=all → '*'（全租户通配）；否则默认租户（me.tenantId || 'system'）
  const effective = (['admin', 'sysadmin'].includes(me?.role) && me?.scope === 'all')
    ? '*' : (me?.tenantId || 'system');
  const [buckets, edges, inject, precedents, kVals] = await Promise.all([
    queryKnowledgeBuckets(effective),
    countEdgesToKnowledge(effective),
    injectionCoverage(effective),
    precedentTop(effective),
    getTrendSamples('k_knowledge_count', { tenantId: effective, deps }),
  ]);
  const { html: tableHtml, details } = renderFourPanels(buckets, edges, inject, precedents);
  // ...html 拼接：状态条 + 趋势 + 四源面板 + 角落治理小卡
  const html = [
    style,
    '<section class="pg-section so-k-top">', renderFourState(buckets, edges, inject, precedents), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日知识粒子趋势</h3>', renderTrendSvg(kVals), '</section>',
    '<section class="pg-section so-k-panels-sec"><h3>知识原料四源</h3>', tableHtml, details, '</section>',
    '<section class="pg-section so-k-govern"><h4>治理角落：方法 SKILL 装配健康度</h4><p>注册 <b>N</b>（启用 <b>M</b>）· 维度一致 <b>K/N</b> → <a href="/skills.html" target="_blank">去配置页</a></p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-k', scope: effective }, data: { ... }, html };
}
```

`renderFourPanels` 产出四个面板块（`knowledge-particles` / `source-edges` / `injection-coverage` / `precedent-graph`），每个数据-dk 可下钻：

```js
function renderFourPanels(buckets, edges, inject, precedents) {
  const panel1 = `<div class="so-k-panel" data-dk="knowledge-particles" data-drill-title="知识粒子库">
    <div class="so-k-panel-h">① 知识粒子库</div>
    <div class="so-k-panel-v">${buckets.total}</div>
    <div class="so-k-panel-s">${Object.entries(buckets.buckets).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || '暂无'}</div>
  </div>`;
  // panel2=来源边溯源(edges)、panel3=L-Knowledge 注入覆盖(inject)、panel4=历史先例图(precedents)
  // 各 panel 下钻内容同 data-dk 隐藏块：粒子清单 / 边明细 / 注入 scenario 命中 / 先例 Top-N
}
```

- [ ] **Step 2: 样式**（`.so-k-panels` 网格 4 列，复用 `.so-pillar` 视觉）

- [ ] **Step 3: 角落治理**（方法 SKILL 装配健康度小卡，保留链接 `/skills.html`）

## T4 — 路由/开关：admin 全租户

**文件：** 改 `src/http/routes.js`（`/api/page/system-overview-k` handler）

- [ ] **Step 1: 传 me + scope**（若 handler 未传 me 则改）

在 `/api/page/system-overview-k` 端点调用 `renderKnowledge` 处：

```js
// 读取 query scope（admin 才生效）
const scope = req.query?.scope || null;
const r = await renderKnowledge({
  me: { role: ctx.user?.role, tenantId: ctx.user?.tenant_id || 'system', scope },
});
```

- [ ] **Step 2: 验证开关逻辑**（`renderKnowledge` 内 effective 判定）+ 冒烟

## T5 — 契约测试

**文件：** 改 `test/http/system-overview-pages.test.js`

- [ ] **Step 1: 新增 K 四源断言**

```js
it('K 渲染器含四源面板（particles/edges/injection/precedent），data-dk 下钻', async () => {
  const { renderKnowledge } = await import('../../src/http/render/systemOverviewK.js');
  const r = await renderKnowledge({ me: { role: 'admin', tenantId: '*', scope: 'all' } });
  const html = r.html || '';
  expect(html).toContain('so-k-panels-sec');
  for (const k of ['knowledge-particles', 'source-edges', 'injection-coverage', 'precedent-graph']) {
    expect(html).toContain(k);
    expect(html).toMatch(new RegExp(`so-detail-hidden[^>]*data-dk="${k}"`)); // 每面板有隐藏明细
  }
});
```

- [ ] **Step 2: 跑 K/D/M 全测试确认全绿**

Run: `npx vitest run test/http/system-overview-pages.test.js` → 全绿

- [ ] **Step 3: 冒烟清理**（删 `scripts/tmp-k-smoke.mjs` / `tmp-k-sampler.mjs`）

## Self-Review

- **Spec coverage：** 四源（粒子/边/注入/先例）✅ T1+T3；租户默认+admin全租户 ✅ T4；趋势 `k_knowledge_count` ✅ T2；方法 SKILL 治理降级角落 ✅ T3 Step3；测试 ✅ T5；提交命令见下。
- **Placeholder scan：** 无 TBD；完整代码已给出（T1-T3 核心函数）。
- **Type consistency：** `renderFourPanels` 返回 `{html,details}`（T3）；`queryKnowledgeBuckets/injectionCoverage` 均接受 tenantId（T1）且渲染用同签名；`effective` 判定 T3/T4 一致。

## 验证门

- `node scripts/validate-contract.mjs docs/2026-09-10-system-overview-k-redesign-design.md --registry src/agent/agentSpec.js` → valid:true
- `npx vitest run test/http/system-overview-pages.test.js` → 全绿
- 冒烟：`node scripts/tmp-k-smoke.mjs` → 四源非空（真实库）

## 提交命令（每 Task 一 commit / 禁 git add -A / 由用户本地执行）

```powershell
cd D:\system\CRM-ai-native
# C1: T1+T3 渲染实现（四源 + 治理角落 + 样式）
git add src/http/render/systemOverviewK.js
git commit -m "feat(system-overview-k): rewrite K page as knowledge raw-material board with four sources"

# C2: T2 采样器
git add scripts/sample-system-overview.mjs
git commit -m "feat(system-overview-sample): add k_knowledge_count metric with '*' aggregate"

# C3: T4 路由开关
git add src/http/routes.js
git commit -m "feat(system-overview-k): support admin all-tenant scope switch"

# C4: T5 测试
git add test/http/system-overview-pages.test.js
git commit -m "test(system-overview-k): assert four-source panels and drilldown"

# C5: 文档
git add docs/2026-09-10-system-overview-k-redesign-design.md docs/superpowers/plans/2026-09-10-system-overview-k-redesign-plan.md
git commit -m "docs(system-overview-k): K page redesign design and plan (approved)"
```
