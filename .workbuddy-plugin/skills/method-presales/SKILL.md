---
name: method-presales
description: 售前解决方案设计方法论——逐项评估方案契合度/技术可行性/价值量化/风险异议/差异化/交付可信度，产出技术方案就绪度评分与缺口清单，门控商机推进至报价。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# method-presales · 售前解决方案设计方法论

> 定位：售前（presales）角色判断"技术方案能不能支撑这单推进报价"时参考的方法论。
> 机器可读维度见 `methodology.json`（唯一事实源）；评估流程见 `core/evaluate.md`；评分门控见 `rules/scoring.md`；维度释义见 `references/dimensions.md`；售前视角见 `profiles/presales.md`。

## 适用场景（调用即自然语言）

- "用售前方法论评估这个商机的技术方案"
- "这个方案能不能支撑报价？还缺什么？"
- 商机进入 `quoted` / `contracted` 前的技术方案就绪度检查

## 评估流程（五步）

1. **取维度模板**：读 `methodology.json` 的 6 个维度。
2. **自动取数**：从 `CRM_DEAL`（requirements/pain/竞品）与 `CRM_TECHNICAL_PROPOSAL`（已有方案）自动评估；缺失证据向售前追问。
3. **逐项评分**（0–1）：S1 契合度 / S2 可行性 / S3 价值量化 / S4 风险异议 / S5 差异化 / S6 交付可信度。
4. **加权求分 + 门控**：`methodology_score`；任一 required 维度 <0.6 → `gate=FAIL`，**禁止推进至报价**。
5. **产出结论与下一步**：缺口清单 + 建议动作（触发 `crm-proposal-write` 补齐 / 排 POC 等）。

## 角色自适应

- **presales**：逐项自检清单"我还有哪维没填"（`profiles/presales.md`）。
- 其他角色（sales/manager/exec/contract-admin/finance）：本方法论仅售前直接驱动，其余角色经 crm-risk/决策网络间接引用。

## 调用示例

```
"用 method-presales 评估商机 DEAL-X 的技术方案"
→ 自动读 DEAL-X + 已有 PROPOSAL
→ 输出 { methodology_score, gate, dimensions[], gaps[], next_action }
→ gate=FAIL 时建议触发 crm-proposal-write 补齐缺口
```

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。