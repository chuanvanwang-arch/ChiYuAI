# crm-native · 子技能依赖图（references/dependencies.md）

## 技能依赖（惰性编排装载）

```
crm-native（编排入口）
├── crm-query   （跨模块推理查询：粒子图 + AGE 多跳 + pgvector + 决策网络）
├── crm-write   （对话式写入：两阶段 + 决策第0闸 + action-confirm）
├── crm-risk    （链断裂/异常检测：商机→技术方案>30天 / 赢单前无方案 / 回款逾期）
└── 7 个 method-* 方法论子技能（按意图路由加载）
    ├── method-bant（销售资质门）
    ├── method-meddicc（赢单把握）
    ├── method-opportunity-matrix（组合排序）
    ├── method-role-map（决策链拓扑）
    ├── method-risk-tradeoff（风险×收益）
    ├── method-stop-loss（止损退出门）
    └── method-fact-vs-script（事实vs话术）
```

## 平台能力（MCP 对外暴露）

- 读直连：data-particle-read / data-particle-attr-read / crm-field-permission / crm-account-360
- 写两阶段：业务写 Action（crm-deal-advance、crm-quote-*、crm-approval-* 等）→ phase1 取表单 → phase2 确认执行
- 绝对禁删：无 delete/remove 工具（安全红线）

## 数据面（决策事件主轴 §6 关联）

- 商机（CRM_DEAL）→ 技术方案（CRM_TECHNICAL_PROPOSAL）has_technical_proposal 受控边
- 商机阶段推进 → crm-deal-advance（只进不退、输单必填原因）
- 所有写操作强制 decision_id（第0闸：无决策不写）