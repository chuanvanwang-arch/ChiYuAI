# crm-query · 检索执行核心（core/retrieve.md）

## 四通道（按需组合）

1. **粒子图通道**：`data-particle-read` 取节点 → 出边 join 关联实体（客户/产品/方案/报价/回款）。
2. **多跳通道**：边链 2-3 跳（商机→客户→合同→回款），用 edges table 逐跳 join（决策网络 REFERENCED_PRECEDENT 同理）。
3. **语义通道**：pgvector 相似度（写时构建 embedding；`ORDER BY embedding <=> query_vec LIMIT N`）。
4. **决策网络通道**：decision 表 + REFERENCED_PRECEDENT 边（决策为何这么定的先例链）。

## 执行步骤（对一个查询意图）

1. **意图→通道选择**：商机/客户/回款/决策/语义 → 对应通道。
2. **主通道取数**：执行粒子/边查询（直连读放行）。
3. **结果结构化**：组装 `{ ok, data: { type, items[], summary } }`，业务语言字段（商机名/金额/阶段/赢率）。
4. **汇总**：返回摘要 + 可下钻的 items（前端/智能体消费）。

## 输出契约（机器可读 + 业务语言）

```
{ ok: true, data: { type: 'CRM_DEAL', items: [{ id, name, amount, stage, win_rate, owner }], summary: '…' } }
```

- 写操作不在本技能触发；如需写入（如「记一条新商机」）→ 转 `crm-write`。