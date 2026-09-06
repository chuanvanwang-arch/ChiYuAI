# 示例设计

```contract-yaml
- task: "实现 agent-workbench 监控卡"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/page/agent-workbench 返回 4 agent 装配状态且 SSE 刷新"
```
