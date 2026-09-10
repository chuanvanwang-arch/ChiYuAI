# U3 rrfSearch 接线 / U4 记忆页放开 · 独立评审方案

> 评审对象：CRM-ai-native 记忆系统两项延期项（性能面 + 权限面变更）
> 关联修复：2026-09-10 记忆回写修复 P0–P2（已真实验证，692 全绿 + E2E 通过）
> 评审结论前置：**两项均不阻塞已交付的回写修复；当前均为 fail-closed 安全态；放开须经本评审拍板。**

---

## 一、U3 — rrfSearch 接线

### 1.1 当前真实状态（已源码核实）
- `src/memory/memoryLog.js:126` `rrfSearch(queryText, {entityId,k,denseWeight,tenantId})` **是全仓唯一定义、零调用**的真死代码（grep `rrfSearch|rrf_*` 仅命中本函数及注释）。
- 实际活跃召回路径：`retrieveMemory`(`memoryLog.js:93`) → `assembler.js:112`（`retrieveL2` 第三参 `tenantId`，U1 已修）。该路径为 **`LIKE topic` 关键词查询 + `tenant_id` 过滤**，已可用、已按租户隔离。
- `rrfSearch` 内部用 `hashVector`(基线 hash，**非真 embedding**，见 `embeddingClient.js:4` 注释) 做 dense 余弦 + LIKE 做 sparse，RRF 融合。即：即便接线，也是 **hash 级语义**，区分度有限。

### 1.2 选项与权衡
| 选项 | 做法 | 收益 | 成本/风险 | 建议 |
|---|---|---|---|---|
| **A. 删除死代码** | 移除 `rrfSearch` + G6 注释 | 消除误导、零风险 | 无 | **推荐**（低 ROI 时首选） |
| **B. 接线为辅助召回** | `retrieveL2` 内以 rrfSearch 作补充排序信号，与 retrieveMemory 合并 | 略增召回多样性 | 每查询多算 N(≤200) 个 hash 向量；hash 余弦区分度低，可能引入噪声 | 候选增强，需量化 |
| **C. 真 embedding RRF 再接线** | 先接 `ontology/embedding.js` 真向量（需 `EMBEDDING_PROVIDER`），实现 dense+sparse RRF | 真语义召回 | 工作量最大、依赖外部 provider、每次查询 N×embedding 推理成本最高 | 业务确需语义召回时走此，独立评估 provider 成本 |

### 1.3 性能面（评审重点）
- B/C 每次记忆查询额外 `N × embedding 计算`（N = 候选行数，rrfSearch 上限 200）。
- 当前 `retrieveMemory` 是单条 `LIKE` + 索引查询，开销可忽略。**接线会直接放大热路径成本**，须在评审中给出压测口径（QPS × 平均候选数）。
- 权限面：无变化（rrfSearch 已复用 `tenant_id` 过滤，无跨租户风险）。

### 1.4 推荐与回滚
- **默认推荐 A**（死代码即删）。若业务明确要求语义召回，走 C（而非 B，因 B 的 hash 收益不抵成本），并单独评估 provider 费用。
- 回滚：A 直接 `git revert`；B/C 用 `config_store['memory-rrf']` 开关 fail-open 包裹，关即退回 `retrieveMemory`。

---

## 二、U4 — 记忆页放开（sysadmin/admin-only）

### 2.1 当前真实状态（已源码核实）
- 后端硬闸：`GET /api/memory`(`memoryConfig.js:64`) 与 `POST /api/memory/distill`(`memoryConfig.js:75`) 均 `if (!me?.ok || me.role !== 'admin') return forbid(res)` → **403**。
- 前端已处理降级：`memory.html:48` 区分「权限不足」与「真故障」，renderMemory(`systemOverviewM.js:18`) 显示「仅管理员可访问」+ 回退到 `sales-decision-monitor.html` 记忆闭环段。
- **决定性风险点**：四个 list 查询（`memoryConfig.js:23-38`）**全部全局无 `tenant_id` 过滤**：
  - `listLogs`：`FROM crm.memory_log WHERE archived=false`
  - `listNotes` / `listSnapshots` / `listPrecedents`：均无租户条件
- admin 跨租户可见是 by-design（admin 受信任、scopeTenant 返回 `*`）。**一旦放开角色闸但不加租户隔离，非 admin 将看到其他租户记忆 → 跨租户泄漏。**

### 2.2 选项与权衡
| 选项 | 做法 | 收益 | 风险 | 建议 |
|---|---|---|---|---|
| **A. 维持 admin-only** | 现状不变 | fail-closed 安全；non-admin 经决策监控台看记忆闭环 | 无 | **默认推荐**（除非业务强需求） |
| **B. 放开到 tan_admin + 强制租户隔离** | 角色闸放宽为 `tan_admin`；四个查询注入 `me.tenantId` 过滤（precedents 经 `decision.tenant_id` 关联） | 本租户管理员可看本租户记忆 | 需逐查询审计 + `me.tenantId` 可靠性保障 | 若放开，只走此 |
| **C. 放开到 manager/sales** | 更广角色 + 实体/租户双重隔离 | 一线可见 | 数据面改动大、隔离面过宽、泄漏风险高 | **不推荐** |

### 2.3 权限面（评审重点）
- 后端双重改：① 角色闸放宽；② **四个查询必须加 `tenant_id` 隔离**（precedents 经 `decision_precedent_rel → decision.tenant_id`）。
- 必须配套回归：用租户 A 凭据请求 `/api/memory`，断言响应中不含租户 B 的 `topic/payload`。
- 前端 `memory.html` 的「权限不足」分支改为按新角色渲染（或保留 fallback）。

### 2.4 推荐与回滚
- **默认 A**。若业务确需，走 **B**（tan_admin + 强制租户隔离），配套跨租户泄漏回归测试。
- 回滚：角色闸改回 `!=='admin'` 即复原；租户过滤为纯加 `WHERE`，可 `git revert`。

---

## 三、评审待拍板项
1. U3：选 A（删死代码）/ B（辅助召回）/ C（真 embedding）？默认 **A**。
2. U4：维持 A / 放开 B？默认 **A**；若放开，B 的租户隔离 scope 是否含 precedents 全量。
3. 性能量化口径（U3 B/C）：是否需先压测再决定。
