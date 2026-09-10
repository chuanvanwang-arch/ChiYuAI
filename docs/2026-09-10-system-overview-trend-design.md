# 设计文档：三大系统概览页 30 日趋势 SVG 真实化

- 日期：2026-09-10
- 关联设计：`docs/2026-09-10-system-overview-pages-design.md`（§1.3 已将趋势 SVG 标记为"后续迭代"）
- 方案：A（每日快照存量指标 → 渲染真实 sparkline）
- 状态：已批准（brainstorming P5）

## 1. 背景与目标

三大系统概览页（`/system-overview/{k|m|d}`）已上线，含四段式骨架：①顶部状态 ②近 30 日趋势 ③明细表 ④下钻弹窗。当前 §2 趋势区为静态占位 SVG（`renderTrendSvg()` 返回写死的 `<polyline>`，renderers 注释"未来接入按日采样后改为动态"）。

目标：将趋势区改为基于真实每日采样数据的 sparkline，使概览页真正反映系统运行演化。

## 2. 方案 A 设计

### 2.1 存储
新表 `crm.system_overview_sample`：
- `tenant_id VARCHAR` — 租户隔离（与既有多租户约定一致）
- `sample_date DATE` — 采样日
- `metric VARCHAR` — 指标键：`k_method_skill` / `m_precedent_edge` / `d_l1_intercept`
- `value INTEGER` — 当日快照值
- PK `(tenant_id, sample_date, metric)`

### 2.2 数据采集
新脚本 `scripts/sample-system-overview.mjs`（Node ESM，直连 PG，复用既有数据源）：
- 对每个租户计算并 upsert 三指标：
  - `k_method_skill` = `listSkillRegistry()` 方法论类 SKILL 注册数
  - `m_precedent_edge` = `crm.decision_precedent_rel` 行数（按 tenant_id）
  - `d_l1_intercept` = `getGateAttribution(tenantId)` 返回数组长度（L1 拦截累计）
- 幂等 upsert（`ON CONFLICT (tenant_id, sample_date, metric) DO UPDATE`）

### 2.3 触发
挂接现有每晚 10 点例行自动化，新增"采样"一步（调用 `sample-system-overview.mjs`）。独立 cron 亦可。

### 2.4 渲染改造（零新 API）
三 renderer 的 `renderTrendSvg(metric?)` 改为：
1. 调 `getTrendSamples(metric, 30)` 读近 30 日 `value` 序列；
2. 线性映射到 `viewBox 0..200 × 5..35` 生成真实 `<polyline points=...>`；
3. 不足 30 日时按实际天数绘制（不伪造长度）。

数据源函数 `getTrendSamples` 放 `src/http/render/systemOverviewShared.js`（三 renderer 共享）。

## 3. 零回归约束
- 不改 `config_center` 任何条目、不改配置页、不改 `#loop-strip` 文案。
- M 页仍 admin-only（趋势区对 admin 显示真实数据，非 admin 维持 forbidden 分支）。
- 不新增任何对外 HTTP API；`system_overview_sample` 仅渲染器内部读取。
- 迁移为 additive（新表），不改动既有表结构。

## 4. 任务拆分（含生命契约）

### T1 建表迁移 + 种子
- 新增 `db/migration-2026-09-10-system-overview-sample.sql`（CREATE TABLE + 复合 PK + 索引）。
- `db/schema.sql` 追加同构 DDL（单一事实源）。
- 成功：`system_overview_sample` 存在且 PK `(tenant_id, sample_date, metric)` 生效。

### T2 采样脚本 + 单元验证
- `scripts/sample-system-overview.mjs` 实现三指标 upsert。
- 成功：脚本跑通、对每租户写入 3 指标且幂等（二次运行不重复增行）。

### T3 三 renderer 接真实数据（异步）
- 新增 `src/http/render/systemOverviewShared.js` 的 `getTrendSamples`。
- 三 `renderTrendSvg` 改为读采样生成 polyline。
- 成功：三页趋势区 `data-trend` 的 polyline 来自采样而非写死。

### T4 契约测试
- `test/http/system-overview-pages.test.js` 新增断言：趋势区含 `data-trend` 且 polyline points 由采样序列驱动（注入 mock 采样后比对）。
- 成功：全量回归零退化。

### T5 挂接夜间自动化
- 在每晚 10 点例行自动化新增"采样"步。
- 成功：自动化运行后 `system_overview_sample` 含当日行。

## 5. 验证清单
- `node scripts/validate-contract.mjs docs/2026-09-10-system-overview-trend-design.md`（结构校验通过）
- 三页过 `node scripts/ui-lint.mjs`
- 起服务 + Playwright 截图 k/m/d 三页趋势区非静态占位
- 全量 vitest 零退化

## 闭环回写

| 任务 | 缺口类型 | 观察 | 预期 | 严重度 |
|------|----------|------|------|--------|
| （待 P10 回填） | — | — | — | — |

```contract-yaml
- task: "建表+采样+渲染接入 30日趋势"
  agent: crm-copilot
  skills: [ai-portal-page-generation]
  memory: [crm-native]
  success: "三概览页趋势区 polyline 来自 system_overview_sample 近30日采样，契约测试通过，ui-lint 零警告"
```
