# method-risk-tradeoff · 维度释义（references/dimensions.md）

## R · 风险等级（Risk Level）

- 客户信用风险（`payload.credit_rating` 评级、历史逾期 `payload.payment_history`）：信用差 = 回款风险高。
- 交付风险（`payload.custom_scope` 定制占比高 = 交付复杂度高、周期长、质量风险大）。
- 合规风险（`payload.compliance_flag`：数据出境/行业资质/投标合规）。
- 反例：只看金额不看信用 → 把高风险单当优质单。

## B · 收益预期（Expected Benefit）

- 金额（`payload.expected_amount`）+ 毛利（`payload.expected_margin`）+ 战略价值（进入新行业/标杆背书）。
- 收益必须量化，不能是"可能很有价值"。
- 与 R 对照：R 高时必须 B 足够高才是合理风险（`ratio ≥ 1`）。

## RD · 红线（Red Line）

- 合规红线：违反数据合规/行业资质要求 → 一票否决（无论金额多大）。
- 信用底线：客户信用评级低于平台设定的最低准入 → 一票否决（除非有第三方担保）。
- 交付能力：定制范围超出团队/供应商能力边界 → 红线（拒绝硬接）。
- 红线是规则不是建议：触碰即 BLOCK，可以讨论缓解但不可"先接了再说"。

## M · 缓解措施（Mitigation）

- 信用类：预付定金、银行担保、分期付款与里程碑绑定。
- 交付类：第三方分包、分期交付、范围收敛（先 MVP 后二期）。
- 合规类：法务条款、数据脱敏方案、资质前置获取。
- 缓解必须落地（有合同条款/有执行人/有时间点），"客户说没问题"不算缓解。

## 与其它方法论衔接

- 与 `method-stop-loss` 互补：本方法论决定"要不要进"，止损点方法论决定"何时撤"。
- 与 BANT/MEDDICC 复用证据：B 维度参考 BANT 的 B（预算）、MEDDICC 的 M1（指标量化）。