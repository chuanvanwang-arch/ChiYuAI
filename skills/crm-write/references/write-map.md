# crm-write · 用户意图→写 Action 映射（references/write-map.md）

| 用户一句话 | Action | 第0闸 | 审批 |
|---|---|---|---|
| 新增商机 N 万 | `data-particle-create`(type=CRM_DEAL) | decision_id 必填 | 视需 |
| 推进商机阶段 | `crm-deal-advance` | 只进不退+输单必填原因 | — |
| 新建/刷新报价 | `crm-quote-create` | decision_id 必填 | 报价审批流 |
| 提交审批 | `crm-approval-start` | 需审批流定义 | 审批流 |
| 登记回款 | `crm-payment-record-create` | decision_id 必填 | 财务确认 |

## 与决策事件主轴（§6）衔接

- 每条写映射的「第0闸」= 决策事件主轴的强制携带物：没有 decision_id 的写请求在 phase1 就被拒。
- 写操作执行后产生 `decision.*`（决策事件），供决策网络先例检索（§6.3）。