# 设计：信号出口播种 + 日历 ICS + 日期规则 + 既存红清账（2026-09-16）

> 状态：**待用户评审（P8）**｜设计输入：`docs/2026-09-16-four-module-claim-verification-audit.md`（P1/P2 建议）、
> `docs/2026-09-16-q1-export-acceptance.md`（R-A 阻塞项）、`docs/2026-09-16-full-chain-integration-design.md` v1.1（Q1 已交付）
> 承接智能体：`followup-agent`（契约键 `ct-followup`，源 `src/agent/contractIds.js`）
> ⚠ 边界：**不修改**并行会话已交付的 `src/signal/route.js` / `src/signal/dispatcher.js` / 定时器⑰ 装配

---

## §0 结论先行

四件事，其中一件是**阻塞级**：

| 线 | 事 | 为什么现在做 | 可证伪判据 |
|---|---|---|---|
| L1 | **出口配置播种**（R-A） | 全库零租户配置过 `signal-delivery` → 泵上线即**零投递空转**；434 条 open signal 永不触达 | `crm.signal_delivery` 由 **0 行** → 有 `sent` 行；`exportGate.isExportHealthy` 由 false → true |
| L2 | 日历 ICS 生成 + 随邮件投递 | 原主张「建立日历」当前 **0 实现** | 邮箱收到可被日历软件解析的 `.ics`；`GET /api/signals/:id/ics` 返回 `text/calendar` |
| L3 | 日期规则补 `report_due` / `tender_deadline` | 5 个日期维度只覆盖 3 个；且扫描器**缺前瞻语义** | 新规则在 mock 实体上命中并落 `crm.signal`；真库「规则就绪」直查证据 |
| L4 | 既存红清账（4 项） | 回归红污染判读；其中 `anysiteRest` 揭示一类**系统性假红** | 4 项各自转绿或明确标记为环境性；`file:///` 绝对路径清零 |

---

## §1 起点诊断（全部源码级 / 运行库实测锚点）

1. **R-A（阻塞）**：`config_store` 中 `signal-delivery` / `signal-dispatch` **零行**（含 `system`）；`crm.signal_delivery` **0 行**；`crm.signal` = 434 open。泵（定时器⑰ `timers.js:673`）会以 `idle.delivery_config_missing` 空转。
2. **判据A 精确谓词**（`signalMetrics.js:118-128`）：`SELECT channel, COUNT(*) ... GROUP BY channel` → 渠道**不在该集合（零行）**才告警。⇒ `email` 即便全落 `skipped`/`failed` 仍有行，**判据A 不触发**；`exportGate` 判据① 只要求窗口内存在 `sent` 行（由 `inbox` 提供）。**故「一律 email on」不会锁死回写闸门**（此结论已推翻设计早期版本的相反断言）。
3. **收件人数据面**：`crm.crm_users` 共 18 用户，**仅 1 个有 email 且为测试域名**，其余 `email = NULL` → 「无真收件人」是本地环境的**事实**，不得伪造。
4. **SMTP 契约**：`signal/delivery/email.js:11` 未配置 `SMTP_USER`+`SMTP_PASS` 即 fail-closed；本机两者**均未设置**。
5. **前瞻语义缺口**：`scheduleScanner.hitsRule`（`:8-21`）仅支持 `eq/ne` + `age ≥ threshold_days`（"已逾期"），**无"截止前 N 天"**。
6. **既存红四项**（本节为最终口径，取代审计报告 §8）：
   - `confirm-params-merge`：测试期望停在 `17c8faf`；生产已在 `7f3bea4` 把 `force` 移出协议位（决策注释见 `gateway.js:22-24`）。
   - `anysiteRest`：`src/db.js:8 dotenv.config()` 使 `.env` 的真 `ANY_SITE_KEY` 进入测试进程（实测探针 `envKey:true`）→「无凭据」场景不成立；适配器自身守卫 `anysite.js:101 if (!key) return []` **是正确的**。
   - `mcp-tenant` M1：单跑即红、**15,016ms** 打满超时（`1e8bb9a` 已放宽至 15s 仍无效）→ 登录链路真阻塞。
   - `graph-query`：单跑 3/3 绿；两次批量失败**集合不同** ⇒ 并发伪失败。
   - `test/signal/route.test.js`：已被并行会话补齐（16/16 绿），**非我方项，不碰**。

---

## §2 目标 / 非目标 / 硬约束

**目标**：让出口从「泵空转」变为「真投递可观测」；补上日历载体与两类日期规则；把既有回归红归因清零。

**非目标**：不改 `route.js`/`dispatcher.js` 语义；不新建表、不新增粒子类型；不实现 CalDAV/OAuth 直写外部日历（本批只出 `.ics`）；不做「招聘/新战略」外部情报接入。

**硬约束**：
- 零 DELETE；写操作过决策第 0 闸；阈值/渠道/收件人 **100% 配置化**（禁代码内字面量）。
- 播种 = 初始化语义：`WHERE NOT EXISTS`，**绝不覆盖运营配置**。
- **播种 ≠ 接通**：`email:'on'` 在无收件人/无 SMTP 时只产生 `skipped`/`failed` 流水，**不得对外叙述为"已送达"**。
- 收件人不得伪造：`role_recipients` 仅由 `crm.crm_users` 真邮箱聚合。

---

## §3 关键机制

### 3.1 播种内容（L1）
`db/migration-signal-delivery-config.sql`（对齐 `migration-lead-pool-config.sql` 范式：`SELECT ... '::jsonb ... WHERE NOT EXISTS`）：

```jsonc
// config_store['signal-delivery'] —— 逐租户（所有出现过的 tenant_id + 'system'）
{
  "channels": { "inbox": "on", "email": "on", "im": "off", "webhook": "off" }, // 裁决：email 一律 on
  "route": {},                              // 空 → 使用全部启用渠道
  "role_recipients": {},                    // 由 crm_users 真邮箱聚合；无 → {}（运行期落 no_recipient，可观测）
  "quiet_hours": null,                      // 不静默：避免验收期被 skipped 掩盖（运营可改）
  "rate_limit": { "per_hour": 100, "per_day": 500 },
  "retry": 0
}
// config_store['signal-dispatch']
{ "max_age_days": 7 }                       // D2 候选集窗口
```

`role_recipients` 生成方式：`SELECT jsonb_object_agg(role, jsonb_build_array(email)) FROM crm.crm_users WHERE email IS NOT NULL AND enabled`（按 `tenant_id` 分组）→ **本地库为空对象**（诚实反映"无真收件人"）。

### 3.2 ICS 生成与投递（L2）
- `buildIcs(signal)` 纯函数：`payload.event_at`（ISO8601）→ `VEVENT`，含 `UID`(=signal_id) / `SUMMARY` / `DESCRIPTION` / `DTSTART` / `DTEND`（缺省 +30min）/ 行折叠（75 字节）/ CRLF。
- 投递：`email.js` 在 `payload.event_at` 存在时挂 `.ics` 附件（`text/calendar; method=REQUEST`）。
- 下载：`GET /api/signals/:id/ics` → `Content-Type: text/calendar`（租户隔离：按 `resolveMe` 的 tenantId 过滤）。

### 3.3 前瞻语义扩展（L3）
`hitsRule` 新增：
- `condition.op: 'due_within_days'`：`0 ≤ (due − now) ≤ threshold_days`（取 `rule.ts_field` 显式声明，缺省回退链不变）。
- 保持既有 `age ≥` 语义**完全不变**（向后兼容；守卫测试须含"旧语义不回归"的负向对照）。
- `report_due` 为**周期型规则**（不绑粒子）：`entity_type: null` + `schedule_kind: 'periodic'`，由扫描器按 `weekday/hour` 产生个人级提醒信号（不读 `crm.particles`）。

### 3.4 既存红处置（L4）
| 项 | 处置 |
|---|---|
| `confirm-params-merge` | 更新断言（`force` 不再视为协议位）+ 注释锚定 `gateway.js:22-24`；**不改生产** |
| `anysiteRest` | 测试内 `vi.stubEnv('ANY_SITE_KEY','')` 并断言 **fetch 调用数为 0**（把"无凭据"变成可证伪前提） |
| `mcp-tenant` M1 | 归因登录链路阻塞（外部依赖 / DB 等待 / 串行），修因或明确标记环境性并提供复现命令 |
| `graph-query` | 按 `shared-db-test-hygiene` 检查隔离动作（是否漏删外键子表 / TRUNCATE 竞态），禁止以"重跑即绿"了结 |
| `file:///` ×2 | `test/monitor/syncMetrics.test.js` 相对路径化；`scripts/tmp-debug-engine.mjs` 删除或改相对 |

**新增判据（入长期记忆）**：凡断言「无凭据 / fail-closed 返回空」的测试，必须先隔离环境变量；`src/db.js` 的 `dotenv.config()` 会把 `.env` 真键注入测试进程，使该类测试**假红/假绿不可信**。

---

## §4 生命契约（双轨）

```contract-yaml
- task: "T-A1 播种 signal-delivery / signal-dispatch 两键（幂等 WHERE NOT EXISTS，email 一律 on）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "真库直查两键就位且复跑 0 新增；'system' 与全部既有租户各一行；不覆盖任何既有配置"
```
**契约说明：** T-A1 由 `followup-agent` 承接（契约键 `ct-followup`），须读 `followup-agent` 记忆（L1，≤2 跳）；成功标准为两键按租户就位、幂等可复跑、零覆盖。

```contract-yaml
- task: "T-A2 出口真投递验收：pump 一次后 signal_delivery 出现 sent 行且幂等"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "真库：pump 一次后 crm.signal_delivery 由 0 行变为按租户有 sent 行；二次 pump 不新增 sent；exportGate.isExportHealthy 由 false→true 且 checks 三项可解释"
```
**契约说明：** T-A2 由 `followup-agent` 承接，产出**可证伪的出口健康读数**（不是"面板红框消失"）；须同时记录 email 渠道的 `skipped/failed` 计数以佐证"未送达不假绿"。

```contract-yaml
- task: "T-B1 新增 src/signal/ics.js：signal → 标准 VEVENT（纯函数，零依赖）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定 payload.event_at 生成含 BEGIN:VCALENDAR/VEVENT/UID=signal_id/DTSTART/SUMMARY 的文本；缺 event_at 返回 null；跨时区与行折叠用例通过"
```
**契约说明：** T-B1 由 `followup-agent` 承接；成功标准为 ICS 结构合法、缺日期时**显式返回 null**（不造假日程）。

```contract-yaml
- task: "T-B2 email 挂 .ics 附件 + GET /api/signals/:id/ics 下载端点（租户隔离）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "带 event_at 的信号投递时邮件含 text/calendar 附件；无 event_at 时无附件；跨租户访问 /api/signals/:id/ics 返回 404/403 而非内容"
```
**契约说明：** T-B2 由 `followup-agent` 承接；成功标准含**跨租户拒绝**（隔离为硬判据，不以"能下载"替代）。

```contract-yaml
- task: "T-B3 scheduleScanner.hitsRule 扩 due_within_days 前瞻语义 + ts_field 显式声明"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "due 在未来 N 天内命中、超出不命中、已过期不命中；既有 age>=threshold 语义零回归（负向对照用例通过）"
```
**契约说明：** T-B3 由 `followup-agent` 承接；成功标准为**新语义正确 + 旧语义零回归**（两向断言，防"修新的、坏旧的"）。

```contract-yaml
- task: "T-B4 播种 tender_deadline / report_due 两类日期规则并提供「规则就绪」直查证据"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "signal-schedule 含两类规则且幂等；mock 实体上 tender_deadline 真实命中落 crm.signal；report_due 周期性产生个人级信号；真库「规则就绪」有直查输出"
```
**契约说明：** T-B4 由 `followup-agent` 承接；**规则就绪 ≠ 提醒已发**，成功标准要求模拟实体真命中，真库零命中时须显式标注数据面缺失原因。

```contract-yaml
- task: "T-C1 更新 confirm-params-merge 测试期望至 force 为业务参数（锚定 gateway.js:22-24）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "该测试 6/6 绿；且不改动任何生产代码（git diff 仅含 test/ 路径）；注释显式引用 7f3bea4 决策"
```
**契约说明：** T-C1 由 `followup-agent` 承接；成功标准含**零生产改动**（防"为了让测试绿而改生产语义"）。

```contract-yaml
- task: "T-C2 anysiteRest 测试隔离环境变量并断言零 fetch（去系统性假红）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "该测试 5/5 绿；「无凭据」用例断言 fetch 调用数为 0；变异验证：注入凭据后该用例必红"
```
**契约说明：** T-C2 由 `followup-agent` 承接；成功标准含**变异验证**（证明断言有鉴别力，而非恰好变绿）。

```contract-yaml
- task: "T-C3 mcp-tenant M1 超时归因并修复或明确标记环境性"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给出阻塞点定位（含耗时分布证据）；修复后单跑 < 3s 绿，或明确标记环境性并附可复现命令与失败读数"
```
**契约说明：** T-C3 由 `followup-agent` 承接；禁止"把超时阈值再放宽"了结——成功标准要求**定位阻塞点**。

```contract-yaml
- task: "T-C4 file:/// 绝对路径清零 + graph-query 并发伪失败按共享库卫生处置"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "grep -rl 'file:///D:/system' test/ 与 scripts/ 均为空；graph-query 在批量与单跑两种条件下均稳定；给出并发干扰证据（两次失败集合比对）"
```
**契约说明：** T-C4 由 `followup-agent` 承接；成功标准要求**批内稳定**（单跑绿不足以下结论）。

---

## §5 验收判据（可证伪）

| # | 判据 | 命令/查询 | 通过条件 |
|---|---|---|---|
| 1 | 两键落库 | `SELECT tenant_id,key FROM crm.config_store WHERE key IN ('signal-delivery','signal-dispatch')` | ≥ 2 行/键组合；复跑 migrate 后行数不变 |
| 2 | 出口真投递 | 触发 pump 后 `SELECT channel,status,count(*) FROM crm.signal_delivery GROUP BY 1,2` | `inbox/sent > 0`；`signal_delivery` 总行数由 0 → >0 |
| 3 | 幂等 | 二次 pump | `sent` 不新增 |
| 4 | 出口健康 | `createExportGate().isExportHealthy({tenantId})` | `healthy=true` 且 `checks` 三项为 true 可解释 |
| 5 | ICS 合法 | `buildIcs()` 单测 + 下载端点 | 文本含 `BEGIN:VCALENDAR`；缺 `event_at` 返 null |
| 6 | 前瞻语义 | `hitsRule` 双向用例 | 新语义命中正确 + 旧语义零回归 |
| 7 | 日期规则 | mock 实体 scan | `tender_deadline` 真命中落 `crm.signal` |
| 8 | 既存红 | 单跑四项 | 判据见 §3.4；`route.test.js` 不在我方范围 |

**反假绿要求**：不得以"面板无红框"作为通过依据（判据A 会在配置缺失时不触发，属**正确不判**而非"链路已通"）。

---

## §6 风险与缓解

| 风险 | 缓解 |
|---|---|
| `email:'on'` 在无收件人/SMTP 时产生大量 `failed`/`skipped` 流水，拉低 `delivery_success_rate` | 属**真实读数**，保留；运营补配置后自动真投递；在验收文档显式记录计数 |
| 播种覆盖运营已改配置 | `WHERE NOT EXISTS` + 按键判定；复跑幂等测试 |
| `report_due` 周期型规则需扫描器支持"不绑粒子"路径 | 若无粒子可查，则必须在 `scanOnce` 增加周期分支；本设计**将其列为实现期可证伪点**，不得以"配置已配"冒充 |
| 真库零命中被误读为"没做" | 交付物含「规则就绪 + mock 命中」双证据，并标注数据面缺失 |

---

## §7 闭环回写

| task | 期望调用 | 期望记忆 | 成功判据 | 状态 |
|---|---|---|---|---|
| T-A1 | data-particle-read | followup-agent | 两键就位且幂等 | 待执行 |
| T-A2 | data-particle-read | followup-agent | 出口有 sent 行且闸门转健康 | 待执行 |
| T-B1 | data-particle-read | followup-agent | ICS 结构合法/缺日期返 null | 待执行 |
| T-B2 | data-particle-read | followup-agent | 附件 + 跨租户拒绝 | 待执行 |
| T-B3 | data-particle-read | followup-agent | 新语义正确 + 旧语义零回归 | 待执行 |
| T-B4 | data-particle-read | followup-agent | 规则就绪 + mock 真命中 | 待执行 |
| T-C1 | data-particle-read | followup-agent | 测试绿且零生产改动 | 待执行 |
| T-C2 | data-particle-read | followup-agent | 零 fetch 断言 + 变异验证 | 待执行 |
| T-C3 | data-particle-read | followup-agent | 阻塞点定位（非放宽阈值） | 待执行 |
| T-C4 | data-particle-read | followup-agent | 绝对路径清零 + 批内稳定 | 待执行 |

> 反馈文件（若工作台产生）：`docs/2026-09-16-signal-export-calendar-design.feedback.json`；同一 `(task, gap_type)` 复发 ≥2 次 → 提 SKILL 改进提案（**须用户批准**）。
