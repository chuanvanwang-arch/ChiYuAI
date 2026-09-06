# crm-query · 访问规则（rules/access.md）

## 读直连（默认放行）

- 读查询不经过写闸（第0闸只拦写）；无 decision_id 也可读。
- 凭证降级：无 token → sales + 只读（保留查询能力）。

## 数据范围（scope）

- 默认 `all`（平台 read 直连系统租户）；若配置了 role scope（self/org_subtree/domain），按 scope 过滤。
- 聚合查询（回款/合同）仅返回汇总，不暴露内部审计明细（如需明细 → 有权限角色再下钻）。

## 绝对禁删 / 改

- 本技能**只读**：不提供 delete/update 工具。用户请求「删除某商机/改某记录」→ 明确拒绝并引导 `crm-write`（写需两阶段+决策闸）。
- 不绕过 Action Registry：所有读也走 `data-particle-read`（统一入口，不手写 SQL 捷径）。