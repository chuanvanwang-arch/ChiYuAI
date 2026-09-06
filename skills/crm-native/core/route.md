# crm-native · 意图路由核心（core/route.md）

> 设计输入：§6.13.8 原则③（管道原生 L2C 是脊柱）+ 原则⑤（先于提问的预警）。

## 路由五步

1. **取用户输入**（一句话自然语言）。
2. **意图识别**（规则优先，LLM 可补充）：
   - 含「查/看/什么情况/360/多少」→ `crm-query`
   - 含「决策链/影响地图/为什么这么定/关系网/上下游」→ `crm-query` → graph_query（`/api/graph/*` 只读查询面）
   - 含「记/新增/建/更新/写」+ 商机/客户/报价/合同 → `crm-write`
   - 含「预警/链断裂/风险/逾期」→ `crm-risk`
   - 含「BANT/MEDDICC/矩阵/排序/止损/红黄」→ 对应 `method-*`
3. **加载技能**（惰性）：只加载命中技能 + 其依赖子技能。
4. **执行**：读直连走 mcp read；写走 mcp write phase1→phase2（决策闸）。
5. **汇总回复**：翻译成业务语言（不暴露 action/agent/SSE 内部名）。

## 意图到 Action 映射（写）

| 用户意图 | Action（write） | 第0闸 |
|---|---|---|
| 新增商机 | `crm-deal-create`(若注册) / `data-particle-create` | decision_id 必填 |
| 推进商机阶段 | `crm-deal-advance` | 只进不退+输单必填原因 |
| 新建报价 | `crm-quote-create` | decision_id 必填 |
| 提交审批 | `crm-approval-start` | 需审批流转 |

## 角色识别（自推断，不问身份）

- 对话内容出现「团队/组合/分配」→ manager；「方案/技术」→ presales；「止损/撤/投入」→ exec；「回款/应收」→ finance；其余 → sales。
- profiles/ 目录按角色加载对应视角。