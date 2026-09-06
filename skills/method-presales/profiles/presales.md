# method-presales · 售前角色自适应呈现（profiles/presales.md）

> 售前（presales）调用本方法论时看到的视角。商务（contract-admin）与售前已拆分，本文件只服务于售前。

## 售前视角：逐项自检清单
针对当前商机，逐项核对 6 维度，输出"我还有哪维没补齐"：

1. **S1 方案契合度**：客户 requirements 是否逐条映射？[ ] 是 / [ ] 否（列出缺口）
2. **S2 技术可行性**：有无未解决技术依赖？[ ] 无 / [ ] 有（列出 blocker）
3. **S3 价值量化**：ROI/节约额是否量化？[ ] 已量化 / [ ] 待补
4. **S4 风险与异议**：已知异议是否应对？[ ] 已应对 / [ ] 待补
5. **S5 差异化**：相对竞品优势是否清晰？[ ] 清晰 / [ ] 可选
6. **S6 交付可信度**：POC/DEMO 是否验证？[ ] 已验证 / [ ] 排期中

## 售前日/周工作流
- **每日**：查看分配给自己的商机技术方案就绪率；处理"方案采纳率"预警。
- **每周**：汇总本周 POC/DEMO 进展；向销售同步"哪些单可推进报价"。
- **里程碑**：商机进入 `quoted` 前，确保 `gate = PASS`；否则拦截并退回补齐。

## 与 crm-* 的衔接
- 评估 → `crm-query`（读 DEAL + 已有 PROPOSAL）
- 出方案 → `crm-write` 调 `crm-proposal-write`（写 CRM_TECHNICAL_PROPOSAL，带 decision_id）
- 预警 → `crm-risk`（方案超期未出 / POC 卡顿 → emit decision_required）
