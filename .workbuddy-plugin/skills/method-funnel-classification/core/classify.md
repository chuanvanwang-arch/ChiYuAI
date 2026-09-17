# method-funnel-classification · 分类流程（core/classify.md）

> 唯一事实源 = `methodology.json`（四象限定义 + 节奏）。本页是执行步骤。

## 步骤

1. **取上下文**：客户粒子（CRM_ACCOUNT）的 `payload.name/account_segment/tier/visit_notes/needs/pain_points` + 该客户名下的商机（CRM_DEAL 关联）。
2. **两问判定四象限**：
   - 问 A（客户行为）：该客户是否已行动——有需求正在解决？在评估供应商？
   - 问 B（销售感知）：我们是否已识别——知道这个商机/需求存在？
   - 查四象限：已行动×已识别 → 商机客户；已行动×未识别 或 未行动×已识别 → 目标客户；未行动×未识别 → 潜力客户。
3. **写分类**：
   - `account_segment` = opportunity / target / potential（AI 属性 C_Classify 落点）
   - `tier` = 商机客户→按商机阶段推进；目标客户→按月度节奏；潜力客户→按季度节奏（对齐 config_store['named-account-targets'] 默认三档）
4. **按 rhythm 设定下次拜访时间**（rules/rhythm.md）：目标客户 `sales-thresholds.coverage.target_month_days`（出厂建议 30）天内 / 潜力客户 `sales-thresholds.coverage.potential_quarter_days`（出厂建议 90）天内。

## 判定陷阱

- 有商机但销售不知道 → 目标客户（未识别）——先识别，别当潜力客户温养。
- 有商机且已识别 → 商机客户（按需推进，别按固定月/季节奏）。
- 无需求且未识别 → 潜力客户（按 `sales-thresholds.coverage.potential_quarter_days` 出厂建议每季温养，不当目标客户高频打扰）。

## 与指名客户监测衔接

- `tier` 字段是 §13.2 `tier_rule: by_payload` 的消费来源：`CRM_ACCOUNT.payload.tier` 为空 → 潜力档（保守默认）。
- 分类错误会导致监测档位偏差 → 建档时按本流程赋值，避免「商机过滤缺口」误判。