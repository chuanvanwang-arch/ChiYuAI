# 线索导入（展会名片批量入池）测试场景设计

> **输入**：`https://mp.weixin.qq.com/s/Y3iOuhocY8hcYRHJ8wufyA`（林姑娘快跑 2026-08-25，《数博会47张名片签4单，80张名片0转化？销冠的5步法我全拆了》，基于 DSM 销售管理体系）
> **被测对象**：线索自主发现引擎（设计 `docs/2026-09-10-lead-discovery-design.md` v8.1，测试计划 `docs/2026-09-10-lead-discovery-test-plan.md`，实施计划 21 Task，当前已完成 T1–T4）
> **性质**：业务场景级测试设计（补充现有 T1–T21 的**单元/装配级**覆盖，补的是**端到端业务语义**）
> **日期**：2026-09-11
> **状态**：设计稿，待用户裁定后再落 Task 与测试文件

---

## §0 结论先行：文章场景暴露的 3 个真实缺口（P0）

现有测试计划 T1–T21 覆盖的是「**主动发现**（pull：外部数据源 → 候选池）」；文章讲的是「**被动批量导入**（push：300 张名片 → 分类 → 跟进）」。二者语义不同，代码级核实后暴露三个缺口：

| # | 缺口 | 代码事实（已核实） | 影响 |
|---|---|---|---|
| **G1** | **无批量导入通道** | `src/` 内 grep `multer\|multipart\|\.csv\|xlsx` 仅命中 `billingRoutes.js`/`server.js`/`billing.html`（账单线），**发现引擎零命中**；设计 v8.1 §3/§9 无 import 通道 | 文章核心动作「AI 名片整理 → 成表 → 同步 CRM」在引擎中**无入口**，S1/S2/S3 场景当前无法执行 |
| **G2** | **无离散四分类 + 「✕不用跟」语义** | 引擎只有连续评分 `icp_fit_score`/`intent_score`（`src/agent/discoverySchema.js`）；`discovery-rules` 有 `icp`/`signals` 但**无 `tiers` 分类阈值段**（`src/config/discoveryRules.js:11,28`）；grep `pending_review` **零命中** | 业务语言 ⭐△○✕ 无法表达；「放弃」与平台「禁 DELETE」铁律冲突点未定义 |
| **G3** | **字段缺失被当低分（误杀）** | BANT 闸 `bantcc.pass=0.6`（`src/sales/salesThresholds.js`，消费点 `src/action/seed-actions.js:438-439`）；展会现场**只采集 N/T/A 三条**，B/M/C 未知 | 六维中三缺 → 评分被拉低 → 线索被闸死。**这是最典型的假绿/误杀点**，现有 T10 未覆盖 |

> **建议**：G1/G2/G3 分别对应新增 Task **T22（批量导入通道）/ T23（四分类+✕语义）/ T24（BANT 缺失中性化）**，或先在 T7/T10 内以断言形式占位。本文场景按「缺口已补」编写，**每条场景标注当前可测性**。

---

## §1 文章要素 → 测试场景溯源

| 文章要素 | 业务语义 | 场景 |
|---|---|---|
| 展后 7 天行动清单（Day0/1-2/3-7/1月） | 分类后 SLA 节奏 | S13 / S14 / S15 |
| 四分类 ⭐商机 △目标 ○潜力 ✕凑热闹 | 离散分档 + 差异化动作 | S4 / S5 / S6 |
| 现场只问 N/T/A 三条，展后 1 月补齐六维 | 渐进补全 | S10 / S11 / S12 |
| 已知/未知分开标注，别自己脑补 | 诚实缺失、不伪造 | S2 / S3 |
| 300 张名片 → 80 家公司 | 批量 + 去重合并 | S1 / S7 / S8 / S9 |
| 客户池：有类型标记 + 下次动作 + 每周更新 | 池化运营状态机 | S5 / S12 / S14 |
| 用数据汇报（有效率/可转化金额） | 反馈指标 | S19（见 §4） |
| 客户跟不动就开发新客户（不反复凑量） | 反刷量护栏 | S15 |
| 早会/周会/月会三道关 | 分层节奏配置化 | S13 |

---

## §2 测试场景集（S1–S19）

> 统一约定：每条场景给出 **前置 / 动作 / fail-closed 断言 / 锚点 / 可测性**。断言必须「失败时有意义」——恒真断言（字段非空、`count>0`、无报错）一律判假绿。

### A 组 · 批量导入与解析

| 场景 | 内容 |
|---|---|
| **S1 批量分片导入** | **前置**：300 张名片记录（含 OCR 噪声），`discovery-rules.import.batch_size=20`。**动作**：触发批量导入。**断言**：① 批次大小 100% 来自配置（源码 grep 不得出现 `20`/`10` 字面量）；② 单条解析抛错**不中断整批**（`errors[]` 记录后继续，fail-open，参照 T2 断言⑤）；③ 部分失败时成功记录**仍落库**，且全部经决策第 0 闸（每批 `decision` 行数 ≥1）；④ 导入幂等：同批重复导入不产生重复记录（见 S9）。**锚点**：T2 `waterfall.js` fail-open 范式。**可测性**：🔴 缺 G1 通道 |
| **S2 已知/未知分离** | **前置**：名片缺「预算 B」「决策人 A」。**动作**：解析落 `CRM_ACCOUNT.payload.enrichment`。**断言**：① 未知字段 `value===null` 且**不落伪造值**（参照 T3 `emailVerify.js` 诚实 confidence 0.6，不伪称已验证）；② 未知字段**不得参与评分加权**（见 S10）；③ `enrichment.<f>` 六元齐（`value/provider/confidence/ts/layer/source`，T4 `src/agent/discoverySchema.js`）。**可测性**：🟡 T4 已覆盖六元，未知语义待 G3 |
| **S3 低置信入人工校对** | **前置**：OCR 电话字段 `confidence=0.55 < 阈值`。**动作**：导入。**断言**：① 该记录进校对队列（状态可配置，非硬编码字符串）；② 校对**前**不进入外联动作（HITL + 零信任闸）；③ 校对完成落 `decision_id`。**锚点**：grep `pending_review` 零命中 → 缺状态定义。**可测性**：🔴 缺 G2 |

### B 组 · 分类与评分

| 场景 | 内容 |
|---|---|
| **S4 四分类映射** | **前置**：`discovery-rules.tiers` 配置 ⭐/△/○/✕ 阈值。**动作**：对候选池评分分类。**断言**：① 分类结果 100% 由配置阈值推导（改阈值 → 分类随之变，**零代码改动**）；② 源码 grep 不得出现 `0.8`/`商机客户` 等业务字面量（配置驱动铁律）；③ 每条分类落 `judge{rule_ref,j_score}`。**锚点**：`src/config/discoveryRules.js:11,28`（icp/signals 已有，tiers 待补）。**可测性**：🔴 缺 G2 |
| **S5 「✕ 凑热闹」不删除** | **前置**：一条判定为 ✕ 的记录。**动作**：查询/后续运营。**断言**：① 记录**仍在库中**（`SELECT` 命中），**物理 DELETE 零调用**；② **不进跟进队列**、不生成 followup 任务、不触发外联；③ 可从 ✕ **升档**为 ○/△（信号变化时），升档留痕（append，不覆盖历史）。**说明**：这是「业务放弃」与「禁 DELETE」铁律的唯一自洽表达——**标记而非删除**。**可测性**：🔴 缺 G2（但断言②可复用 T16「不外发」范式） |
| **S6 同分异类可解释** | **前置**：两条 `intent_score` 相同的线索落入不同分类。**动作**：读取 glass-box。**断言**：`why_narrative` + `rule_ref` 能解释差异（如信号类型不同），与 P0#1 2D judge **同源结构**（T15 `test/agent/glassBox.test.js` 字段集一致）。**可测性**：🟡 依赖 T15 |

### C 组 · 去重与合并

| 场景 | 内容 |
|---|---|
| **S7 同公司多人名片** | **前置**：同一公司 3 张不同人名片（同域名）。**动作**：批量导入。**断言**：① 生成 **1 个** `CRM_ACCOUNT` + **3 个** `CRM_CONTACT`；② CONTACT→ACCOUNT 落 `auto_weak` 边（域名命中，`src/ontology/hooks.js:65`）；③ 联系人信息**不互相覆盖**（多人多岗，谁是决策人由 A 字段驱动，不取最后写入者）。**可测性**：🟡 依赖 T7（`duplicate_criteria` 已落 `discoveryRules.js:37`） |
| **S8 短串防误判** | **前置**：两家不同公司名均为 2 字简称（如「华为」「华工」）。**动作**：判重。**断言**：短于 `minLength`（设计 §3.2 =2）的串**不参与判重**，不得误合并。**可测性**：🟡 依赖 T7 |
| **S9 并发重复导入** | **前置**：同批 300 条并发两次导入。**动作**：并发执行。**断言**：① 唯一约束冲突 `23505` → catch 后重查赢家转 `update`，**不产生第二条**；② 全程零 DELETE；③ 两批次 `decision` 行均可追溯。**可测性**：🟡 依赖 T7（集成，需真实 PG `crm_native_test@5433`，连 `localhost` 非 `127.0.0.1`） |

### D 组 · 渐进补全与 BANT 闸（**最高价值组**）

| 场景 | 内容 |
|---|---|
| **S10 缺失 ≠ 低分（反误杀）** | **前置**：一条仅采集 N/T/A 三条（B/M/C 未知）的展会线索。**动作**：过 BANT 闸。**断言**：① 未采集维度按 **neutral（不计分）** 处理，而非 0 分；② 该线索**不得因字段缺失**被 `bantcc.pass=0.6` 闸死；③ 评分输出须区分「低分（已知且差）」与「未知（待补）」两种语义（前者可淘汰，后者必须进补全队列）。**锚点**：`src/action/seed-actions.js:438-439` + `src/sales/salesThresholds.js`。**可测性**：🔴 缺 G3 —— **建议最高优先级** |
| **S11 展后 1 月补齐六维** | **前置**：S10 线索在 30 天内分 3 次补字段。**动作**：每次补字段落 enrichment。**断言**：① 每次补全**带 `ts`/`provider`**，历史值不被覆盖（append-only 语义，与 C3 账户记忆同构）；② 补全触发 `lead-fit` 重评分（事件矩阵 `src/events/eventTrigger.js:15-26`）；③ 30 天窗口由配置驱动（`rhythm.*`），非硬编码。**可测性**：🟡 依赖 T6/T16 |
| **S12 分类升档可见** | **前置**：○ 潜力线索补齐 B（预算）后。**动作**：重评分。**断言**：① 分类由 ○ 升 △/⭐；② 升档原因在 `why_narrative` 中可读（`rule_ref` 指向被补字段）；③ 旧分类结论**仍保留**于记忆（不覆盖）。**可测性**：🟡 依赖 T15/T16 |

### E 组 · 跟进节奏与 7 天清单

| 场景 | 内容 |
|---|---|
| **S13 分类 → 频度配置化** | **前置**：`rhythm.target_days=30`（月）、`rhythm.potential_days=90`（季）。**动作**：生成跟进计划。**断言**：① 频度 100% 读取 `sales-thresholds.rhythm.*`（`src/sales/salesThresholds.js:136-137` 已有默认 30/90）；② 改配置即改节奏，**源码零硬编码「每月/每季」**；③ 不同租户可配不同节奏。**可测性**：🟢 **配置载体已存在，可立即测** |
| **S14 Day0–Day7 SLA** | **前置**：⭐ 商机线索 5 条。**动作**：导入后 48h 窗口。**断言**：① ⭐ 线索在 48h 内生成拜访邀约任务（超时进告警）；② 任务生成**走决策第 0 闸**（含 `decision_id`）；③ 绝不自动外发邮件（HITL，T16 断言⑤同构）。**可测性**：🟡 依赖 followup 链（`src/skills/seed.js:90` `crm-followup-schedule`） |
| **S15 防重复触达** | **前置**：同一线索 7 天内多次导入/刷新。**动作**：重复触发。**断言**：① 同类型跟进任务**幂等不重复生成**；② 不因反复刷新而「凑量」（文章：别反复拜访同几个老客户）。**可测性**：🟡 |

### F 组 · 平台红线与多租户

| 场景 | 内容 |
|---|---|
| **S16 多租户隔离** | **前置**：同一批名片导入 A（化工）/ B（医疗）两租户，ICP 不同。**动作**：分别分类。**断言**：① 两租户分类结果**可不同**（行业 ICP 生效）；② A 的配置不可见于 B（`src/config/discoveryRules.js:46-58` 浅合并语义：providers 以 id 覆盖、**不增删条数**）；③ `system` 租户导入写操作 400。**可测性**：🟢 T1 已覆盖配置隔离，补导入态 |
| **S17 付费源不被唤醒** | **前置**：批量导入 300 条（成本高敏）。**动作**：执行导入 + 富集。**断言**：① `calls[]` 日志中 Clearbit/LinkedIn 类 `enabled=false` 的 provider **零调用**；② 缺口富集**仅走 4 个系统默认源**（email-verify/web-research/标讯/高德）；③ 成本账本记录（T12 `discovery_cost_ledger`）。**可测性**：🟢 T2/T3 已覆盖注册表，补批量态 |
| **S18 红线复检** | **动作**：批量导入功能上线前后各跑一次。**断言**：① `git diff --stat -- src/particles/seed.js src/context/routing.js src/context/assembler.js` **为空**；② 新增导入代码纳入禁 DELETE 扫描（`DELETE FROM` / `.delete(` 零命中）；③ `assertAgentAssembly().ok===true`（若新增 import-* 动作，三处硬闭包同步）。**可测性**：🟢 可立即加为护栏测试 |
| **S19 汇报口径指标** | **前置**：一批导入完成。**动作**：读汇报指标。**断言**：① 有效信息收集率 / 分类分布 / 预计可转化金额**可算且分母明确**（空批次不除零）；② 指标落 feedback 7 要素模板（T12）；③ 指标随监控刷新更新（C3）。**可测性**：🟡 依赖 T12 |

---

## §3 关键断言参考实现（3 条最易假绿处）

**S10 缺失中性化（反误杀，P0）**
```js
// 展会线索：仅 N/T/A 已知，B/M/C 未采集
const lead = { payload: { bantcc: { N: 0.9, T: 0.8, A: 0.7 } } }; // 无 B/M/C
const s = scoreBantcc6(lead);
// ❌ 假绿：expect(s).toBeGreaterThan(0) —— 缺失被记 0 也会 >0
// ✅ 真断言：缺失维度不计分，等效于已知三维均值
expect(s).toBeCloseTo((0.9 + 0.8 + 0.7) / 3, 2);
expect(gateVerdict(lead, { pass: 0.6 }).reason).not.toBe('low_score'); // 是 incomplete 而非 low
```

**S5 「✕」不删除（禁 DELETE 语义）**
```js
await markAsCold(accountId);                       // 标 ✕
expect(await findAccount(accountId)).not.toBeNull(); // 仍在库
expect(await countFollowupTasks(accountId)).toBe(0); // 不进跟进队列
expect(await callLog('agent-mail')).toHaveLength(0); // 绝不外发
```

**S13 频度配置驱动**
```js
// 改配置而非改代码
await putConfig(tenantA, 'sales-thresholds', { rhythm: { target_days: 14 } });
expect(nextTouchDate(target, tenantA)).toBe(addDays(today, 14));
expect(nextTouchDate(target, tenantB)).toBe(addDays(today, 30)); // B 仍走默认 30
// 源码红线
expect(grepSrc(/每月|每季|30\b/)).toHaveLength(0);
```

---

## §4 覆盖映射：场景 → 现有 Task / 缺口

| 场景 | 现有 Task 覆盖 | 缺口 | 优先级 |
|---|---|---|---|
| S1 / S2 / S3 | ❌ 无 | **G1 批量导入通道** | P0 |
| S4 / S5 / S6 | 部分（T15 glass-box） | **G2 四分类 + ✕ 语义** | P0 |
| S10 / S11 / S12 | T10 未覆盖缺失语义 | **G3 缺失中性化** | **P0（最高）** |
| S7 / S8 / S9 | T7 `dedupResolver` | 补「同公司多人」业务形态 | P1 |
| S13 | `rhythm.*` 已存在 | 补断言即可 | P1（最快见效） |
| S14 / S15 | `crm-followup-schedule` | 补幂等与不外发 | P1 |
| S16 / S17 / S18 | T1 / T2 / T3 / §5 护栏 | 补导入态扫描 | P1 |
| S19 | T12 | 补分母/空批次 | P2 |

**建议新增 Task（待裁定）**
- **T22 批量导入通道**：分片配置化 + 单条失败 fail-open + 全批过第 0 闸 → 测 `test/connectors/discovery/bulkImport.test.js`
- **T23 四分类与 ✕ 语义**：`discovery-rules.tiers` 配置段 + 标记态（禁 DELETE）→ 测 `test/connectors/discovery/tiering.test.js`
- **T24 BANT 缺失中性化**：`scoreBantcc6` 区分 unknown/low + 补全队列 → 测 `test/sales/bantccIncomplete.test.js`

---

## §5 写后自查

| 检查项 | 结论 |
|---|---|
| 占位符 | ✅ 无 TODO/TBD |
| 矛盾 | ✅ 场景断言与平台铁律一致（✕ = 标记非删除；缺失 ≠ 低分） |
| 事实锚点 | ✅ 所有 file:line 均本次 grep/读取核实（`bantcc.pass` @ `seed-actions.js:438`；`rhythm` @ `salesThresholds.js:136-137`；`auto_weak` @ `hooks.js:65`；`tiers` 缺失 @ `discoveryRules.js:11,28`） |
| 未臆测 | ✅ G1（无导入通道）/ G2（无 pending_review）/ G3（缺失语义）三条缺口均为 grep 零命中实证，非推测 |
| 范围 | ✅ 仅设计测试场景，未改任何代码；未越界改设计文档 |
