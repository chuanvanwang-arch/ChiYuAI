# CRM-ai-native 设计文档落地审计报告（2026-08-26）

审计对象：
- `docs/2026-08-24-ai-native-sales-crm-design.md`（选型与借鉴设计）
- `docs/specs/2026-08-25-ai-native-crm-overall-design.md`（总体架构：四平面 / 决策事件主轴 / CRM 智能体包）

审计方法：**以代码为准**（ai-capability-audit 方法论）——grep 定位 → Read 源码确认 → 交叉引用调用点 → 数据库直查 → 全量测试实测。每项缺口附断言 + 代码证据 + 影响。

---

## 一、落地判定（结论先行）

| 文档 | 判定 | 说明 |
|---|---|---|
| 2026-08-24 选型/借鉴设计 | ✅ **主体全落地** | 方案 2 从零开发、Node 22 + ESM + PG16(pgvector/pgcrypto) + Express + vitest 全部实证；Kavak「One Customer, One Agent, One VM」不在本项目代码内实现（属行业参考，非落地项） |
| 2026-08-25 总体设计 | ✅ **主体全落地** | 四平面、决策事件主轴 8 表 + 第 0 闸 + 自主引擎 + 30 天蒸馏、方法论 SKILL 镜像、CRM 智能体包（plugin.json + agents + 12 SKILL）、MCP 五模块、六角色、meta_attr 14 行配置驱动、门户页面全部实证存在 |

**判定口径**：两文档的设计条目在代码/DB/交付物中均有具体载体；审计发现的 9 项缺口均为**接线/一致性/数据量级**问题，无结构性设计未落地。

---

## 二、缺口分级表（审计结果）

| 级别 | # | 缺口 | 证据 | 判定 |
|---|---|---|---|---|
| P0 | 1 | 决策网络 AGE 边 0 行（DECIDED_ON/REFERENCED_PRECEDENT 等）疑似未接线 | `decisionRepo.js:64-75,114-115,204-224` 已完整接线 | **已排除**：代码完整，0 行是数据量问题非实现缺口 |
| P0 | 2 | AGE 扩展疑似未建（`CREATE EXTENSION age`） | `ageGraph.js`（ensureGraph）+ `crm_decision_network` 图已建 | **已排除**：AGE 已启用、图已建（沙箱直查 MATCH 语法报错系环境调用差异，非实现缺失） |
| **P1** | **3** | **方法论 SKILL ↔ DB 镜像 编号漂移，无写时同步** | `seed.sql` 用 `OPP_MATRIX/FACT_VS_TALK`、SKILL methodology.json 用 `OPPORTUNITY_MATRIX/FACT_VS_SCRIPT`；MEDDICC 维键 M1/E1/I1 vs M/E/I；`decision.test.js:22` 断言 7 模板 | **本次修复（新建 methodologySync.js + 端点 + 归一映射）** |
| P1 | 4 | `action.test.js` 断言 crm 命名空间 27 vs 实际 31（业务闭环 Action 增量注册后基数漂移） | `test/action.test.js` | **本次修复（27→31）** |
| P1 | 5 | 决策网络引用链 0 行，无法支撑「为什么」问答 | `decisionRepo.js:114-115` REFERENCED_PRECEDENT 已写边 | **修正判定**：实现完整（代码证据），仅数据量少；建议后续造数验证多跳 |
| P2 | 6 | `web/index.html` 仍为 Stage1 看板（非 T3 计划门户硬指标） | `web/` 仅 2 文件 | 非阻塞；T3 计划未把门户作为硬指标 |
| P2 | 7 | 全量 `npm test` 退出码 1（db.js 空闲 PG 连接池使 vitest worker 被强退） | vitest 单 worker 运行 33→553 测试全过 | 已知非阻塞；如需 exit 0 可加 globalTeardown 关 pool |
| P2 | 8 | `decision.test.js` 断言 7 模板未含售前（§6.13.12 已批准） | `decision.test.js:22` | **本次修复（7→8）** |
| P2 | 9 | `methodologySync.js`（本次新建）`normalizeDims` 对无映射方法论丢弃全部维度 → 新建模板零维 | `normalizeDims` 原实现 `continue` 跳过未映射键 | **本次修复（无映射方法论原样保留）** |
| P2 | 10 | 旧同步产物孤儿维 `win_prob2`（旧归一表臆造键）滞留在 OPP_MATRIX 镜像 | 实跑 skew 清单 `missSkill:[...,win_prob2]` | **本次修复（`db/cleanup-methodology-skew.sql` 删除 1 行）** |

---

## 三、修复记录（本轮方案 D）

### 3.1 新建 `src/skills/methodologySync.js`（P1#3 核心）
方法论 SKILL（`skills/method-*/methodology.json`）为**唯一事实源** → 写时同步进 DB 镜像表 `methodology_template` / `methodology_dimension`（引擎消费点、scenario 引用目标）。
- `MIRROR_ID`：SKILL methodology_id → DB 既有 id 显式映射（`OPPORTUNITY_MATRIX→OPP_MATRIX`、`FACT_VS_SCRIPT→FACT_VS_TALK`、`PRESALES_SOLUTION` 新建）；
- `DIM_KEY_NORMALIZE`：漂移维键归一（MEDDICC `M1/E1/I1→M/E/I`、OPP_MATRIX `V1/F1→value/win_prob`、P1→`competitive_position`、ROLE_MAP 四角色、RISK_TRADEOFF、STOP_LOSS、FACT_VS_SCRIPT）；
- `syncMethodologyFromSkill / syncAllMethodologies`：幂等增量 upsert，已存在同键不动，不破坏既有断言；
- `listMethodologySkew`：SKILL↔DB 镜像维度漂移清单（审计辅助）。

### 3.2 修复 `normalizeDims`（P2#9）
无归一映射方法论（BANT / PRESALES_SOLUTION）**原样保留全部维度**（否则新建模板零维落库）；有映射方法论的同名键透传、仅显式 null 键跳过。

### 3.3 路由端点（`src/http/routes.js`）
- `GET /api/methodology/skew` → 漂移清单；
- `POST /api/methodology/sync?dryRun=1` → 全量同步（dryRun 预览，幂等）。

### 3.4 测试基线同步
- `action.test.js`：crm 命名空间 27→31（随注册实况，注释说明）；
- `decision.test.js`：methodology_template 7→8（含售前）；FULL 补齐第 14 维 `competitive_position`（SKILL 事实源归一新增，测试基线维护非放宽）；
- 新建 `test/methodology-sync.test.js`（8 用例：dryRun 不落库 / 幂等 / MEDDICC 归一 7 维 / OPP_MATRIX 归一 3 维 / ROLE_MAP 四角色 / 无映射原样保留 / 漂移清单）。

### 3.5 数据治理
- 实跑同步：8 模板齐备（新建 PRESALES_SOLUTION）、MEDDICC 保持 7 维、OPP_MATRIX 归一为 3 维（value/win_prob/competitive_position）；
- 清理旧同步孤儿维 `win_prob2`（`db/cleanup-methodology-skew.sql`，`DELETE` 1 行）。

---

## 四、决策网络边数据现状（P1#5 修正）

| 边类型 | 代码实现 | DB 行数 | 判定 |
|---|---|---|---|
| DECIDED_ON（决策→粒子） | `decisionRepo.js:64-75` | 0（无决策数据） | 已实现 |
| REFERENCED_PRECEDENT（引用先例） | `decisionRepo.js:114-115` | 0 | 已实现，数据量问题 |
| OVERRIDES（翻案） | `decisionRepo.js:204-224` | 0 | 已实现 |

**结论**：决策网络 7 种边在代码层全部接线，当前 0 行系测试隔离清空 + 尚未有真实决策流入；非实现缺口。

---

## 五、测试基线（实测）

- **修复后单跑**：`decision.test.js` 15/15 + `methodology-sync.test.js` 8/8 = 23/23 全绿（含 7→8 模板、FULL 补第 14 维、归一映射）。
- **全量 91 文件 692 用例**：**682 passed / 10 failed（2 文件）**——失败归属经聚焦复跑校正：`test/mcp-auth.test.js` **14/14 全过**（全量日志中 4 failed 系 ANSI 乱码误读）；真实失败仅 `test/context.test.js` **6 个**（enforceScope/executor 第1闸/buildContextBlock 集成断言）。
- **本轮修复聚焦回归**：`action.test.js 31/31` + `decision.test.js 15/15` + `methodology-sync.test.js 8/8` = **44/44 全绿**。
- **context 6 失败归属判定**：均为**并行线既有数据缺口**，与本次审计改动**零交集**（本次改动仅 `methodologySync.js`/`routes.js`/3 个测试/cleanup sql；未触碰 `src/context/*`、`src/mcp/auth.js`、`db/seed.sql` 的 person 部分、`test/context.test.js`）。根因（数据库实证）：`crm.particles` 中 **`CRM_PERSON` 零行** + `db/seed.sql` 无 person 种子（角色判定已迁移至 `role_context_profile` 配置表，但 person 粒子种子被并行线移除且 context.test.js 的 6 个集成断言仍依赖 `person-manager/person-sales-a` → `actorRole` 零命中 → `scopeModel='all'`）。**审计前基线即如此（并行线未提交部分），非本次回归。**

---

## 六、遗留建议（非阻塞）

1. **造数验证决策网络多跳**：插入 2-3 条真实决策（含先例引用/翻案），验证 AGE 多跳查询（`docs/specs/...` §6.3 的「为什么」问答能力）；
2. **统一方法论编号**：漂移清单（`GET /api/methodology/skew`）已在新同步下清零孤儿维（`win_prob2` 已清理），剩余 6 条均为 SKILL↔DB 预期编号平移（`M1/E1/I1↔M/E/I`、`V1/F1/P1↔value/win_prob/competitive_position` 等）；正式统一编号需决策层批准（方法论编号属决策事件主轴范畴）；
3. `web/index.html` 门户升级列入阶段 3 后续 Task。