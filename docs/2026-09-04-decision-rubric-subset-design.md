# 销售决策差异化评分：聚焦加权 + 真子集跳过（A+B）

- 日期：2026-09-04
- 决策：用户拍板「8 个销售场景不强制全 9 尺子」（对齐 `thinkingTemplates.js` 实际 8 个，含 `LOSS_REVIEW`；`decisionRepo.js` 注释里的「7 个」为过时口径，已修正为 8）
- 批准：A（补 seed 差异化数据）+ B（新增 enabled_rulers 真子集跳过）均同意

## 目标
让每个销售决策场景可配置：
1. **聚焦加权** `focus_rulers`（×1.5）—— 已有机制，补 seed 数据使其干净库不丢；
2. **及格线** `rubric_pass_line`（场景级 ratio 阈值）—— 已有列，补 seed 数据；
3. **真子集跳过** `enabled_rulers`（非空时只跑列出的尺子，其余标记 skipped 不计入总分）—— 本次新增。

## 设计要点
- **向后兼容铁律**：`scoreDecision` 的 `enabled` 缺省/空 = 跑全 9 尺子（原行为不变）。仅当显式传入子集才跳过。现有单测（无 enabled 入参断言 9 尺子全在）不破。
- **三列落点**：`crm.decision_scenario.focus_rulers(JSONB)` / `rubric_pass_line(REAL)` / `enabled_rulers(JSONB)`。
  - 单一事实源 `db/schema.sql` 补列；`db/migrate.js` 加列（`ADD COLUMN IF NOT EXISTS` 幂等）。
- **评分器** `src/decision/rubricScorer.js`：计分循环遇非 enabled 尺子 → `{skipped:true}` 跳过；加权循环跳过 skipped（max_total/weighted_total 仅计 enabled 子集）。
- **运行时接线** `src/decision/decisionRepo.js`：`loadScenarioConfig` 多选 `enabled_rulers`，评分调用传入 `enabled`。
- **配置页** `decision-scenarios.html`(S19) + `src/portal/decisionScenario.js`：三字段进 `EDITABLE_FIELDS` 白名单 + 校验（focus/enabled 数组形态、pass_line 0–1）+ `COL_CAST` + 卡片展示 + 编辑表单。写经决策第0闸（config_change 事件）。
- **种子** `db/seed.sql`：原 INSERT 仅 8 基础列；追加幂等 `UPDATE ... FROM (VALUES)` 块为 8 销售场景写 focus_rulers/pass_line/enabled_rulers。meta/财务场景保持 NULL=全 9 尺子。

## 8 场景启用尺子子集（业务判断，可经页面调整）
| 场景 | 聚焦 ×1.5 | 及格线 | 启用尺子 |
|---|---|---|---|
| LEAD_FOLLOW_UP | clarity,relevance | 0.50 | clarity,relevance,logic,importance |
| OPP_QUALIFY | relevance,depth | 0.60 | accuracy,relevance,depth,logic,breadth,importance |
| CLIENT_STRATEGY | breadth,depth | 0.60 | breadth,depth,logic,relevance,importance |
| SOLUTION_VALUE | relevance,logic | 0.60 | relevance,logic,depth,precision,importance |
| QUOTE_PRICING | precision,relevance | 0.65 | precision,relevance,logic,importance,clarity |
| SIGN_RISK | depth,breadth | 0.65 | depth,breadth,logic,relevance,importance |
| POST_CONTRACT | logic,relevance | 0.60 | logic,relevance,depth,importance |
| LOSS_REVIEW | breadth,depth | 0.55 | breadth,depth,logic,relevance,importance,fairness |

## 验证
- `test/decision/rubricScorer.test.js`：20 passed（含 2 新增真子集测试）
- `test/web/decisionScenario.test.js`：28 passed（含 3 新增字段校验测试 + 白名单快照更新）
- `test/decision/selfcheck.test.js`：6 passed
- 3 模块 `node --check` 通过

## 部署顺序（用户本地执行）
1. `node db/migrate.js`（加 enabled_rulers 列，幂等）
2. `node db/seed.sql` 或对应 seed 命令（写 8 场景差异化数据，幂等）
3. 重启服务；访问 `/decision-scenarios.html` 可见聚焦/启用/及格线，可改。
