# method-fact-vs-script · 评估流程（四步）

> 唯一事实源 = `method-fact-vs-script/methodology.json`（维度/权重/门控）。本页是执行步骤。

## 步骤

1. **取上下文**：商机粒子（CRM_DEAL）的跟进记录/会议纪要/客户沟通内容（`payload.followups` / `payload.meeting_notes`）+ 决策场景 `eval_dimensions` 条件。
2. **逐条分类**（对每条客户陈述，按 F→S→E 顺序）：
   - F（事实）：有书面（邮件/合同/批复）、实测（POC/DEMO 结果）、第三方（参考案例/行业报告）佐证且无歧义 → 事实。
   - S（话术）：口头表述（\"预算没问题\"\"我们很着急\"）、宣传性用语（\"行业第一\"\"全面合作\"）、无佐证承诺 → 话术（标记为待验证线索）。
   - E（证据等级）：给每项陈述标注证据来源与等级（书面=0.95 / 实测=0.9 / 第三方=0.85 / POC=0.8 / 口头=0.5）。
3. **对照检查**：判断商机推进所依赖的维度（BANT B/A/N、MEDDICC E1/I1 等）是否有 E≥0.8 的事实支撑——还是只靠话术。
4. **产出结论**：`{ verdict, facts[], scripts[], evidence_map, gate }`，gate ∈ `FACT_CONFIRMED | NEEDS_VERIFICATION | SCRIPT_ONLY`，优先列出\"推进所依赖但只有话术\"的项。