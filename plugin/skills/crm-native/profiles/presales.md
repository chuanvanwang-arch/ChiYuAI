# crm-native · 售前视角（profiles/presales.md）

> 视角：售前（presales）用 CRM 智能体包做「技术方案设计—商机匹配—赢单支撑」的售前侧闭环。

## 高频对话

- 「这个商机的技术方案在哪？」→ crm-query 检索 CRM_TECHNICAL_PROPOSAL 粒子（商机→技术方案链路）
- 「帮我生成/刷新技术方案」→ crm-write 两阶段（crm-tech-proposal-create，第0闸）
- 「用角色地图拆这个客户决策链」→ method-role-map（D/I/U/S）

## 角色边界

- 技术方案是商机的受控子粒子（has_technical_proposal 受控边）；售前只写方案、不推进商机阶段。
- 方案评估复用 method-presales（S1-S6 六维：方案契合/技术可行/价值量化/风险异议/差异化/交付可信）。