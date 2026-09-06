# 销售决策场景配置页 TAB 改造设计

> 路径：`docs/2026-09-04-decision-scenarios-tab-redesign.md`
> 状态：**待 user 审批**（brainstorm 流程第 0 闸）
> 关联：`src/web/decision-scenarios.html` + `src/portal/decisionScenarioRender.js`
> 关联 SPEC：`docs/superpowers/plans/2026-08-27-decision-scenario-config.md`

---

## §0 现状（用户反馈）

你（用户）截图说「这里没有你说的聚焦尺子和启用尺子」+「页面太乱了看不懂」+ 提出「增加聚集尺子和启用尺子 + 通过筛选/TAB 查看」。

| 真实状态 | 客观证据 |
|---|---|
| 字段其实已经加了 | `decisionScenarioRender.js:91-103` 已加「聚焦尺子/启用尺子/及格线」三行（DS-row），agent-browser 实测 6 行存在 |
| 但截图仍是 4 行 | 你的截图是早期（修复前）版本，#36/#38 ReferenceError 修复同时把 import 切到 `decisionScenarioRender.js`，三字段是 9-04 14:30 后加的 |
| 13 个场景同时铺在一屏 | `renderDecisionScenarios` 按 stage 分 section，但所有 stage 一次铺开；crm.decision_scenario 实有 10 stage（8 销售 + 1 平台治理 meta + 1 TRACE）|
| 字段过多 | 每张卡 6 行 ds-row，评估维/处置集铺满，认知负担大 |

---

## §1 目标 / 非目标

### §1.1 目标

- 按销售漏斗 stage 自然排序（左→右 一→八）做 TAB 分组，单 TAB 单 stage
- 卡片简化为聚焦尺子 / 启用尺子 / 及格线 / 简短描述四要素
- 评估维 / 处置集 / 方法论进「编辑」弹窗（默认折叠，不在卡片铺满）
- 顶部加「只看差异化」开关（启用尺子数 < 9 时显示橘点标识）
- 编辑字段保存经决策第 0 闸（不变，沿用 `validateScenarioPatch` 白名单）

### §1.2 非目标（不在本期范围）

- 不动 schema（focus/enabled_rulers/rubric_pass_line 已在 db）
- 不动服务端 EVAL（评分器 `rubricScorer.scoreDecision` 已读这三个字段）
- 不动路由（page=14 不变）
- 不动决策第 0 闸 + tenant 隔离
- 不改评分器对 enabled_rulers 的 skip 语义（仍以缺省=全集向后兼容）

---

## §2 设计方案（草图见上方 inline widget）

### §2.1 顶部 TAB 栏（横向滚动）

```
一、线索 | 二、机会评估 | 三、客户策略 | 四、方案价值 | 五、商务报价 | 六、签单前风险 | 七、终局决策 | 八、丢单复盘
```

- 顺序按 stage 中文（自然序：一→八）
- 当前 TAB 加 `border-bottom: 2px solid var(--color-text-info)` 与字体加粗
- 单 TAB 容纳 1 个 scenario（8 TAB = 8 场景 1:1 对应）
- 不放「平台治理 4」 + 不放 TRACE（debug 不该进销售视角）

### §2.2 当前 TAB 卡片网格

每张卡片 5 个元素：

| 行 | 内容 | 大小 |
|---|---|---|
| header | `scenario_id` + tier badge（LEAD/HIGH）+ 自主/人工 badge | 14px / 11px |
| description | 1 行精简文案（≤40 字） | 12px muted |
| 聚焦尺子 | 列表 + 橘色「×1.5 加权」提示 | 12px |
| 启用尺子 | 列表，完整时显示「全 9 尺子」+ 灰点 | 12px |
| 及格线 | 0.00–1.00 | 12px |
| [编辑] | 进编辑弹窗 | 12px button |

**移除卡片级展开的元素**：方法论 tag、评估维 chip、处置集 → 进编辑弹窗（不删，只是默认折叠）。

### §2.3 编辑弹窗（按「编辑」打开）

- 编辑弹窗维持现有 `validateScenarioPatch` 白名单（description/methodology_ids/eval_dimensions/default_tier/autonomous_allowed/dispositions/focus_rulers/enabled_rulers/rubric_pass_line）
- 加 3 input：focus_rulers（多选 chip）、enabled_rulers（多选 chip）、rubric_pass_line（0–1 滑块）
- 评估维 chip / 处置集 checkbox 沿用现有 UI（methodology_ids / dispositions）

### §2.4 「只看差异化」开关（顶部右侧）

- 默认开 → 当启用尺子数 < 9 显示橘点 + tooltip「启用尺子 < 9 尺子，跑了子集」
- 关闭时显示为「全 9 尺子」灰字

---

## §3 实现路径（待批准后）

| 步 | 文件 | 改动 |
|---|---|---|
| 1 | `src/web/decision-scenarios.html` | 删除 `byStage` 全展开渲染；改 `flatTabs` + `renderCurrentStageCards()` 二段式 |
| 2 | `src/portal/decisionScenarioRender.js` | 导出 `renderScenarioTabs(scenarios, activeStageId)` + `renderStageCards(scenarios, stage)`；`cardHtml` 简化（保留聚焦/启用/及格/desc） |
| 3 | `src/portal/decisionScenarioRender.js` | 编辑弹窗补 3 字段（focus/enabled/pass_line）的多选 chip + 滑块 |
| 4 | 测试 | `test/web/decisionScenarioRender.test.js` 新增 6 例（tab 切换/筛选开关/弹窗 3 字段渲染） |
| 5 | 验证 | 服务端 4 端点可达；浏览器实测 8 TAB × 卡片渲染 / 编辑保存 |

---

## §4 验收

1. 浏览器打开 `decision-scenarios.html`：顶部横向 8 TAB（一→八）+ 当前 TAB 展示 1 个场景卡片
2. 切换 TAB 切到不同 stage，对应场景卡正确
3. 卡片行=4：聚焦尺子/启用尺子/及格线/简短描述；点 [编辑] 弹窗里有评估维+处置集+3 新字段
4. 修改任一字段点保存：弹「决策产证 id: ...」（决策第 0 闸通过），刷新页面新值入库
5. 「只看差异化」开时所有场景都有一个橘点（因为已 seed 全部跑了差异化）；关时显示「全 9 尺子」灰字
6. 已有 `decisionScenarioRender.test.js` 28 例不退；新增 ≥6 例通过

---

## §5 范围外（不本次做）

- 不新增 stage（如「平台治理」「调试」都不进销售视角）
- 不改 db schema（focus/enabled/pass 三列已在）
- 不动评分器（语义保持：enabled 缺省=全集，否则走子集）
- 不增加 crm.decision_scenario 行数（保持现有 13 行不动）
- 不动 configCenter.js（page=14 不变）

---

## §6 待审批事项（你拍）

按 brainstorming 流程，请明确批准「§2 设计方案」→ §3 → 实现。**未批准不写代码**。

> 备选分歧点（如果不喜欢草图）：
> - **不喜欢 8 个单场景 TAB？** 草图把 8 个 stage 个个独立成 TAB；若想「商机前/商机中/商机后」3 个折叠组，可改
> - **不喜欢卡片 4 行简化？** 若想保留评估维/处置集明面，草图已默认折叠进编辑弹
> - **不喜欢顶部 TAB 横排？** 改为左侧树形 stage 表也可（布局更密，但学习成本高）

不批准 / 提修改意见 / 全部 OK → 皆请明示。
