# crm-risk · 检测规则与阈值（rules/detect.md）

## 三模式阈值

| 模式 | 触发条件 | severity |
|---|---|---|
| `no_proposal_over_30d` | DEAL stage∈[opportunity,quote,win] 且无 has_technical_proposal 边且 `now - updated_at > 30天` | high |
| `win_without_proposal` | DEAL.stage=win 且无方案边 | high |
| `payment_overdue` | 合同应收日期 < now - 账期 且无回款粒子关联 | medium-high |

## 差量写入纪律

- 仅当 ai 属性 JSON 实际变化才 `updateParticle`（内容没变不重写——幂等）。  
- dryRun=true：只扫描+统计，不写（用于演示/预演）。

## 先于提问（主动预警）

- 扫描命中立即 emit（不等用户问）——「3 条商机缺方案>30天 / 2 笔回款逾期」。
- 预警走 SSE（前端/智能体实时消费）。

## 只读+告警（不写业务数据）

- 探测读粒子 + 写告警事件（emit），**不写商机/合同 payload**（业务写只属 crm-write 两阶段）。
- 绝对禁删：无 delete 工具。