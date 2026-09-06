# 夜间复盘「真实环境」根因分析与解决方案

- 日期：2026-09-05
- 触发：Task 11/12 全部 mock 验证，真实 PG + LLM 四类盲点（真实连接 / 索引命中 / 并发 / LLM 超时）未覆盖
- 方法：生产库 `crm_native` 只读取证 + 代码锚点 + EXPLAIN ANALYZE 实测（三重证据）
- 诊断工具：`scripts/retro-realenv-probe.mjs`（只读，本轮新建）

---

## §0 结论摘要（先行）

**原命题需要修正。** 夜间复盘**在真实 PG + 真实 LLM 上跑过**，且 LLM 链路是通的；但**凌晨 02:00 的自动跑批连续两晚产出为零**，用户所需的「每日整改报告 → ADMIN 待办」**在生产上从未兑现一次**。

根因不是"没跑过"，而是**两道串行闸门每道都近乎必然归零**：

| 编号 | 根因 | 性质 | 严重度 |
|---|---|---|---|
| **R1** | `MIN_SAMPLE=20` 硬编码，而真实日决策产量是个位数（9/3=23、9/4=2）→ 所有簇 <20，**一次 LLM 都不调用** | 业务假设错误 + 违反阈值配置化铁律 | **P0** |
| **R2** | 待办推送只认 `knob==='config_store'`，而真实 LLM 产出 14 条处方中 **0 条**是该 knob → 待办恒 0 | 闭环断裂 | **P0** |
| **R3** | 超时配置读 `decision-retro` 键，该键**在库中不存在**（实际键为 `retro-config`）→ 配置覆盖路径是死代码，恒走 180s 兜底 | 键名错配 | **P1** |
| **R4** | 复盘 5 条主查询中 4 条 Seq Scan（decision/tasks 无时间列索引） | 性能债（当前无害） | P1 |
| **R5** | 无全局 deadline；`attempts=2` 使单簇最坏 360s；跑批 INSERT 走读池 | 健壮性 | P2 |
| **R6** | §4.6 六步验证路径在真实数据下**第 2 步必然假失败**（样本不足） | 验证路径缺陷 | **P0（阻塞验证）** |

并发类盲点实测**风险最低**（7 连接 / 0 阻塞 / 0 长事务），不构成发布阻塞。

---

## §1 假设修正：真实环境到底跑过没有

`crm.decision_retro_report` 有 4 条记录，取 `summary` 与簇明细：

| run_at | scanned | llm_enabled | **llm_effective** | drafts | 判定 |
|---|---|---|---|---|---|
| 2026-09-05 02:00（自动） | 2 | true | **0** | **0** | ❌ 空转 |
| 2026-09-04 02:00（自动） | 23 | true | **0** | **0** | ❌ 空转 |
| 2026-09-03 09:10（人工） | 115 | true | **2** | **8** | ✅ 真实 LLM 生效 |
| 2026-09-03 09:03（人工） | 116 | true | **2** | **6** | ✅ 真实 LLM 生效 |

**簇级证据（决定性）**：

```
9/3 09:10  簇 OPP_QUALIFY    count=20  llm_used=true  conf=0.74  根因=INFO_INCOMPLETE  处方=5
           簇 LEAD_FOLLOW_UP count=22  llm_used=true  conf=0.73  根因=EDGE_MISSING     处方=3
           簇 QUOTE_PRICING  count=18  llm_used=false conf=0.3   根因=NEED_DIM_ORDER   处方=0   ← <20 未调 LLM
9/5 02:00  簇 LEAD_FOLLOW_UP count=1   llm_used=false conf=0.3   根因=NEED_DIM_ORDER   处方=0
           簇 PARTICLE_CREATE count=1  llm_used=false conf=0.3   根因=NEED_DIM_ORDER   处方=0
```

结论三条：

1. **真实 LLM 链路已被证实可用**——9/3 两次人工跑批 `llm_used=true`、置信度 0.68~0.84、共出 14 条处方。**"从未在真实 LLM 上跑过"不成立。**
2. **`llm_effective=0` 不是 LLM 故障**——是 `cluster.count < MIN_SAMPLE(20)` 在 `retro.js:197` 直接短路，**根本没到调 LLM 那一步**。
3. **`crm.calibration_patch` = 0 行**——待办从未生成过。

---

## §2 五层根因（证据 + 锚点）

### R1（P0）MIN_SAMPLE=20 与真实产量差一个数量级

**证据**——决策日产量（生产库实测）：

| 日期 | 2026-08-30 | 08-31 | 09-01 | 09-02 | 09-03 | 09-04 |
|---|---|---|---|---|---|---|
| decision 数 | 1 | 8 | 1 | **146** | 23 | **2** |

9/2 的 146 条为一次性批量导入（9/3 人工跑批恰好覆盖它）；此后进入真实业务量：**23 → 2**。

**锚点**：`src/calibration/constants.js:5` `export const MIN_SAMPLE = 20;` —— **硬编码**，未落 `config_store`，违反项目铁律「阈值配置化：config_store[] + 出厂兜底，禁硬编码」。全库 25 个配置键中**无任何 min_sample 项**（已实测）。

**影响**：日均个位数产量下，夜间复盘**永久空转**，`daily_ops` 照常出、`problems` 全是"样本不足"伪问题、`prescriptions` 恒空。

### R2（P0）待办过滤条件与 LLM 真实输出分布不匹配

**证据**——9/3 两次跑批共 14 条真实处方，knob 分布：

| knob | 条数 | 是否推待办 |
|---|---|---|
| `source_refresh` | 3 | ❌ 过滤 |
| `required_dims` | 4 | ❌ 过滤 |
| `edge_binding` | 4 | ❌ 过滤 |
| `particle_attr_add` | 2 | ❌ 过滤 |
| `threshold` | 1 | ❌ 过滤 |
| `meta_attr_map` | 1 | ❌ 过滤 |
| **`config_store`** | **0** | — |

**锚点**：`src/decision/retro.js:331` `for (const p of draftPatches.filter((x) => x.knob === 'config_store'))`。

**二次证据**：`RETRO_SYSTEM_PROMPT` L70 引导"若根因指向 config_store 旋钮，knob 用 'config_store'"，但实测 **14/14 条全部未服从**——说明该 prompt 引导力不足，不能作为闭环保障。

**影响**：即使 R1 修好、样本充足，待办仍为 0。用户的硬性需求「每晚整改报告自动推送 ADMIN 待办，批准即生效」**从未真正闭环**。

### R3（P1）超时配置是死代码（键名错配）

- `src/decision/retro.js:25` 读 `readConfig('decision-retro', …)`
- 生产库实测：`decision-retro` **不存在**；实际存在的是 `retro-config`（内容 `{"window_days":30,"required_for_tiers":["HIGH","LEAD"]}`，属**事件触发复盘**，非夜间批量）

**影响**：`llm_timeout_ms` 可覆盖路径从未生效，恒走 `RETRO_LLM_TIMEOUT_MS_FALLBACK = 180000`。同时 `config_store` 里没有夜间复盘的正式键 → 运维无法调参。

### R4（P1）4 条主查询 Seq Scan

EXPLAIN ANALYZE 实测（生产库）：

| 查询 | 计划 | 说明 |
|---|---|---|
| R1 retro 窗口扫描 `decision WHERE decided_at>=…` | ❌ Seq Scan | `width=2121` 宽行 `SELECT *` |
| R2 dailyOps decision 聚合 | ❌ Seq Scan | 无 `decided_at` 索引 |
| R3 dailyOps tasks 聚合 | ❌ Seq Scan | 无 `updated_at` 索引 |
| R4 dailyOps agent_sla | ✅ `ix_crm_agent_sla_measured` | 唯一有索引的 |
| R5 catchUp 探测 `ORDER BY run_at DESC LIMIT 1` | ❌ Seq Scan | 报告表无索引 |

当前数据量小（181/27/4）耗时均 <0.2ms，**不构成当前风险**，但随决策日积累线性劣化。

### R5（P2）健壮性缺口

- 无全局 deadline：单簇最坏 `180s × attempts(2) = 360s`，N 簇串行无上限
- `src/llm/client.js:112` `attempts=2`：失败后立即换配置重试；但生产**仅 1 条 LLM 配置** → round-robin 轮换失效（L49 注释宣称的"规避单 key 限流"在单配置下无效），实为同一 key 立即重试，可能加剧限流
- `src/decision/retro.js:353` 报告 INSERT 用 `query()`（= 读池 `poolRead`），写操作走读池，与读写双池设计不符

### R6（P0）§4.6 验证路径本身会产生假失败

原六步第 2 步「三段落非空」在当前真实数据下**必然失败**——不是功能缺陷，而是样本不足。若不前置样本准备，验证者会误判为代码 bug 或"LLM 挂了"。**验证路径必须先修正**（见 §4）。

---

## §3 解决方案

### R1 方案对比

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）配置化 + 窗口自适应** | ① `MIN_SAMPLE` 落 `config_store['decision-retro'].min_sample`，出厂兜底 20；② 24h 窗口样本 < min_sample 时自动扩展窗口至 `fallback_window_hours`（默认 168h=7d），报告标注 `window_extended:true` | 适应低产期；保留统计意义；符合阈值配置化铁律；不改默认行为（向后兼容） | 改造量中等；跨日聚合掩盖日内波动 |
| B 单纯调低阈值至 5 | 改一行常量 | 最小改动 | 小样本处方统计不可靠；"5 条决策改全局参数"存在治理风险 |
| C 维持 + 报告显式标注"样本不足" | 零改动 | 零风险 | 用户"每日整改报告"需求实质落空 |

**推荐 A**。理由：既解决空转，又保留"样本量足够才出处方"的治理强度；窗口扩展在报告里显式标注，可审计。

### R2 方案对比

| 方案 | 内容 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）knob 白名单 + 目标映射** | 待办条件扩展为白名单 `{config_store, threshold, required_dims, edge_binding, meta_attr_map, source_refresh, particle_attr_add}`；非 config_store 类映射到归属配置键（如 `threshold`→`sales-thresholds.<scenario>`、`required_dims`→`rubric-thresholds.<scenario>`） | 闭环真正打通；映射表可配置化 | 需维护映射表 |
| B prompt 强化 | SYSTEM_PROMPT 强制"至少 1 条 knob='config_store'" | 改动小 | 实测 14/14 未服从，LLM 不保证 |
| C A + B | A 为主、B 为辅提高 config_store 命中率 | 最稳 | 工作量最大 |

**推荐 A**（B 效果不可验证，不作为闭环保障）。映射表放 `config_store` 或常量表，不硬编码到业务分支。

### R3 方案

统一为**单一键 `decision-retro`**（与代码一致），并在配置中心登记该键（当前 25 键中无此项），承载：`llm_timeout_ms`、`min_sample`、`fallback_window_hours`、`global_deadline_ms`。`retro-config` 保持语义不变（事件触发复盘），不合并。

### R4 方案

幂等迁移补三个索引（DDL 进 `db/schema.sql` 单一事实源 + 增量迁移文件）：

```sql
CREATE INDEX IF NOT EXISTS idx_crm_decision_decided_at ON crm.decision (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_updated_at   ON crm.tasks (updated_at);
CREATE INDEX IF NOT EXISTS idx_crm_retro_report_run_at ON crm.decision_retro_report (run_at DESC);
```

同时把 R1 的 `SELECT *` 收敛为实际使用列（`decision` 宽行 2121 字节，只取 scenario_id/attribution/feedback/tenant_id/decider_type/confidence）。

### R5 方案

- 全局 deadline：`config_store['decision-retro'].global_deadline_ms`（默认 1800000 = 30min），超时则剩余簇直接降级并在 summary 标注
- 连续失败熔断：连续 2 簇 LLM 调用失败 → 后续簇不再调 LLM（`fail_fast`），避免 6 簇 ×360s 空等
- `retro.js:353` INSERT 改 `queryWrite`

### 优先级与工作量

| 序 | 项 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | R6 修正验证路径（含样本准备脚本） | P0 | 小 |
| 2 | R1 配置化 + 窗口自适应 | P0 | 中 |
| 3 | R2 knob 白名单 + 映射 | P0 | 中 |
| 4 | R3 键名统一 + 配置中心登记 | P1 | 小 |
| 5 | R4 索引 + SELECT 收敛 | P1 | 小 |
| 6 | R5 deadline / 熔断 / queryWrite | P2 | 中 |

---

## §4 修正后的发布前验证路径

**原 §4.6 六步的缺陷**：在当前真实数据下第 2 步必然假失败。修正为**先造样本、再验证**，且全程可脚本化。

### 步骤 0（新增）：真实环境体检（只读）

```powershell
$env:PGDATABASE="crm_native"; node scripts/retro-realenv-probe.mjs
```

判据：DB 连通、`llm_config` 默认可用 ≥1、无未授予锁、无超 30s 长事务。

### 步骤 1（新增）：样本准备（关键，原路径缺失）

真实日产量个位数，必须先把窗口内样本补足到 ≥ `min_sample`。两种选法：

- **1a（推荐，零污染）**：临时把统计窗口放到 7d —— 运行 `runDecisionRetro({ windowHours: 168 })`，真实数据、零写入
- **1b（造数）**：在**独立租户**下注入 ≥20 条同 scenario 决策，跑批后核验；**禁止**使用 `system` 租户或生产租户（N6 教训）

判据：`decisions_scanned ≥ 20` 且至少一个簇 `count ≥ min_sample`。

### 步骤 2：非 dryRun 真实跑批

```powershell
$env:PGDATABASE="crm_native"; node scripts/retro-once.mjs   # 或 runDecisionRetro({windowHours:168, dryRun:false})
```

判据（**修正后**）：
- `summary.llm_effective ≥ 1` ← 真吃到 LLM（原判据"三段落非空"过于宽松且易假失败）
- `rectification.daily_ops.decisions.total > 0`
- `rectification.prescriptions.length > 0`
- 若 `llm_effective = 0`：**先查簇 count 是否 < min_sample**，再查 LLM——按此顺序避免误判

### 步骤 3：待办生成（依赖 R2 修复）

判据：`crm.calibration_patch` 新增 PENDING 行，`assignee='ADMIN'`（system 租户）或 `'tan_admin'`（租户级）。
⚠ 未修 R2 前此步**必然为 0**，属已知缺陷，非验证失败。

### 步骤 4：`/api/admin/todos` 三角色可见性

- ADMIN：全量
- tan_admin：仅本租户（校验 `tenant_id` 过滤）
- sales：403

### 步骤 5：approvePatch 即生效

批准后即时读 `config_store`，校验目标键值已变为 `to_value`，且 `decision_id` 非 null。

### 步骤 6：rollback

校验值回写为 `from_value`（**不是删键**——禁 DELETE 铁律）。

### 步骤 7（新增，可选）：真实 LLM 单次连通

```powershell
$env:PGDATABASE="crm_native"; node scripts/retro-realenv-probe.mjs --live
```

消耗少量 token，确认 `getLlmJson` 返回函数且单次调用成功、打印耗时。

---

## §5 待批准改动清单

以下均**未实施**，待批准后按功能线分 commit：

| 功能线 | 文件 | 改动 |
|---|---|---|
| 阈值配置化 | `src/calibration/constants.js`、`src/decision/retro.js` | MIN_SAMPLE 配置化 + 窗口自适应 |
| 待办闭环 | `src/decision/retro.js:331` | knob 白名单 + 目标映射表 |
| 配置键 | `db/migrate.js` / 种子、`src/portal/configCenter.js` | 建 `decision-retro` 键并登记配置中心 |
| 索引 | `db/schema.sql` + 增量迁移 | 3 个索引 + `SELECT *` 收敛 |
| 健壮性 | `src/decision/retro.js`、`src/llm/client.js` | 全局 deadline、fail_fast 熔断、INSERT 改 queryWrite |
| 工具 | `scripts/retro-realenv-probe.mjs` | 已建（只读诊断，可先并入） |

**建议批准顺序**：1（R6+工具）→ 2（R1）→ 3（R2）→ 4/5（R3/R4/R5）。

R1/R2 修复后，建议**连续观察 3 个夜间周期**，确认 `llm_effective ≥ 1` 且 `calibration_patch` 有新增，再视为闭环成立。

---

# §6 实现状态（2026-09-05，用户裁决「全部一起修」）

五类盲点对应的 R1–R6 已全部实现并验证通过。

| 编号 | 修复 | 落点 | 验证 |
|---|---|---|---|
| R1 | `MIN_SAMPLE` 配置化（默认 20，可下调）+ 窗口自适应（24h 样本全不足→扩至 7d，报告标 `window_extended`/`effective_window_hours`） | `readRetroConfig()` + `runDecisionRetro()` 主循环；`RETRO_CONFIG_DEFAULTS` | `test/decision/retro-realenv.test.js` 17 例全绿 |
| R2 | 待办 knob 白名单（`APPLYABLE_KNOBS`）+ `config_store` 须 `键名.子键`、非 config_store 须非空 target；未知 knob/违规→`retro-todo-skipped` 留痕 | `runDecisionRetro()` 待办路由段 | 同上（5 例待办路由） |
| R3 | 统一配置键 `RETRO_CONFIG_KEY='decision-retro'`（原读不存在的键→恒走兜底死代码）；`readRetroConfig()` 合并出厂默认 + 脏配置 fail-safe；configCenter 登记 id43 + `/api/config/decision-retro` 写经第0闸+sysadmin | `src/decision/retro.js`、`src/portal/configCenter.js`、`src/http/routes.js` | 同上（4 例配置）；configCenter/permission 回归全绿 |
| R4 | `crm.decision.decided_at` / `crm.tasks.updated_at` 补幂等索引（run_at 索引已存在）；`SELECT *` 收敛为 6 具名列 | `db/schema.sql` + `loadWindowDecisions()` | 新库全链路 migrate 零跳过零失败 |
| R5 | 全局 deadline（`total_deadline_ms`，0=立即超期）+ 连续失败熔断（`llm_fail_circuit`）；熔断仅计「真实调用 LLM 且返回不可信」，**样本不足短路不计入**（否则低产日误熔断） | `runDecisionRetro()` 主循环 | 同上（3 例 deadline/熔断） |
| R6 | 验证脚本重写：Step0 只读体检 → Step1 样本准备（优先真实 7d / 不足注入独立租户**禁 system**）→ 判据改 `llm_effective>=1` → 固定排障顺序（先查 count<min_sample 再看 LLM）→ `--live` 真实调 LLM（默认 off，dryRun 不落库） | `scripts/e2e-retro-todo.mjs` | 默认模式冒烟全绿；`circuit_open=false` |

**验证汇总**：
- `test/decision/retro-realenv.test.js` 17 例 + `test/decision/retro.test.js` 7 例 = 24 全绿（R1/R2/R3/R5 逻辑 + dryRun 契约不破坏）。
- `test/portal/configCenter.test.js` + `test/propagation/permission.test.js` + `test/calibration/*` 19 文件 154 例全绿（R2/R3 无副作用）。
- 新库 `crm_native_e2e` 全链路 `migrate.js` 零跳过零失败（R4 索引 + N2/N3/N5 完全兼容）。

**§7 发布前收尾（用户裁决「全部一起修」后追加）**：
1. **预置种子**：`config_store['decision-retro']` 已按出厂默认值写入 `db/migrate.js` 种子块（`WHERE NOT EXISTS` 幂等，与 `retro-config` 同款），并直写 `crm_native`/`crm_native_test` 两库（updated_by='seed'）。readRetroConfig 现读到显式行，页面可可视化编辑。
2. **配置页**：`src/web/nightly-retro-config.html` 已建（镜像 `event-retro-config.html` 范式，编辑 6 字段：min_sample / llm 超时(秒) / 扩窗开关+上限 / 总时长预算(秒) / 熔断阈值），`routes.js` 注册 `/nightly-retro-config.html`（置于 event-retro 路由之后）；configCenter id43 已含 `page`/`endpoint`。
3. **R6 `--live` 真实验收**（生产库 `crm_native`，dryRun 不落库，消耗少量 token）：
   - 首跑：`llm_enabled=true`、`llm_effective=3`、`circuit_open=true` → 连通确认通过，但暴露**R5 熔断误判缺陷**（见下）。
   - **R5 熔断误判（新缺陷，2026-09-05 复跑暴露）**：熔断判据用了 `a.llm_used`，但 `analyzeCluster` 返回对象**无此字段**（仅 `entry` 有）→ 恒 undefined → 每个「合格且调了 LLM」的簇都被计为失败，连续 3 即熔断。后果：合格簇 >3 时夜批被错误掐断 LLM（此前 9/3 仅 2 合格簇故未暴露）。修复：`ok = !a.degraded`（LLM 被调且返回可信=非降级）。
   - 修复后复跑：`llm_effective=6`（3→6）、`drafts=16`（8→16）、`circuit_open=false`、全绿。新增回归测试「合格簇>阈值且 LLM 可信→不误熔断」锁死。
4. **验证脚本断言修正**：原 `window_extended` 断言 `WIN===168 && n24<min_sample` 错误（168h 起步无可扩展，应为 false）；改为 `WIN===24 && n24<min_sample`。

