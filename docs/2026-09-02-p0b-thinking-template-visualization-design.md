# P0-② 思维要素可视化与「7–8 大决策 × 8要素×九尺子」配置落地设计

> 设计依据：`docs/2026-09-02-cognitive-decision-unified-design.md` §1.1（八要素）/§1.2（九尺子）/§1.3（七阶段→八要素聚焦）
> 单一事实源：`src/decision/thinkingTemplates.js`（方法论层，不进 schema）
> 状态：草稿待批准（HARD-GATE）

## 0. 结论先行（诊断）

用户反馈两条缺口均属实，非缓存/未刷新：

| 缺口 | 证据 | 根因 |
|---|---|---|
| 监控台无 8要素9问题 | `src/web/sales-decision-monitor.html` 全页无 `pre-context`/八要素/九尺子调用 | 前端未接 `GET /api/decision/pre-context` |
| 后台无「7大决策×8要素9问题」配置 | `src/portal/configCenter.js` `CONFIG_ITEMS` 无此条目；`thinkingTemplates.js` 仅 `LEAD_FOLLOW_UP` 1/8 场景实例化了八要素 | 模板内容只写 1 个场景 + config 无入口 |

**真相**：`decision_scenario` 已种 8 个销售场景（线索→丢单复盘），但八要素思维拆解只建了 `LEAD_FOLLOW_UP` 一个；其余 7 个走通用兜底（无业务实例）。要让后台"看得到、配得了"全部 7–8 大决策，需**先补全 7 个场景的思维模板内容**，再接 UI。

用户已确认范围（AskUserQuestion 2026-09-02）：
- **补全全部 8 场景模板**（作者化 7 个缺失场景）
- **监控台呈现位置 = 决策下钻弹窗内嵌**（新增「思维要素(8要素×九尺子)」页签）

## 1. 目标

1. `thinkingTemplates.js` 覆盖全部 8 个销售场景的八要素×九尺子拆解（基于各场景 `methodology_ids` + `eval_dimensions` 实例化）。
2. 销售决策监控台：在决策下钻弹窗内嵌「思维要素(8要素×九尺子)」页签，按场景展示八要素提问骨架 + 九尺子评分键 + 概念清单。
3. 配置中心（`config.html`）：新增「销售决策思维要素（8要素×九尺子）」配置项 → 只读总览页，列出 8 大决策各自的八要素拆解（可审计、不造假）。
4. 诚实原则：未作者化场景显示通用兜底并标注「未配置思维模板」；不虚构评分、不虚构内容。

## 2. 后端改动

### 2.1 `src/decision/thinkingTemplates.js`：补 7 个场景模板
在 `TEMPLATES` 注册表新增 7 个 key，结构与 `LEAD_FOLLOW_UP` 一致（`src/decision/thinkingTemplates.js:43-158`）：每个场景 8 个 `elements`（顺序 = `intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs`），含 `guiding_question/prompts/expected_fields/source_dims/methodology/ruler_keys/example`。

实例化的方法论绑定（取自 `db/seed.sql` 各场景 `methodology_ids`）：
- `OPP_QUALIFY`（二、机会评估）：MEDDICC / OPP_MATRIX / ROLE_MAP
- `CLIENT_STRATEGY`（三、客户策略）：ROLE_MAP / FACT_VS_TALK / MEDDICC
- `SOLUTION_VALUE`（四、方案价值）：OPP_MATRIX / RISK_TRADEOFF
- `QUOTE_PRICING`（五、商务报价）：RISK_TRADEOFF / STOP_LOSS
- `SIGN_RISK`（六、签单前风险）：RISK_TRADEOFF / STOP_LOSS
- `POST_CONTRACT`（七、终局决策）：RISK_TRADEOFF / OPP_MATRIX
- `LOSS_REVIEW`（八、丢单复盘）：FACT_VS_TALK / OPP_MATRIX

`stage_label` 取自 seed（`一、线索`…`八、丢单复盘`）；`scenario_note` 写该场景决策句（取自 seed `description`）。

### 2.2 新增批量端点 `GET /api/decision/thinking-templates`
`src/http/decisionReadRoutes.js` 新增（requireMe 鉴权，与 pre-context 同款）：
- 查 `crm.decision_scenario WHERE stage <> 'meta'` 取全部销售场景；
- 逐场景 `getThinkingTemplate(scenario_id)`（已作者化返实例，未作者化返 generic+`generic:true`）；
- 返回 `{ ok:true, items:[{scenario_id, stage, scenario_note, generic, elements:[8]}] }`。
- 供 config 总览页一次性拉全，避免前端发 8 个请求。

### 2.3 复用既有端点（不新增重复）
- `GET /api/decision/pre-context?scenario_id=X`：监控台弹窗消费，返八要素骨架 + `concept_checklist`（已含 P3 D1 知识注入）。
- `GET /api/decision/:id/thinking`：真实物化八要素（已有，供单决策穿透时标注"实际填了哪些"）。

## 3. 前端改动

### 3.1 监控台 `sales-decision-monitor.html`：弹窗内嵌思维要素页签
- 在 `attrib-modal`（`src/web/sales-decision-monitor.html:428`）内新增页签「思维要素(8要素×九尺子)」，与现有「单次决策7维快照」并列。
- `drillGateAttribution(scenarioId)`（`:706`）打开弹窗时，并行 `fetch('/api/decision/pre-context?scenario_id='+scenarioId)`：
  - 渲染 8 要素卡片：要素名 + `guiding_question` + `prompts`（填空提示）+ `ruler_keys`（九尺子评分键，标为「尺子」徽标）+ `methodology`（方法标签）+ `focus`（本场景聚焦要素 `×1.5` 角标）。
  - 若 `generic:true`：顶部红色提示「该场景未配置思维模板，显示通用八要素骨架」。
- 色值 100% 走 `tokens.css` 语义变量（`.sdim`/`.dn-empty`/`.card` 等既有类），零硬编码（过 `tmp/audit_css_vars.py`）。
- 受控页已链 `/portal/page.css`（沿用现有弹窗样式），未登录态：端点返 401，弹窗内显示「请先登录」。

### 3.2 配置中心 `config.html` + `src/portal/configCenter.js`：新增配置项
- `configCenter.js` `CONFIG_ITEMS` 新增（id 取未占用值 **33**，组 `销售方法论与决策治理`）：
  `{ id: 33, name: '销售决策思维要素（8要素×九尺子）', group: '销售方法论与决策治理', status: 'ready', page: '/decision-thinking.html', endpoint: '/api/decision/thinking-templates', note: '8 大决策各自八要素提问×九尺子评分键总览（方法论层，代码版化，只读）' }`
- 新增页面 `src/web/decision-thinking.html`：登录后 `fetch('/api/decision/thinking-templates')`，按场景分组渲染 8 要素×九尺子表格（场景 | 要素 | 核心问题 | 九尺子评分键 | 方法 | 聚焦）。`generic:true` 场景标注「未配置思维模板」。
- 复用 `/portal/components.js`、`/portal/layout.js`、`tokens.css`、`common.css`，零硬编码色值。

## 4. 单一事实源 / 不造假

- 八要素内容唯一来源 = `thinkingTemplates.js`（代码层，可版本化、可单测）；前端两页只读消费，不另存副本。
- 不新增 DB 表/列（模板属方法论层，与 `decision_scenario` 配置正交，设计文档 §B4 已裁定）。
- 未作者化场景 = generic 兜底 + 明确「未配置」标注，绝不把通用骨架伪装成"该决策专属模板"。

## 5. 验收标准

1. `node test/decision/thinkingTemplate.test.js` 扩展：断言 `buildPreContext(id)` 对全部 8 个销售 scenario_id 均返回 8 个 `elements`（含新增 7 个）。
2. 监控台弹窗「思维要素」页签：选任一场景显示其八要素 + 九尺子评分键；`LEAD_FOLLOW_UP` 显示完整实例，`generic` 场景显示标注。
3. `config.html` 出现「销售决策思维要素（8要素×九尺子）」入口，点击进 `/decision-thinking.html` 列出全部 8 大决策八要素拆解。
4. `tmp/audit_css_vars.py` 两页零硬编码色值违规。
5. 未登录态相关端点返 401，前端显「请先登录」不报错。
6. 不破坏既有 62 例回归（`npm test` 全绿）。

## 6. 任务拆分

- **Task A**（后端·内容）：`thinkingTemplates.js` 补 7 个场景模板 + 单测扩展。
- **Task B**（后端·端点）：`decisionReadRoutes.js` 新增 `GET /api/decision/thinking-templates`。
- **Task C**（前端·监控台）：`sales-decision-monitor.html` 弹窗内嵌思维要素页签。
- **Task D**（前端·配置中心）：`configCenter.js` 加 id:33 + 新建 `decision-thinking.html`。

每 Task 一 commit（沙箱无凭证，用户本地按功能线提交，署名 `Co-Authored-By: 王川 <watchm@163.com>`，禁 `git add -A`）。

## 7. Living Contract 自检

```json
{
  "valid": true,
  "checks": {
    "single_source": "thinkingTemplates.js 为唯一八要素事实源，前端只读",
    "no_new_schema": "不新增 DB 表/列",
    "honesty": "generic 场景显式标注未配置，不伪装",
    "zero_hardcode_color": "两前端页色值全走 tokens.css，过 audit_css_vars.py",
    "auth": "两新端点 requireMe，未登录 401",
    "reuse": "pre-context/thinking 端点复用，无重复实现"
  }
}
```
