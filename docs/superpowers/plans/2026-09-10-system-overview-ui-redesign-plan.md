# 三概览页 UI 重构实施计划（K/M/D）

- 设计文档：docs/2026-09-10-system-overview-ui-redesign-design.md（契约 valid:true，已批准）
- 范式：概览页=看板（状态+趋势+汇总），点行下钻明细；零新 API；M 仍 admin-only。

## T1 — K 重构为知识系统看板
- 改 `src/http/render/systemOverviewK.js`：
  - 顶部状态：方法 SKILL 装配健康度（总数/启用/停用/维度一致率）+ 闭环标识。
  - 趋势：复用 `k_method_skill` polyline（不变）。
  - 构成三栏：① 方法 SKILL 注册清单（按 category 分组、启停徽标）② 维度镜像一致性（dim_skew 行，data-dk 下钻）③ 本体词表治理（enumHintFields().length 指标）。
  - 下钻：点击 SKILL 行 → renderSkillDetail（已有）。
- 不动 shell 页与路由。

## T2 — M 改为图模型
- 改 `src/http/render/systemOverviewM.js`：
  - 顶部：先例边数 + 趋势（不变）。
  - 图渲染：先例节点（top N）+ 决策节点（引用它们的 decision）+ REFERENCED_PRECEDENT 边；原生 SVG（复用 decision-graph.html 取色范式，禁硬编码）。
  - 节点点击下钻：先例→renderPrecedentDetail（已有）；决策→新增 renderDecisionDetail（引用的先例清单）。
  - 非 admin：权限说明 + "请 admin 登录"提示（不变）。
- 需新增 hidden 块：precedent 节点 + decision 节点各一组。

## T3 — D 底部 8 阶段汇总
- 改 `src/http/render/systemOverviewD.js`：
  - 在 L3 段之后新增 `so-d-stages`：8 个 SCS 场景卡片（阶段名+样本+业务成功率徽标），data-dk=scenario_id。
  - 点击 → 复用 renderScenarioDetail（已有 L2 下钻块）。
  - 顶部/趋势/L1/L2/L3 不变。

## T4 — 契约测试
- 扩 `test/http/system-overview-pages.test.js`：断言 K 含三支柱类（so-k-pillars）、M 含 `<svg` 图节点（so-m-graph）、D 含 8 个 `so-stage` data-dk。

## T5 — ui-lint + 浏览器冒烟
- `node scripts/ui-lint.mjs` 三 shell 页零新增警告。
- 用户侧 localhost:3000 实测。

## 验证门
- `node scripts/validate-contract.mjs` 通过；三页 ui-lint 零新增；测试全绿。
- 提交命令（每 Task 一 commit，禁 git add -A）于实施末产出。
