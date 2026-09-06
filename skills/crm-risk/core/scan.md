# crm-risk · 扫描执行核心（core/scan.md）

> 设计输入：§3.10 五类告警 + §6.10 写时向量化 + 决策主轴 §6（探测结果入决策网络）。

## 扫描步骤（runRiskScan，scheduler 30min 周期）

1. **选型**：CRM_DEAL / CRM_ACCOUNT / CRM_CONTACT（商机链）+ 合同/回款粒子（回款链）。
2. **全量重算 AI 属性**：对每个粒子用 `evaluateAiAttributesFor` 重算 ai 属性（差异检测：内容未变不重写，幂等）。
3. **链断裂判定**（三模式）：
   - 商机→方案>30天：DEAL 有 `has_technical_proposal` 出边？无且 stage≥S2 且 `now - updated_at > 30天` → 命中。
   - 赢单前无方案：DEAL.stage=S6 且无方案边 → 命中。
   - 回款逾期：合同应收日期 < now - 账期 且无回款粒子关联 → 命中。
   - 止损触发：DEAL.payload.stop_loss?.status === 'triggered' → 命中 `stop_loss_triggered`（决策 stop_loss 经 decisionRepo 镜像到粒子 payload，设计 Task 2/3）。
4. **差异写入**：ai 属性变化时 `updateParticle(id, { patch: { ai } })`（JSON 差异，不幂等重复写）。
5. **emit 预警**：命中 → `emit('crm-risk-scan', { alerts, summary })`（SSE 推送）。

## 输出契约

```
{ ok: true, scanned: n, alerts: [{ type, deal_id, age_days, severity }], summary }
```

- `dryRun: true` 时不写（仅扫描+统计）；默认 dryRun=false 时差异写。
- 失败 → `emit('crm-risk-scan-failed', { error })` + monitor.recordFailure（可观测性，G3）。