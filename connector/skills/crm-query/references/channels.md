# crm-query · 检索通道说明（references/channels.md）

## 四通道对比

| 通道 | 用途 | 依赖 | 典型查询 |
|---|---|---|---|
| 粒子图 | 节点+出边（关联实体） | particles + edges 表 | 商机详情/客户360 |
| AGE 多跳 | 边链 2-3 跳（递归） | edges 表 JOIN | 商机→客户→合同→回款 |
| pgvector | 语义相似 | embeddings 表 | 相似商机/相似客户 |
| 决策网络 | 先例链（REFERENCED_PRECEDENT 多跳） | decisions + edges | 为什么这么定 |

## 与决策事件主轴（§6）衔接

- 决策网络通道可回答「为什么这个商机这么判」——decision 记录 REFERENCED_PRECEDENT 引用，形成可追溯先例链。
- 查询侧只读，不产生决策（决策由写通道/编排产生）。