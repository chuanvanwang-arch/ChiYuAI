# method-presales · 维度释义与证据来源（references/dimensions.md）

| dim_key | 释义 | 取值示例 | 证据来源 |
|---|---|---|---|
| S1 方案契合度 | 方案是否对症客户业务场景 | 高：逐条映射客户 requirements；低：通用模板套用 | deal.payload.requirements / proposal.coverage |
| S2 技术可行性 | 技术架构是否在能力边界内 | 高：含技术约束清单且无硬伤；低：存在未解决依赖 | proposal.technical_constraints / 架构评审 |
| S3 价值量化 | 收益是否被经济决策者认可 | 高：ROI=节省 30% 人力；低：仅"提升效率"定性 | proposal.quantified_benefit |
| S4 风险与异议 | 已知风险/异议是否识别并应对 | 高：列出异议+应对；低：未识别 | proposal.known_objections / compliance |
| S5 差异化竞争力 | 相对竞品的独特优势 | 高：3 项独家能力；低：同质化 | proposal.competitive_edge |
| S6 交付可信度 | POC/DEMO/参考案例验证 | 高：POC 通过+参考案例；低：纯 PPT | proposal.poc_status / demo_done / reference_case |

## 话术库（售前引导用）
- S3 缺口话术："请用客户财务口径量化收益，例如'年节约 X 人月 / Y 万元'。"
- S6 缺口话术："建议排期一次 POC，用真实数据验证关键指标后再推进报价。"
