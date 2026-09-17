# 四需求实现状态核查（2026-09-18）

> 取证方式：源码级锚点 + 现网 HTTP 实测（localhost:3000，alice/sales 真实登录）+ 数据库实证（crm_native，76 张表 / 50 个配置键）
> 判定口径三级：**L1 代码就绪**（源码接线到生产装配）→ **L2 数据产出**（库中非 0 真实产出）→ **L3 用户可用**（登录后从主导航可达并端到端可用）

## 总表

| 需求 | L1 代码 | L2 数据 | L3 可用 | 判定 |
|---|---|---|---|---|
| ① 拓客（补齐/筛选/认领回退） | ✅ | ⚠️ 公海 12 条；**候选池 0**；**富集 0 命中** | ✅ | **部分实现** |
| ② 打通邮箱/日历/会议/微信 + 图谱 | ✅ | ❌ **全库零通道配置、零凭据、零事件** | ⚠️ 有入口无数据 | **未实现（空壳）** |
| ③ 日期驱动（自动运行+推送+日历） | ✅ | ⚠️ 信号 1591、inbox sent 1265；**email/im 零外发** | ✅ | **大部分实现** |
| ④ 原 CRM 集成（抽取/增量/MCP回写） | ✅ | ⚠️ 游标 ok 但 **counts 全 0** | ✅ | **部分实现** |

---

## ① 拓客模块

### ①-1 输入邮箱/公司名补齐客户信息 —— 链路就绪、零产出

**实现**：`prospecting-lookup` Action（`src/action/prospectingActions.js:36-62`）→ `routeExternalLookup`（`src/connectors/discovery/lookupRouter.js:14`）→ 5 个适配器（qixin / anysite / gaode / xinbang / tender）。
前端 `src/web/discovery.html:112-125` 三输入（name / domain / email），必填校验「至少输入公司名/域名/邮箱之一」。

**现网实测**（逐适配器，entity={domain:'tencent.com'}）：

| provider | HTTP | error | count |
|---|---|---|---|
| qixin / anysite / gaode / xinbang / tender | 200 | — | **0** |
| emailVerify / webResearch | 200 | `provider_not_enabled_or_unknown` | 0 |

（带 provider 为空时统一 `provider_not_enabled_or_unknown`）

**库证**：
- `crm.discovery_draft` 仅 **5 行**，且 `n_items` **全为 0**（5 次富集尝试全部空手）
- `GET /api/enrichment-metrics` → `{"calls":0,"cost":0,"hits":0,"rate":0}`
- `crm.events` **无 enrichment 域事件**

**根因**：`src/config/discoveryRules.js:19-29` 全部付费 provider `enabled:false`；凭据库（`integration-secrets` 键）仅 3 个租户且内容是 any-site key，**无 qixin/gaode 等可用凭据**。

**⛔ 判定：功能可用但补不出任何数据。**

### ①-2 筛选新客户（新战略/高层变动/人员招聘）—— 规则齐、候选池恒空

**实现**：`src/config/discoveryRules.js:37-47` 信号权重表：

| 信号 | 权重 | coverage 标注 |
|---|---|---|
| funding_round（融资） | 0.9 | 外部实测 |
| tender_match（招投标） | 0.8 | 外部实测 |
| hiring_icp_role（人员招聘） | 0.7 | ⚠️ `no_internal_source` |
| tech_adopt | 0.6 | 外部实测 |
| leadership_change（高层变动） | 0.5 | ⚠️ `no_internal_source` |
| social_content | 0.4 | 外部实测 |
| website_redesign | 0.3 | 外部实测 |
| contact_ledger_change | 0.25 | 内部推断 |
| relation_cooling | 0.2 | 内部推断 |

⚠️ **两个关键限定**（源码注释原文）：
1. `no_internal_source` 的定义（`discoveryRules.js:32-34`）：*"本平台**无数据源**。字段保留是为兼容既有读取点，但任何展示/承诺都不得把它说成'可用的筛选能力'"* —— 即「人员招聘」「高层变动」**当前是占位能力**。
2. **「新战略」无对应信号类型**（最接近的只有 `leadership_change` / `tech_adopt`）。

**现网实测**：
- `GET /api/discovery/candidates` → `{"items":[]}`（**0 条**）
- 库证：`CRM_ACCOUNT` 共 40 条，**`has_discovery` 全部 false** ⇒ 评分从未写入 ⇒ 候选池结构性恒空（`discoveryRoutes.js:48` 的 `filter(x => x.icp_fit_score != null)` 永远筛不出）

**⛔ 判定：权重规则齐备，但候选池无一条已评分账户 ⇒ 筛选结果恒为空。**

### ①-3 公海线索认领 / 回退 —— 功能完整，但闭环从未执行且当前无账号可操作

**实现**（链路齐备）：
- 前端 `src/web/lead-pool.html` 双面板：`:166` 认领按钮、`:222` 回退公海按钮、`:77` 回退原因必选
- 端点：`GET /api/lead-pool`（`routes.js:1125`）、`GET /api/lead-pool/mine`（`:1218`）、`POST /api/lead-pool/:id/pick`（`:1280`）
- 回退走 Action `crm-lead-return`（`src/action/seed-actions.js:999`，`deferDecisionMint` 自铸决策）
- 测试：`test/http/leadPickRecycle.test.js`、`leadPoolActions.test.js`、`leadPoolPage.test.js`、`leadPoolMineTab.test.js`

**现网实测**：
- `GET /api/lead-pool` → `total=12`（**公海 S0 共 12 条，全在 `system` 租户**）✅
- `GET /api/lead-pool/mine` → `total=0` ⛔
- 库证：`payload->>'stage'='S0P'` **0 条** ⇒ **认领/回退闭环从未被真实执行过**

⚠️ **结构性障碍（比"没执行"更严重）**：`routes.js:1285` 对认领做 fail-closed：
```js
if (!me.tenantId || me.tenantId === 'system') return res.status(400).json({ ok:false, gate:'plan_entitlement_missing_tenant', ... });
```
而**全部 12 条公海线索都在 `system` 租户**，alice 的 `tenantId` 为空 ⇒ **当前没有任何账号能认领这 12 条**。

**⛔ 判定：代码与 UI 完整，但闭环零执行 + 现有数据无账号可认领。**

---

## ② 打通邮箱/日历/会议/微信 + 客户图谱

### ②-1 四通道 —— 探针真实实现

`src/channels/probes.js` 四个探针均为**真协议**（非桩）：

| 通道 | 探针 | 必填字段（单一事实源 `PROBE_REQUIRED_FIELDS`） | 实现位置 |
|---|---|---|---|
| 邮箱 | `imap_login` | host / user / pass | `probes.js:57`（真 TCP/TLS + IMAP4rev1 LOGIN） |
| 日历 | `caldav_propfind` | url | `:123`（真 HTTPS + WebDAV PROPFIND） |
| 会议 | `meeting_api_list` | endpoint / token | `:144`（Zoom/Teams/腾讯会议通用） |
| 微信 | `wecom_api` | corp_id / secret | `:171`（真 HTTPS + 企微 gettoken） |

图谱汇入 `src/channels/channelGraphIngest.js`：事件行 → 按 domain 命中**既有** CRM_ACCOUNT → 按通道分键落 enrichment（email→`email_intent` / calendar→`schedule` / meeting→`meeting_intents` / wechat→`wechat_intents`）+ sourcedFrom 弱边。

### ②-2 现网实测 —— 零落地

| 检查项 | 结果 |
|---|---|
| `GET /api/channels` | `{"ok":true,"channels":[]}` ⛔ |
| 全库（所有 schema）含 `channel` 的表 | **0 张** |
| 全库含 `credential` / `vault` 的表 | **0 张** |
| `config_store` 50 个键中的通道相关键 | **0 个** |
| `crm.events` 的 `channel-probe` 事件 | **1 条**（2026-09-02，唯一一次） |
| 带 `enrichment` 键的粒子 | **2 条**（均属测试探针租户 `probe-ch-*`） |

**通道配置的真实载体**：`integration-providers` 键（`channelRouter.js:32`），但仅 2 个租户有：
- `system`：`customer-crm`（`enabled:false`）
- `sim-erp`：`erp-sim`（`enabled:true`，但 kind=`generic-rest`，被 `isChannelKind()` 过滤，**不算通道**）

**⛔ 判定：代码就绪，数据面完全空白。需求②「开通期打通」尚未发生。**

---

## ③ 日期驱动（自动运行 + 推送 + 建日历）—— 四项中最完整

### ③-1 实现

| 环节 | 实现 |
|---|---|
| 规则 | `signal-schedule` 键；15 租户各 4 条：`quote-timeout`(逾期) / `stage-silence` / `tender-deadline`(投标) / `report-due`(汇报) |
| 扫描 | `src/signal/scheduleScanner.js`：前瞻型 `due_within_days`(:19)、age 型 `threshold_days`(:30)、周期型 `weekday`(:43) |
| 投递 | `dispatcher.js` → `route.resolve` → `registry.deliver` → `crm.signal_delivery` |
| 日历 | `buildIcs` + `calendarDate`（`scheduleScanner.js:80`，仅前瞻型写 `event_at`，2026-09-17 修复） |
| 定时 | `timers.js` ⑫ schedule-scan 30min / ⑰ signal-dispatch 5min |

### ③-2 现网实测

**信号产出**：`crm.signal` 共 **1591 条** —— system 343 / acme-demo 305 / acme-chem 300 / acme-training 297 / acme-consult2 297 / sim-erp 188 / demo-datadriven 5 …

**投递台账**（`crm.signal_delivery`）：

| channel | status | n | 说明 |
|---|---|---|---|
| inbox | **sent** | **1265** | ✅ 站内消息真实送达（最新 `delivered_at` 2026-09-17T14:09:19Z，证明每 5 分钟泵在跑） |
| webhook | **sent** | **4** | ✅ 上一轮演示的本地 IM 桥真实 2xx 往返 |
| email | skipped | **10783** | ⛔ `no_recipient` 9714 + `rate_limited` 1064 —— **从未真实外发一封** |
| im | skipped | 4 | ⛔ `retry_exhausted`，渠道未实现（`IM_WEBHOOK_URL` 未接线） |
| inbox | skipped | 30 | `retry_exhausted` 27 + `rate_limited` 3 |

**⛔ 「推送邮箱/微信」未达成**：email 全是 `no_recipient`（缺收件人配置），im 渠道未实现。**唯一真实外发的是站内消息(inbox)与 webhook。**

⚠️ **拜访规则缺口**：`visit-remind`（需求③点名的「拜访」）**15 个租户中仅 `demo-datadriven` 有** —— 那是我 2026-09-17 用种子脚本写进去的。迁移 `db/migration-signal-schedule-visit-rule.sql` 虽已注册到 `db/migrate.js:328`，但**从未执行**（`signal-schedule` 的 `updated_at` 全部停在 `2026-09-17T02:48:43Z`，早于该迁移文件的创建时间 19:50）。

**判定：自动运行 ✅、建日历 ✅（前瞻型）、推送站内消息 ✅ / 推送邮箱微信 ⛔。**

---

## ④ 原 CRM 集成（一次性抽取 · 定时增量 · MCP 回写）

### ④-1 实现

| 环节 | 实现 |
|---|---|
| 抽取/增量内核 | `src/sync/`：`engine.js` / `cursor.js` / `factory.js`（`SYNC_PROVIDER_FACTORY`）/ `mapping.js` / `trust.js` |
| 定时增量 | `timers.js:223` `runIntegrationPollOnce`（A-B6 增量分支，独立于富化适配器） |
| 通道适配 | `createGenericRestSyncProvider`（唯一实现，预设=纯数据） |
| MCP 回写 | Action `sync-writeback-fields`（MCP 工具面 81 个之一）；`src/sync/writeback.js` 经第 0 闸 + `needsApproval` 第 3 闸 |
| 控制台 | `src/web/crm-sync-console.html`（主导航「系统 · 原系统集成」） |

### ④-2 现网实测

| 检查项 | 结果 |
|---|---|
| `GET /api/monitor/sync` | `{"rows":[],"lag":0,"success_rate":0,"conflict":0,"writeback":0,"degraded":0}` ⛔ |
| `crm.sync_cursor` | ✅ **真实存在**：`sim-erp`/`generic-rest` 2 行（account + opportunity），`last_status:'ok'`，游标推进至 `2026-09-16T20:10:00Z` |
| …其 `last_counts` | ⛔ **全 0**：`{"read":0,"created":0,"skipped":0,"updated":0,"writeback":0,"conflicted":0}` |
| `integration-providers` | `sim-erp` 的 `erp-sim` `enabled:true`（真实配置）；`system` 的 `customer-crm` `enabled:false` |
| `integration-secrets` | 3 个租户（加密值 `ww0EBwMC…`，pgcrypto） |
| `sync-trust` | `sim-erp` L2（`allow_upsert:true` / `allow_writeback:false`） |
| `crm.events` 同步域事件 | **0 条** |
| `sync_cursor` 其他租户 | 均为 `smoke-*` 测试租户（provider=`mock`） |

**⛔ 判定：通道配置与游标真实存在、`last_status:'ok'`，但吞吐全 0 ⇒ 「一次性抽取历史数据」未真正发生（无任何历史数据入库）。**

### ④-3 ⚠️ MCP 回写的重要限制（源码红线原文）

`src/sync/writeback.js` 头注「红线 ③」：

> *"范围：本次**不回写客户侧 CRM**（provider 反向写需外部平台配合，属 S4 后续）。本派发器交付「回写通道可达 + 可观测 + fail-closed」，落点为我方客户粒子。"*

⇒ 需求④的「经 MCP 回写」目前**只回写我方客户粒子**，**未回写原 CRM 系统**。且默认 `writeback_auto_approved:false`，自动同步路径的回写会被第 3 闸拦为 `approval_required`（需人工 HITL 放行）。

### ④-4 另一个注意点

`GET /api/integration/providers` → **403**（`"接入数据源仅 ADMIN/sysadmin 可管理（§15.1）"`）。这是**设计正确行为**（`CONFIG_ITEMS` #47/#48 为 `level:'system'`），非缺陷。但销售角色看不到任何集成信息。

---

## 主导航可达性（L3 判据）

四需求入口**全部已在主导航**（`src/portal/layoutMenu.js`）：

| 需求 | 菜单项 | href |
|---|---|---|
| ① | 销售 · **公海池** / 线索发现 / 线索·商机 | `/lead-pool.html` / `/discovery.html` / `/pipeline.html` |
| ② | 协同 · **外部沟通接入** | `/channel-config.html` |
| ③ | 协同 · **销售自动化** | `/signal-center.html` |
| ④ | 系统 · **原系统集成** | `/crm-sync-console.html` |

> 注：2026-09-17 之前记录的「入口死区」**已消除**（当时 channel-config 与 crm-sync-console 主导航 0 入口）。

---

## 如何测试与验证（可复现命令）

### 通用准备
```bash
# 确保 dev server 在跑（端口 3000）
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/

# 取 token（alice = sales 角色）
TOK=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"secret123"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
```

### ① 拓客
```bash
# 公海池 / 私海（应分别返回 total>0 / total=0）
curl -s "http://localhost:3000/api/lead-pool?limit=3"      -H "authorization: Bearer $TOK"
curl -s "http://localhost:3000/api/lead-pool/mine?limit=3" -H "authorization: Bearer $TOK"

# 新客户筛选（当前恒空 → 证明候选池未评分）
curl -s "http://localhost:3000/api/discovery/candidates"   -H "authorization: Bearer $TOK"

# 富集补齐（公司名/域名/邮箱三输入；当前 count=0）
curl -s -X POST http://localhost:3000/api/action/prospecting-lookup \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"provider":"qixin","kind":"enrich","payload":{"entity":{"domain":"tencent.com"},"fields":["industry","legal_person"]}}'

# 富集成本/命中率指标（当前 calls=0）
curl -s "http://localhost:3000/api/enrichment-metrics" -H "authorization: Bearer $TOK"
```
**数据库侧验证**：
```sql
-- 公海/私海分布（S0=公海, S0P=已认领）
SELECT payload->>'stage' AS stage, count(*) FROM crm.particles WHERE type='CRM_DEAL' GROUP BY 1;
-- 候选池为何恒空：CRM_ACCOUNT 有无 discovery 键
SELECT payload->'discovery' IS NOT NULL AS scored, count(*) FROM crm.particles WHERE type='CRM_ACCOUNT' GROUP BY 1;
```
**认领/回退闭环测试**：`npx vitest run test/http/leadPickRecycle.test.js test/http/leadPoolActions.test.js`
> ⚠️ 端到端演练需先有一条**非 system 租户**的 S0 线索（当前 12 条全在 system，端点 fail-closed 拒认领）。

### ② 通道/图谱
```bash
curl -s "http://localhost:3000/api/channels" -H "authorization: Bearer $TOK"   # 当前 {"ok":true,"channels":[]}

# 通道接入向导（verify_only=true → 只探测零副作用，不落凭据/不铸决策）
curl -s -X POST http://localhost:3000/api/channels/connect \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"id":"mail-1","kind":"generic-email","verify_only":true,
       "credentials":{"host":"imap.163.com","user":"x@163.com","pass":"授权码"}}'
# 期望：ok/verified=true 且 stored=false；缺字段应回 credentials_incomplete + missing[]
```
**数据库侧验证**：
```sql
-- 通道配置载体（isChannelKind 过滤后即为 /api/channels 的内容）
SELECT tenant_id, value FROM crm.config_store WHERE key='integration-providers';
-- 图谱汇入产物：按通道分键的 enrichment
SELECT tenant_id, count(*) FROM crm.particles
 WHERE payload->'enrichment' ?| array['email_intent','schedule','meeting_intents','wechat_intents'] GROUP BY 1;
```
**测试**：`npx vitest run test/channels`（探针/汇入/verifyScope）

### ③ 日期驱动（最易验证）
```bash
# 信号列表（租户内日期提醒）
curl -s "http://localhost:3000/api/signals?limit=5" -H "authorization: Bearer $TOK"
# 渠道就绪性 + 真实台账回显（verdict: last_sent / last_failed / never_attempted）
curl -s "http://localhost:3000/api/signals/delivery-status" -H "authorization: Bearer $TOK"
# 日历导出（.ics；仅前瞻型规则有 event_at）
curl -s "http://localhost:3000/api/signals/<signal_id>/ics" -H "authorization: Bearer $TOK" -o out.ics
```
**端到端演练（种子 + 全链路）**：
```bash
node scripts/seed-date-driven-demo.mjs    # 造日期型粒子 + 独立租户 demo-datadriven
node scripts/demo-date-driven-push.mjs    # 扫描 → 投递 → 台账 → IM 桥 → .ics
```
**数据库侧验证**：
```sql
-- 四类规则的租户覆盖（拜访规则当前仅 1 个租户）
SELECT tenant_id, jsonb_array_length(value->'rules') AS n_rules FROM crm.config_store WHERE key='signal-schedule';
-- 投递台账：sent 才是真实送达
SELECT channel, status, last_error, count(*) FROM crm.signal_delivery GROUP BY 1,2,3 ORDER BY 4 DESC;
```
**测试**：`npx vitest run test/signal`（25 文件 / 183 例）

### ④ 原 CRM 集成
```bash
# 同步指标（当前全 0）
curl -s "http://localhost:3000/api/monitor/sync" -H "authorization: Bearer $TOK"
# 可用同步工厂
curl -s "http://localhost:3000/api/sync/factories" -H "authorization: Bearer $TOK"
# 集成数据源（ADMIN/sysadmin only → 销售角色 403 为设计正确行为）
curl -s "http://localhost:3000/api/integration/providers" -H "authorization: Bearer $TOK"
```
**数据库侧验证**：
```sql
-- 游标与最近一轮计数（counts 全 0 = 抽取到 0 条）
SELECT tenant_id, provider, external_object, cursor_value, last_run_at, last_status, last_counts
  FROM crm.sync_cursor ORDER BY updated_at DESC;
-- 集成配置与信任档
SELECT tenant_id, key FROM crm.config_store WHERE key IN ('integration-providers','sync-trust','sync-mappings');
```
**MCP 回写验证**：
```bash
node -e "import('./src/mcp/tools.js').then(m=>{const t=m.buildMcpTools();console.log('工具数',t.length);console.log(t.map(x=>x.name).filter(n=>/writeback|lead|channel/.test(n)))})"
# 期望含 sync-writeback-fields / crm-lead-return / crm-channel-connect
```
**测试**：`npx vitest run test/sync`

---

## 结论速览

| 需求 | 一句话结论 |
|---|---|
| ① | ~~认领/回退闭环零执行、无账号可认领~~ **→ 09-18 已修**：根因＝端点层与 Action 层的租户闸**互不一致**（`resolveMe` 兜底把「缺租户」与「显式 system」压成同一个值）；修后闭环实测跑通（认领 `S0→S0P` → 回退 `S0P→S0`）。**仍未解决**：新客户筛选规则齐备但候选池结构性恒空（CRM_ACCOUNT 零评分）；富集链路通但零 provider 启用、零命中 |
| ② | **只有代码，没有任何数据落地** —— 全库无通道配置、无凭据、无通道事件。四类探针（IMAP/CalDAV/会议/企微）是真协议实现，但从未被接通 |
| ③ | **四项里最完整**：自动运行 ✅、站内消息真实送达 1265 条 ✅、日历载体 ✅。09-18 补证：**email 渠道实现完整可用**（本地 SMTP sink 取得 `sent` 成功样本 + `.ics` 附件；历史零外发＝凭据占位符＋模板无收件人）；「拜访」规则**已迁移覆盖 15/15 租户**。**仍未解决**：真实凭据、微信渠道未实现 |
| ④ | **通道配置与游标真实存在（sim-erp `last_status:'ok'`），但吞吐全 0**；MCP 回写工具已暴露，但源码明示**不回写客户侧 CRM**（属 S4） |

---

## 09-18 补充：三个遗留屏障的处置（本报告初版列出的「可继续推进」项）

### A. 公海认领屏障 —— 已修（端点层与 Action 层闸门对齐）

**症状**：12 条公海 S0 全在 `system` 租户；读端（alice，system 租户）**看得到**，写端 **400 拒**。全库 `S0P = 0` ⇒ 需求①的认领闭环从未执行。

**根因（两层闸不一致 + 兜底值抹掉语义差异）**：
| 层 | 判定 | 结果 |
|---|---|---|
| Action（`executor.js:104`） | 「显式 system 租户恒全权益（`resolveEntitlements` 内已豁免）」 | 放行 |
| REST 端点（`routes.js:1285`） | `!me.tenantId \|\| me.tenantId === 'system'` | **400 拒** |

而 `resolveMe`（`auth.js:62`）写作 `tenantId: p.tenantId || 'system'` —— **兜底把「缺租户」与「显式 system」压成同一个值**，调用方无法区分，只能一刀切。

**现网双向反证**（同一用户 alice、同一动作）：
- `POST /api/lead-pool/:id/pick` → **HTTP 400** `plan_entitlement_missing_tenant`
- `POST /api/action/crm-lead-pick` → **HTTP 200 认领成功**

**修法**：`resolveMe` 增 `hasExplicitTenant`；端点判定改为 `!me.hasExplicitTenant`（只拦「缺租户」，显式 system 放行）。

**修复后闭环实测**（真实 HTTP）：
```
认领前 S0/o=null  →  POST /api/lead-pool/:id/pick  →  HTTP 200
认领后 S0P/o=alice →  私海 1 条、公海 12→11、已从公海消失
回退   POST /api/action/crm-lead-return（reason=no_budget）→ HTTP 200
回退后 S0/o=null/pool=nurture（return_target）→ 公海复原 12 条
```

**守卫**：`test/http/leadPoolPickTenantGate.test.js` —— 含**两层闸同结论**元断言（端点 200 ⇔ Action ok；缺租户时两者报**同一个** gate 名），防止二者再次各自漂移。变异验证：回退端点判定 → 精确命中 2 红（显式 system + 两层一致），其余 4 绿。

### B. email 渠道 —— 已取得真实送达样本（渠道实现完整，失败在凭据/配置）

**此前全库 email 无一条 `sent`**：1w+ 行不是 `no_recipient`（收件人未配置）就是 `retry_exhausted`。

**新增 `scripts/e2e-email-channel.mjs`**：进程内起**本地 SMTP sink**（纯 `node:net`，真实 ESMTP 会话：EHLO / AUTH LOGIN / MAIL / RCPT / DATA），**进程级**覆盖 `SMTP_*`（不改 `.env`、不改 `config_store`，**零外发**），其余与生产**同装配**（`createDeliveryRegistry({})` + `createDeliveryStore(pool)` + `createDeliveryRouter({query})`）。

**实测结论**：
```
【4】台账: email  sent  try=1  to=watchm@163.com
【5】本地 SMTP sink 实收邮件 = 1 封
     MAIL FROM <crm-demo@chiyu.test>
     RCPT TO   <watchm@163.com>
     Subject: =?UTF-8?Q?tender=5Fdeadline_=E5=91=BD=E4=B8=AD?=
     Content-Type: text/calendar; method=PUBLISH; charset=utf-8;   ← .ics 日历附件
```
⇒ **email 渠道（含 .ics 日历附件）实现完整可用**，需求③「推邮箱 + 建日历」在同一封邮件上同时成立。

**历史失败的三个原因（非代码缺陷）**：
1. `.env` 的 `SMTP_PASS` 是占位符 `__REPLACE_WI…` ⇒ 真实 SMTP 登录 550（环境事实）
2. 出厂模板 `role_recipients` 为空：14/15 租户 `_seeded='system-template'` 且收件人空 ⇒ 恒 `no_recipient`
3. 少数信号 `retry_exhausted`（`attempts` 超 `retryLimit`）

> ②③ 是「**收件人一律来自 config_store、禁止硬编码平台收件人**」这条铁律的必然结果 —— 语义正确，但意味着**开箱即用的 email 推送默认是关闭的**，必须由租户管理员显式配置收件人。

### C. visit-remind（「拜访」规则）—— 已迁移覆盖 15/15 租户

**根因**：`package.json` 只有手动 `npm run migrate`，**服务启动不自动跑迁移** ⇒ `db/migration-signal-schedule-visit-rule.sql`（`migrate.js:328` 已注册）**从未执行**。

**处置**：单跑该迁移文件（**不**跑 `npm run migrate` —— 后者执行 `INCREMENTAL_SQL` 全量，含其他会话在飞的迁移，爆炸半径不受控）。迁移自带 `NOT EXISTS` 守卫、只 append 规则、幂等。

```
[执行] rowCount=14
[结论] 覆盖 15/15 个租户（含 system 平台模板 ⇒ 未来租户 autoSeed 亦带上）
备份：.workbuddy/backups/2026-09-18-signal-schedule-preview.json（15 行原值）
```

### D. 回归

`npx vitest run test/leadPoolPage.test.js test/http test/billing test/signal` → **141 文件 / 915 例全部通过，零失败**。

### E. 连带修改（既有断言同步，非新增缺陷）

| 文件 | 改动 | 理由 |
|---|---|---|
| `test/leadPoolPage.test.js` | 测试名「缺租户 / system 视界 fail-closed」→「缺租户（token 无 tenantId）fail-closed」 | 原名把两个语义混为一谈，而其 fixture（`issueToken` 无 tenantId）**只覆盖前者**；显式 system 租户现按设计放行，专测移至新守卫文件 |
| `scripts/e2e-lead-pool-actions.mjs` | S3.5.2 由「期望 400」改为「经端点 200 认领成功」；删除 actionExecutor 直驱段 | 原写法**绕过端点直驱 Action**，恰好掩盖了端点的缺陷；改后走真实页面链路，覆盖更强 |
