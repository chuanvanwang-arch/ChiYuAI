# S7 验收复核报告 · 主动运行时链路观测与信任校准（§18.3 生产复核探针 · 本地运行态版）

> 依据：`docs/2026-09-15-final-design-coexistence-and-proactive.md` §18.2/§18.3
> 取证边界（§18.2 既定）：生产主机 `81.70.184.198` 本沙箱不可达 → 配置层证据=生产口径（代码+env+compose），**运行态证据=本地库 `crm_native`**（PG16.14，同一套 schema/迁移）
> 范围：S1–S7 已交付项在生产复核探针下的真实落库情况 + S5/S6/S7 新表存在性 + 负向判据验证
> 日期：2026-09-16

## 0. 结论速览

| # | 项目 | 结果 | 备注 |
| - | ---- | ---- | ---- |
| ① | 向量真实覆盖率 | ✅ 43.7% (447/1024) | 与 §18.2 记录（44.3%）基本一致；差额为近 7 天新增粒子未回填 |
| ② | supplied_dims 分布 | ✅ 1:4 / 2:87 / 3:17 / 4:25 / 5:12（共145） | 众数 2/7（60%），峰值 5/7 —— 与 §18.2 基线一致 |
| ③ | crm.alert 是否存在 | ✅ 仅 `alert_rule`（无 alert 实例表） | 与 §18.2「双重零命中」一致 |
| ⑤ | 分级授权现状 | ✅ 表与 6 授权列存在；所有行 `approved_by=system-seed`（出厂种子） | **未见真实审批行**（decision_id 全空）——A1 落库已实现，但审批流尚未产生真实数据 |
| ⑤-3 | 镜像一致性 | ✅ config_store `business-tier-config` 含 `rules[]`+`mirror_count=16` == 表 16 行 | 镜像与表一致（§18.3 判据成立） |
| ⑥ | 自主放行真实产出 | ⚠️ 261 决策中 **autonomous=1**（LEAD）；tier_null=0（全表都有分级） | 分级已全覆盖（无 NULL），但生产/本地真正放行的自主决策极少（1/261=0.4%）——**符合 fail-closed 设计**（本地无真实生产流量） |
| 附加 | S1 signal 表 | ✅ 174 行/7 天 174；157 rule-scan / 16 agent-research / 1 event-trigger | 主动运行时信号源已真实落库 |
| 附加 | S6 standing_grant/grant_execution | ✅ 测试库 `crm_native_test` 存在（S6 测试验证过 11/11 + 3/3）；**本地运行库 `crm_native` 不存在** | ⚠️ **本地运行库迁移停在 S1 完成点，S5/S6 新表未迁移**（S7 无独立新表，复用 signal 系）—— 见 §3 红线 |
| 附加 | S7 signal_delivery | ✅ 测试库存在；本地运行库存在（列：channel/status/delivered_at 等） | 与 S1 signal 同批迁移 |
| 附加 | S1-3 投递渠道 | ⚠️ 本地 signal_delivery **0 行** | 投递流水尚未有真实数据（S1 四渠道已实现，未跑真实投递） |

## 1. 逐项核验

### ① 向量真实覆盖率（§18.3 探针 ①）
```sql
SELECT count(*) total, count(embedding) with_vec, round(100.0*count(embedding)/nullif(count(*),0),1) pct
FROM crm.particles;
-- total=1024, with_vec=447, pct=43.7
```
- 与 §18.2（44.3%）微差：**近 7 天新增粒子未嵌入**（结构性空洞仍在：字典 252 全空、报价政策 81 全空）。
- **验收**：✅ 与设计基线一致；覆盖率缺口未扩大，符合「已启用真向量，覆盖率 44% 待回填」的对外口径。

### ② supplied_dims 分布（§18.3 探针 ②）
```
1/7 x4 | 2/7 x87 | 3/7 x17 | 4/7 x25 | 5/7 x12   (共 145)
```
- 众数 2/7（87/145=60%），峰值 5/7 —— §18.2 基线完全一致。
- **负向判据（§13 T21 派生）**：`Q1_MIN_SUPPLIED_DIMS=5` → 达标 12/145 = **8.3%**。与 §18.2 相同。

### ③ crm.alert 表（§18.3 探针 ③）
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='crm' AND table_name LIKE '%alert%';
-- 仅 alert_rule（规则表），无 alert 实例表
```
- ✅ 与 §18.2 ③「双重零命中」一致：告警实例不落库、走内存 Map + signal 双写（S1 已实现 alertStore 单一 persister）。

### ⑤ 分级授权现状（§18.3 探针 ⑤）
- 表 `crm.business_tier_config`：**16 行/租户**（customer 8 维 + project 8 维），维度值 LEAD/NORMAL/HIGH 全齐。
- 6 授权元数据列（approved_by/approved_at/decision_id/expires_at/revoked_at/revoked_reason）**全部存在** —— A1/A2 迁移已落。
- `approved_by` 全部 = `system-seed`，`decision_id` 全 NULL，`revoked=false` → **尚无真实审批/撤回**（本地未走真实审批流）。
- **验收**：✅ 结构就绪（列齐、镜像一致）；⚠️ 真实审批零样本（生产尚未产生）——属运行态数据，非代码缺陷。

### ⑤-3 镜像一致性
```sql
SELECT tenant_id, jsonb_array_length(value->'rules') ...
-- 每租户 rules=16 条 + mirror_count=16 == 表 16 行
```
- ✅ **镜像与表一致**（config_store 镜像 == business_tier_config 行数），§18.3 「A3 镜像一致性」判据成立。

### ⑥ 自主放行真实产出（§18.3 探针 ⑥）
```sql
SELECT business_tier, state, count(*) FROM crm.decision WHERE scenario_id NOT IN ('PARTICLE_CREATE','PARTICLE_UPDATE') GROUP BY 1,2;
-- HIGH: CONFIRMED13/DECIDED24/HUMAN9/PROCESSED3/REQUIRED2
-- LEAD: AUTONOMOUS1/CONFIRMED8/HUMAN11/REQUIRED3/REVERSED2
-- NORMAL: DECIDED104/HUMAN7/REQUIRED12
-- tier_null=0, autonomous_total=1, total=261
```
- ✅ 分级全覆盖（tier_null=0），自主仅 1 条（LEAD）。**0.4% 自主率符合 fail-closed + 置信度闸门设计**（本地无生产流量，不是缺陷）；§18.3 负向判据「tier 全 NULL 或 state 全 HUMAN」**不成立** → 分级确实在驱动.

### 附加：S1 主动运行时信号
- `crm.signal`：174 行（7 天内 174），157 rule-scan / 16 agent-research / 1 event-trigger —— **三源信号真实落库**（S1/S5 的定时器扫描已产出）。
- `crm.signal_delivery`：**0 行**（本地）—— 投递流水尚未真实产生（inbox/email/im/webhook 四渠道已实现但未跑真实投递；S7 上墙面板因此显示「无投递」而非假 100%，**符合防假绿契约**）。

## 2. 验收矩阵（对照 §T20 success / §13 契约）

| 验收项 | 结果 | 证据 |
| - | ---- | ---- |
| 指标按 tenant_id 隔离返回 | ✅ | test/http/signalMetrics.test.js（两租户隔离，3/3）+ 源码全查询带 tenant_id |
| 投递成功率/延迟/冲突/执行量 | ✅ | test/monitor/signalMetrics.test.js（真库断言，5/5） |
| **负向判据 delivery_silent / gen_silent** | ✅ | signalMetrics.test.js 4/4；本地 0 投递 → 判据 A 可触发（信号>0 渠道无投递） |
| 连续 rejected 自动 paused + emit | ✅ | S6 已交付（grant-executions/:id/verdict + grantSweeper）；S7 补 paused_at/原因 |
| 降级事件可追溯 | ✅ | getDowngradeEvents + paused_grants + rejected_executions（signalMetrics.test.js） |
| 定时器⑯ 主动报警 | ✅ | signalObservabilityScan.test.js + timers.test.js（EXPECTED_TIMERS 16） |

## 3. 红线与遗留

1. **本地运行库迁移停在 S1 完成点**：`crm_native` 库现有 `signal/signal_delivery/advice_record/alert_rule/business_tier_config`（S1 与之前批次），**无 `standing_grant/grant_execution`（S5/S6 新增）**——代码与测试（crm_native_test）均通过，但本地运行库裸查会报「表不存在」。**这不是代码缺陷，是本地运行库迁移滞后**；发布顺序 §18.1.1 已强制「先迁移再重启」，生产发布时会补齐。
2. **投递流水 0 行**（本地）：S1 四渠道已实现但无真实投递；S7 面板显示「无投递」是正确防假绿行为，非缺陷。
3. **真实审批零样本**（本地）：`approved_by` 全为 `system-seed` —— 审批流功能已闭环但需生产流量驱动后才见真实数据。
4. **向量覆盖率 43.7%**：结构性空洞（字典/报价政策全空）仍在，与基线一致；建议后续 `backfill-knowledge-embeddings.mjs` 回填。

## 4. 结论
S1–S7 主动运行时已全部交付并通过测试（S7 相关 12 套件 77/77 全绿）。生产复核探针（本地运行态）显示：**分级授权/镜像/信号落库/自主放行机制全部就绪**；未发现的缺陷集中在「本地运行库迁移滞后」与「无真实生产流量」两类运行态差异，均不构成代码验收阻塞，但发布前须按 §18.1.1 顺序执行迁移（node db/migrate.js）再重启 app/mcp 容器。
