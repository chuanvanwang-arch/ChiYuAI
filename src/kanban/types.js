// src/kanban/types.js — 03 编排设计常量：极简四态 + failure_limit=3 + 并发上限
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §03 编排设计

// 连续失败达到该阈值 → 任务进入 blocked(circuit_break)，需人工 reset 才复活
export const FAILURE_LIMIT = 3;

// 极简四态：ready → running → done | failed（failed 可重试）/ blocked（熔断）
// 扩展：awaiting_confirm（角色确认 / 敏感读 / 降级弹窗 挂点；§6.13 角色确认范式）
export const TASK_STATUSES = ['ready', 'running', 'done', 'failed', 'blocked', 'awaiting_confirm'];

// 派发队列并发上限：下游 LLM / 工具额度硬约束，超过则排队
export const MAX_INFLIGHT = 3;
