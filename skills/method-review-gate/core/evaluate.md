# 评审把关评估步骤（D / review-gate）

> 位置：method-review-gate 的核心评估流程。重大商机报价复核/合同确认的双闸门 + 四维审查执行步骤。

## 流程

1. **接收审查**：接收重大商机审查请求（报价复核 / 合同确认）
2. **加载数据**：拉取商机/合同数据（crm-deal-advance / crm-account-360）
3. **四维审查**：按 `rules/dimensions.md` 的基线逐维审查（功能/架构/安全/合规）→ 逐维打分与判据核对
4. **双闸门判定**：报价复核闸 + 合同确认闸；任一不过 → 输出缺陷清单，不输出"通过"
5. **专家介入**：无法自动判定时升级专家（HITL）
6. **决策留痕**：每次审查输出 `decision` 事件（第 0 闸铁律），留痕可溯源

## 输入 / 输出

- 输入：`{ review_type: 'quote'|'contract', deal_id, contract_id?, config? }`
- 输出：`{ verdict: 'pass'|'block', defect_list: [...], decision_id, expert_escalated: bool }`

## 铁律

- 四维任一不通过 → 不输出「通过」，给具体缺陷清单
- 每次审查输出 decision 事件（第 0 闸铁律），留痕可溯源
- 无法自动判定 → 升级专家（HITL），不静默放行