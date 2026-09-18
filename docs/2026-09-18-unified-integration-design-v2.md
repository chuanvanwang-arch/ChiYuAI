# 外部集成统一设计 v2：接入三形态 + 回写对账（**待批准**）

> 日期：2026-09-18 · 性质：**概要设计（未批准不写实现）**
> 输入：① 竞品一手研究 `docs/2026-09-18-competitor-crm-integration-study.md`（ROX / ATTIO / Lightfield 工程文档）
> 　　　② 接入形态改造草案 `docs/2026-09-18-channel-onboarding-connector-first-design.md`（P1–P4 待批）
> 　　　③ 本平台源码实测（本文所有 `file:line` 均为本轮重新核对，非转述）
> 覆盖需求：**② 通道打通**（邮箱/日历/会议/微信）+ **④ 与原 CRM 集成**（一次性抽取 · 定时增量 · MCP 回写）

---

## §0 结论先行

1. **本次核对推翻了我上一轮的一条自夸。** 竞品研究 §5.3 称「四类动作 HITL 闸门是我方独有强项」——实测**只有 1/4 接线**：

| 动作 | 生产接线 | 判定 |
|---|---|---|
| `first-connect` | ✅ `routes.js:304` → `channelRouter.js:88-90` / `channelActions.js:66-69` | 🟢 真接线 |
| `enable-writeback` | ⛔ 零消费点 | 🔴 **纸面闸门** |
| `mapping-change` | ⛔ 零消费点 | 🔴 **纸面闸门** |
| `trust-elevate` | ⛔ 零消费点 | 🔴 **纸面闸门** |

   `src/sync/gate.js` 的 `createSyncGate` 全仓库仅被 `test/sync/gate.test.js` 调用；`trust-elevate` / `enable-writeback` / `mapping-change` 三个字符串在全仓库**只出现在注释与常量数组里**（`gate.js:5`、`exportGate.js:4-5`）。同族的 `src/sync/trust.js`（`createTrustManager`）同样零生产消费——其判定逻辑在 `mount.js:21-26` 被**重新实现了一遍**。
   ⇒ 按项目 13 判据最高频项「**生产零接线**」：**「启用回写」这道闸目前不存在于生产路径**。
   ⇒ 直接后果：**在给 `enable-writeback` 接线之前，任何「放开客户侧回写」的方案都是无闸放行。** 本设计把这条列为 P2，先于回写放开（P5）。

2. **竞品对标的核心结论不变**：ROX 把「回写客户侧 CRM」当立身之本（*"we write back anything enriched or edited in Rox to their CRM"*），我方 `writeback.js:15` 红线③写的是「**本次不回写**（属 S4 后续）」。**这是战略范围问题，需你裁决**（§6.1 给三个选项 + 推荐）。

3. **但有三处比竞品研究当时判断的更好**，本轮实测修正：
   - **双向 ID 表已经存在**：`crm.external_ref` 已有 `last_direction` / `last_hash` / `external_updated_at` / `external_deleted_at`（`db/schema.sql:1096-1120`）。此前记的「G3 无双向 ID 表」**不成立**——表在，只是 `last_direction` 被硬编码为 `'in'`（`resolver.js:33,50`）。
   - **真正的 HITL 有三条且都已接线**：`executor.js:157` 第 3 闸、`channelRouter.js:88` 接入闸、`exportGate.js` 出口健康闸（`connectorActions.js:24-25`、`standingAuthorization.js:73` 消费）。竞品确实没有这一层。
   - **字段级方向已在描述符层建模**：`providerDescriptor.js:26 SYNC_DIRECTIONS` + `:101 inboundObjects`，只是 `mount.js:47` 把出向映射**在读入表里丢弃**，写回侧便无从消费。

4. **设计主线**：不新增内核，把已有零件接上，再补三个缺件。
   - **接上**：`sync/gate.js` 三类动作接线（P2）、`mount.js:47` 出向映射保留（P3）、`external_ref.last_direction` 双向写入（P6）。
   - **缺件**：待写队列 + 快照对账（P4，解决 `engine.js:63` 写失败丢意图）、per-cell 检查点（P7）、隐私排除清单（P1）。

5. **一条红线保持不变**：SaaS 多租户下**我方平台不得持有客户邮箱/IM 凭据**（承接接入形态设计的 §2.2 红线）。

---

## §1 范围、继承与防漂移

### §1.1 本设计覆盖

| 线 | 覆盖需求 | 入口 |
|---|---|---|
| **通道线**（本设计 §5） | 需求② 邮箱/日历/会议/微信打通 + 客户详情成图 | `onboarding-guide.html` → `channel-config.html`；`channelGraphIngest.js` |
| **同步线**（本设计 §6–§8） | 需求④ 一次性抽取 · 定时增量 · MCP 回写 | `crm-sync-console.html`；`mount.js` 两个触发点 |
| **合规面**（本设计 §9） | 贯穿两线的隐私/凭据/通道强制 | `config_store['sync-privacy']` + 通道级不可表达 |

### §1.2 继承关系（**不得漂移**）

| 既有设计 | 本设计的关系 |
|---|---|
| `2026-09-17-channel-adapter-unified-design.md` | **全量继承**。§3.0 事件行契约、§3.1–§3.4 四个 enrichment 落点键（`email_intent`/`schedule`/`meeting_intents`/`wechat_intents`）、§5 图谱汇入（`wrapProviderForIngest`）、§4.5.4 拒因透传——一律不动 |
| `2026-09-18-channel-onboarding-connector-first-design.md` | **并入本设计 §5**（P1–P4 保留原样，序号重排为 P2）。该草案不再单独推进 |
| `2026-09-15-final-design-coexistence-and-proactive.md` | 同步内核（`engine.js`/`mapping.js`/`resolver.js`/`cursor.js`）的权威来源。本设计只**扩**不**改**其既有语义 |

### §1.3 本设计**不改**的既有语义（防漂移清单）

- `engine.js:7 runOnce` 的 read→map→upsert→counts 主序；
- L1 只读 / L2 入库 / L3 回写三档语义与 `mount.js:21 min(descriptor, global)` 取严原则（**无提权路径**）；
- `mapping.js` 的未知字段拒绝 + 未知对象拒绝（fail-closed）；
- `resolver.js` 按 `(tenant, provider, object, external_id)` 幂等 upsert + 外部删除只软标记（**禁 DELETE**）；
- `exportGate.js` 与 `gate.js` 的**边界不可合并**（前者判「出口健不健康」，后者判「人有没有批」）；
- `sync_cursor` / `external_ref` **禁删**，只 upsert。

---

## §2 本平台现状基线（file:line 实测）

### §2.1 已就绪（可直接复用，**不要重造**）

| 能力 | 锚点 | 备注 |
|---|---|---|
| 同步内核单序 | `engine.js:7-68` | 读→映射→幂等 upsert→计数 |
| 两个生产触发点 | `timers.js:588-656`（⑩ integration-poll）、`connectorRouter.js:59`（webhook） | **零新增定时器**可复用 |
| 轮询间隔可配 | `timers.js:591`：`INTEGRATION_POLL_MS` > `config_store['integration-poll'].interval_ms` > 6h | 频率设计的既有承载 |
| 有效信任档取严 | `mount.js:21-26 effectiveTrustLevel` | 无提权路径 |
| 字段级 CAS | `connectorActions.js:194` + `writeback.js:39-41` | 与 ROX 快照比对同族 |
| 静态来源标记 | `connectorActions.js:192` `Source:'crm-ai-native'` | ↔ ROX `Source="Rox"` |
| 白名单回写 | `writeback.js:28-37` + `connectorActions.js:175` | **双保险过滤**，白名单空即拒 |
| 决策凭证 | `writeback.js:43` + `autonomyEngine.decisionIdOf` | 同事务留痕 |
| 出口健康闸 | `exportGate.js:44-78`（三判据 fail-closed） | 竞品未见 |
| executor 第 3 闸 | `executor.js:155-159` | 回写默认被拦（`writeback.js:45`） |
| 双向 ID 表 | `external_ref` 含 `last_direction`/`last_hash`/`external_updated_at` | **已存在**，见 §0-3 |
| 对象级方向建模 | `providerDescriptor.js:26,101` | `SYNC_DIRECTIONS` |
| 通道 kind 单一事实源 | `channels/kinds.js` | 禁 `startsWith` |
| 四真实探针 | `channels/probes.js`（IMAP/CalDAV/Meeting/企微） | 已实测到达真服务端 |
| 拒因透传 | `probes.js` → `verifyScope.js` → `channelRouter.js` → 两页 `guidedHint` | 已建立变异自证守卫 |

### §2.2 真实缺口（本轮实测，含修正）

| # | 缺口 | 锚点（实测） | 与竞品对照 |
|---|---|---|---|
| **G0** | **同步线评审闸纸面化**：`enable-writeback`/`mapping-change`/`trust-elevate` 零消费点 | `sync/gate.js:7`（仅单测）；`sync/trust.js:5`（仅单测） | 竞品也没有闸——但**我方不能是"声称有闸却没接线"**，这比没闸更危险 |
| **G1** | **不回写客户侧 CRM** | `writeback.js:15` 红线③ | ROX 的立身之本 |
| **G2** | **写失败即丢意图**：仅 `counts.conflicted++` | `engine.js:62-63` | ROX 落 pending 队列 + batch 对账 |
| **G3′** | **变更来源判定未实现**（表已有，值恒 `'in'`） | `resolver.js:33,50` 硬编码 | ROX Change-origin disambiguation |
| **G4** | 无 per-cell 检查点（仅对象级 `last_counts`） | `cursor.js:12-23`；`sync_cursor.last_counts` | ROX per-cell `last synced at` |
| **G5** | 无逐对象频率（全局单一 interval） | `timers.js:591` 单值 | ROX 5–1440 min 逐对象 |
| **G6** | 出向映射被丢弃 | `mount.js:47` `if (m.direction !== 'in') continue` | ROX Mappings 逐字段方向 |
| **G7** | 无隐私排除清单 | 无 | 三家**都有**（成本最低、收益最高） |
| **G8** | 无「未匹配不落库」判定 | `channelGraphIngest.js:24` 全量汇入 | ATTIO 默认不落库 |
| **G9** | 凭据姿态（vault 收密码） | `onboarding-guide.html` 表单 | 三家均不做；接入形态设计已改 |
| **G10** | 探针方向（IMAP 密码） | `channels/probes.js` | 三家均不做 IMAP，但**我方探针可复用为 `local-bridge`/`direct` 的验证器**，不是废件 |
| **G11** | MCP 敏感动作无通道级强制 | 全局 | ROX Tether `403 CHANNEL_REQUIRED` |

---

## §3 目标架构总览

```
                    ┌───────────── 接入三形态（§5，单一事实源 sourceKinds.js）─────────────┐
                    │  connector（默认）      local-bridge（无官方套件默认）    direct（兜底）  │
                    │  凭据：对方平台+本机     凭据：用户本机                  凭据：我方 vault │
                    └───────┬───────────────────────┬───────────────────────────┬──────────┘
                            │                       │                           │
              WorkBuddy 侧 Agent 调工具        本机 CLI / 本机 MCP        我方 HTTP 探针/adapter
                            └───────────┬───────────┴───────────────┬───────────┘
                                        ▼                           ▼
                             ┌────────────────────┐      ┌──────────────────────────┐
                             │ 【通道线】需求②     │      │ 【同步线】需求④           │
                             │ normalizeChannelRow│      │ mapping.apply（in 字段）  │
                             │ → 事件行契约        │      │ → resolver.upsert        │
                             │ → enrichment 四落点 │      │ → external_ref（in/out）  │
                             │ → 图谱汇入          │      │ → writeback（target）     │
                             └─────────┬──────────┘      └────────┬─────────────────┘
                                       │                          │
                    ┌──────────────────┴──────────────────────────┴──────────────────┐
                    │ 【合规面】§9  privacyFilter（双线共用单一事实源）                  │
                    │   exclude_domains / addresses / keywords + matched_only 默认 true │
                    └───────────────────────────────────────────────────────────────┘

  闸门（自内向外，任一未过即不放行）：
    第 0 闸 决策铸造（mintDecision）→ 第 3 闸 executor.approvalPassed
    → 评审闸（gate.js 四类动作，**P2 接线**）→ 出口健康闸（exportGate 三判据）
```

**三个设计约束**：
1. **零新增内核**：事件行契约、四落点键、`wrapProviderForIngest` 幂等、`resolver.upsert` 幂等一律不动。
2. **零新增定时器**：频率（G5）、队列 drain（G2）全部挂在既有 ⑩ integration-poll 上。
3. **单一事实源纪律**：`sourceKinds.js`（接入形态）、`channels/kinds.js`（通道 kind）、`providerDescriptor.js`（方向/对象）三处各自唯一，禁止旁路解析。

---

## §5【通道线】接入三形态（承接草案，序号重排为 P2）

> 本节的机制依据、ATTIO 原文、WorkBuddy 连接器清单见 `docs/2026-09-18-channel-onboarding-connector-first-design.md` §1–§4，此处只写**与本平台对接的确定项**。

### §5.1 三形态与落点

| 形态 | 凭据持有者 | 进入平台的通路 | `sourceKind` |
|---|---|---|---|
| `connector`（默认） | 对方平台 + 用户本机 | WorkBuddy 侧 Agent 调 connector 工具 → 经 **crm-native MCP** 写入 | `connector` |
| `local-bridge` | **用户本机** | 本机 CLI / 本机 MCP → Agent 读取 → 经 MCP 写入 | `local-bridge` |
| `direct`（兜底） | 我方 vault（pgcrypto） | `channels/probes.js` + `verifyScope.js` 直连 | `direct` |

**单一事实源**：新建 `src/channels/sourceKinds.js`，导出 `SOURCE_KINDS` 集合与 `isSourceKind()`。描述符新增 `source_kind` 字段（**仅展示与验证路由用**，不参与落点键 —— 避免「同一语义两个键」）。

### §5.2 分路验证（各自 fail-closed，互不冒充）

| 形态 | 验证器 | 失败语义 |
|---|---|---|
| `connector` | Agent 侧调**一次只读工具**（列 1 条日程 / 读 1 封邮件），经 MCP 回 `{sourceKind, verified_at, tool, ok, error?}` —— **绝不回传凭据或原文** | 未授权/未安装 → 如实报未接入 |
| `local-bridge` | 本机 CLI 探针（复用 `probes.js` 的 IMAP 实现，跑在用户机器上） | 沿用 `auth_failed` + 服务端原话 + 授权码引导（§4.5.4） |
| `direct` | 现有 `verifyScope` 真探测（不经任何改动） | 现有 `missing`/`hint`/`detail` 三层透传 |

**守卫（可测）**：`sourceKind` 取值必须 ∈ `SOURCE_KINDS`；三形态各自验证通过**不得**写入其它形态的 `verified` 记录（按 `(channel_id, source_kind)` 联合键判定）。

### §5.3 向导与配置台

- `onboarding-guide.html`：由「凭据表单」改为 **A/B/C 三卡**（A 连接官方连接器 / B 本机桥命令 / C 兜底表单折叠 + 显式声明凭据去向）。
- `channel-config.html`：保留为通道管理台，增加 `sourceKind` 标识与「凭据保存在哪」说明。
- **两页 `guidedHint` 同源守卫继续有效**（`test/web/channelHintParity.test.js` 已建立，含变异自证）。

### §5.4 入口集成落地清单（IM / 邮件 / 日历 / 会议 —— 逐通道可验收）

> 用户明确要求：**不是做一个本站网页去连接，而是引导用户打开相关应用/工具、由用户在其内输入凭据**
> （与「在 WorkBuddy 里配好 MCP 或 CLI」同义）。下表把这句话落到**每个通道 × 每种形态**的具体动作，
> 使「入口集成」本身成为可验收项，而不是一句形态描述。

**A 连接器（默认路径）** —— 凭据由对方平台与用户本机持有，我方只经 MCP 消费结果：

| 需求 | kind | 可用官方套件连接器（能力来自连接器描述原文） | 用户实际动作 |
|---|---|---|---|
| 邮箱 | `generic-email` | 企业微信（邮件读取与发送）· 飞书（邮箱）· 钉钉（邮箱） | 在**自家 App / 客户端**内登录并授权 → 我方仅收 `{tool, ok}` |
| 日历 | `generic-calendar` | 企业微信（新建管理日程）· 飞书（日历）· 钉钉（日历） | 同上 |
| 会议 | `generic-meeting` | 企业微信（预约与获取会议信息）· 飞书（视频会议） | 同上 |
| 微信 / IM | `generic-wechat` | 企业微信（消息）· 飞书（即时通讯）· 钉钉（群聊与机器人） | 同上 |

**B 本机桥（无官方套件时，如 163 个人邮箱）** —— **凭据留在用户机器上，不进我方平台**：

| 需求 | kind | 桥接工具（成熟 CLI，不自研） | 用户实际动作 |
|---|---|---|---|
| 邮箱 | `generic-email` | `himalaya`（IMAP/SMTP） | 在**本机**粘贴授权码；我方只读通过 CLI 取到的结果 |
| 日历 | `generic-calendar` | `khal`（CalDAV） | 同上 |
| 会议 / IM | `generic-meeting` / `generic-wechat` | 暂无等价 CLI | 如实报「该通道暂无本机桥」，**不伪造入口** |

**C 兜底（`direct`）** —— 现有自建探针 + vault，**保留但降级**，界面显式标注「凭据将上传我方平台」。

**逐项验收判据**（每形态各自 fail-closed，互不冒充）：

| # | 判据 | 反证方式 |
|---|---|---|
| 1 | A 形态：用户侧 Agent 调一次**只读**工具成功 → 回写 `{source_kind:'connector', tool, verified_at, ok}`；响应**不含**凭据或正文 | 让工具返回邮件正文 → 断言响应里不出现正文（回传即红） |
| 2 | B 形态：本机桥探针通过；**平台侧 vault 里不得出现该通道凭据** | 走 B 后查 vault → 出现凭据即红 |
| 3 | C 形态：既有 `verifyScope` 三层透传（`missing`/`hint`/`detail`）不变 | 沿用 §4.5.4 守卫 |
| 4 | 三形态不互相冒充：验证通过只写 `(channel_id, source_kind)` 对应记录，其余形态仍为「未验证」 | 用同一 `verified` 字段覆盖 → 必须变红 |
| 5 | 同一通道**只允许一个已验证形态生效**（防双写） | 让两个形态同时已验证 → 断言被拒 |
| 6 | 向导三卡在**零通道**首次进入时自动出现（不是让用户自己找配置页） | 移除自动展开 → 必须变红 |

---

## §6【同步线】回写设计（本设计的核心）

### §6.1 G1 范围裁决：红线③怎么改（**需你批准**）

`writeback.js:15` 现状：「本次**不回写客户侧 CRM**（provider 反向写需外部平台配合，属 S4 后续）；落点为我方客户粒子。」

| 选项 | 内容 | 代价 | 判定 |
|---|---|---|---|
| **A. 保持现状** | 永不写客户侧，只做读取与图谱 | 与 ROX 对标不成立；需求④「MCP 回写」只能解释为「回写我方粒子」 | 🔴 与用户原始需求不符 |
| **B. 单向白名单回写**（**推荐**） | 我方判定字段 → 客户侧 CRM，**只出不进**；不接收客户侧回流变更 | 需 P2 闸接线 + P4 队列 + P5 真桩验证；不需回环治理 | 🟢 已能让「回写」成立；ROX 的 batch 富集回写正是单向 |
| **C. 完整双向** | 双向同步 + 变更来源判定 + 冲突降级为建议 | 需 P6 回环治理；不成熟的回环会自我触发、重复写入 | 🟡 建议 P6 之后再开 |

**推荐 B，并把红线③改写成三条前置条件**（不是删除，是从「禁止」改为「受约束的允许」）：

```
回写客户侧 CRM 仅当同时满足：
  ① descriptor.outbound 显式声明（enabled + 字段集合）—— 缺声明即视为未开放（fail-closed）
  ② 通过 enable-writeback 评审闸的人工放行（P2 接线后才有此闸）
  ③ exportGate 出口健康（三判据全真）
且 目标默认为 internal（我方粒子）；target='crm' 必须由运营在配置中心显式开启。
```

### §6.2 写通道：**不新增 Action，改为一个 Action 两个目标**

现状：`connectorActions.js:169 sync-writeback-fields` 的 handler 落点是 `updateParticle`（我方粒子）。

| 选项 | 做法 | 判定 |
|---|---|---|
| A. 新增 `sync-writeback-external` Action | 需改三处（Action Registry / capabilities.actions / skillCalls），Action 面 5→6 | 🟡 清晰但扩大表面 |
| **B. 既有 Action 增 `target` 参数**（**推荐**） | `target:'internal'`（默认，现状零行为变化）/ `target:'crm'`；handler 内按 `target` 分流，`crm` 分支要求 `external_ref` + `descriptor.outbound` | 🟢 守住「单一写通道」红线，Action 面不增长 |

`target='crm'` 分支的 provider 解析**必须复用 `mount` 的工厂字典**（`presets/index.js PRESET_FACTORIES` + base factories），不得另起一套 —— 与 A-B3「两个同名工厂」事故同族防线。

### §6.3 G2 待写队列 + 快照对账（**解决「写失败丢意图」**）

**现状缺陷**：`engine.js:62-63` 写回失败只 `counts.conflicted++`，意图消失，无对账、无重放。

**新表**（`CREATE TABLE IF NOT EXISTS`，幂等叠加，双写 `db/schema.sql` + `db/migration-*.sql`）：

```
crm.sync_pending_write
  id, tenant_id, provider, external_object, external_id, particle_id
  target            TEXT        -- internal | crm
  fields            JSONB       -- 待写字段（已过白名单）
  baseline_hash     TEXT        -- 用户编辑时看到的基线（ROX: snapshot / stable hash）
  status            TEXT        -- pending | applied | skipped_stale | failed | abandoned
  attempts          INT, last_error TEXT, decision_id UUID
  next_attempt_at   TIMESTAMPTZ, created_at, updated_at
  UNIQUE (tenant_id, provider, external_object, external_id, target)  -- 同目标合并，不堆叠
```

**写入时机**：`engine.js:63` 的失败分支**追加**落 pending（`conflicted++` **保留**，作为可观测计数）。
**drain 时机**：挂在既有 ⑩ integration-poll 上（**零新增定时器**），每轮取 `status='pending' AND next_attempt_at <= now()`。
**drain 语义**（对齐 ROX §1.3）：

```
1. 实时拉取客户侧当前对象（仅待写字段）
2. 与 baseline_hash 比对：
     不同 → status='skipped_stale'（等价于「即便当时写成功也会被后改覆盖」）→ 留痕供人工 force
     相同 → 落盘 → status='applied'
3. 落盘失败 → attempts++，退避 next_attempt_at；attempts > max 且仍失败 → status='failed'（人工可见）
```

> ⚠ **反假绿铁律**：pending 队列**不得**被当作「乐观缓冲」用来掩盖失败。判据：`pending` 必须**可 drain 且 drain 结果可对账**（applied / skipped_stale / failed 三态之和 + 仍在 pending 的条数 = 写入总条数）。若出现「永远 pending」，即为新的黑洞——与 `conflicted++` 相比只是把失败藏得更深。
> ⚠ **禁用 wall clock 判胜负**：ROX 原话 *"raw timestamps aren't a safe basis for 'who wins'"*。比对一律用 `baseline_hash` / 内容比对，不用时间戳。

### §6.4 G3′ 变更来源判定（**表已有，只差写入**）

**实测修正**：`external_ref` 已有 `last_direction` / `last_hash` / `external_updated_at` / `external_deleted_at`。`resolver.js:33,50` 把 `last_direction` **硬编码为 `'in'`**。

**设计**：
- 我方回写成功 → `last_direction='out'`、`last_hash = hash(写入字段)`、`last_synced_at=now()`。
- 读入时**新增判定**（`resolver.upsert` 前置，纯函数 `classifyOrigin()`）：

| 条件 | 判定 | 动作 |
|---|---|---|
| `last_direction='out'` 且 读回内容 == `last_hash` 对应内容 | **`echo`（我方回环）** | **不计 created/updated，不触发下游信号**，只更新 `last_synced_at` |
| `last_direction='out'` 且 内容不同 | 客户侧真实变更 | 正常 upsert → `last_direction='in'` |
| `last_direction='in'` / NULL | 正常读入 | 正常 upsert |

- **为什么必须做**：不做则「我方写出的值被读回」会被当成客户侧变更，触发重复入库与下游信号自我触发（ROX §1.3③ 的同一条）。
- **新增列**：`external_ref.outbound_at TIMESTAMPTZ`（可选，仅作展示与对账，**不参与胜负判定**）。

### §6.5 G6 逐字段方向（出向集合的确定性）

**实测**：`mount.js:47` `if (m.direction && m.direction !== 'in') continue;` —— 出向映射在读入表里被丢弃，写回侧无从消费。

**设计**：
- `sync-mappings` 的 `fields[]` 增加 `direction: 'in' | 'out' | 'both'`（**缺省 `'in'`，零回归**）。
- **对象级** `direction` 语义保持不变（仅 `in` 进读入表）——`mount.js:47` 不改。
- `mapping.js` 新增 `outboundFields(object)`（只读取，不改 `apply`）→ 供写回侧取字段集合。
- **双闸**：可写字段 = `mapping.outboundFields()` ∩ `sync-trust.writeback_fields_whitelist`，**两者皆非空**才可写（任一为空 → 拒绝，绝不「未声明即放行」）。

---

## §7 调度与检查点（G4/G5）

### §7.1 G5 逐对象频率（**零新增定时器**）

- descriptor 增加 `interval_minutes`；`sync_cursor` 新增 `next_due_at TIMESTAMPTZ`。
- 既有 ⑩ poll 每轮遍历 target 时，比较 `next_due_at` → 未到点跳过（`out.skipped_due++` 计数，可观测）。
- 档位对齐 ROX：`5 / 10 / 15 / 30 / 60 / 180 / 360 / 720 / 1440` 分钟。
- ⚠ **防假绿（必须实现）**：`interval_minutes` **小于**实际 poll 间隔时，真实频率 = poll 间隔，**界面与 API 必须显示实际频率，不得显示配置值**。判据：若显示值 ≠ 实测相邻两次 `sync_cursor.last_run_at` 的差值，即为假绿。

### §7.2 G4 per-cell 检查点与安全重放

- 新表 `crm.sync_cell_checkpoint (tenant_id, provider, external_object, external_id, field, last_synced_at, last_hash, PRIMARY KEY(...4+field))`。
- 每次成功回写**与审计同事务**写入（对齐 ROX「同事务落库」）。
- 重放判据：某字段 `last_hash` 与目标当前值一致 → 跳过（幂等重放）；不一致 → 按 §6.3 对账流程处理。
- **禁止**用 `sync_cursor.last_counts` 兼任 per-cell 记录（对象级与字段级不可混用，混用即精度谎报）。

---

## §8 隐私与合规

### §8.1 G7 隐私排除清单（**最先补，成本最低**）

新配置键 `config_store['sync-privacy']`：

```json
{
  "exclude_domains":   ["内部域名", "竞品域名"],
  "exclude_addresses": ["ceo@", "hr@"],
  "exclude_keywords":  ["Receipt", "Confirmation", "验证码"],
  "matched_only":      true,
  "window_days":       30
}
```

- **消费点必须在入口**：新建纯函数 `src/channels/privacyFilter.js`，**通道线**（`channelIngestWiring.js:87` 包装器内）与**同步线**（`engine.js:43` 循环前置）**共用同一实现**（单一事实源）。
- ⚠ **P1 实际落地范围**（与上方 JSON 草案的差异，避免「设计写了＝已实现」的误读）：只落 `exclude_domains` / `exclude_addresses` / `exclude_keywords` 三类。
  `matched_only` 属 G8（§8.2，**待 Q2 裁决**，本设计不擅自收窄）；`window_days` 属抽取窗口（未实现，且不宜与排除清单混在同一开关里）。
- **fail-closed 方向**（实现后订正，原表述过于含糊）：「读不到配置 → 更私密默认」这句话会被误读为「一律丢弃」，而那是**假红**（一次 DB 抖动表现为数据凭空消失）。落地语义按四态区分：
  ① **未配置**（`null`）＝ 合法状态 → 空规则 + `config_ok=true`（不告警）；
  ② **读取失败**（DB 异常）＝ 异常 → 空规则 + `config_ok=false` 由装配层标记 + 留痕；
  ③ **形状坏**（非对象/字段非数组）＝ 异常 → `config_ok=false` + `invalid_items` 记账；
  ④ **字段缺失** → 不丢（缺字段 ≠ 命中规则）。
  ⚠ ①②若合并成同一个 `config_ok=false`，每个未配置租户每轮同步都会落一条「配置异常」⇒ 告警疲劳，真故障被淹没（另一种假绿）。
- **域名信号必须包含「邮箱地址自身的域名」**（实现期发现的缺陷）：客户侧同步行常常只有 `email` 字段、没有独立域名字段；若只取显式 domain 字段，用户配了 `exclude_domains:['secret.com']` 后会出现**通道线拦下、同步线照落** `bob@secret.com` —— 同一份承诺两个答案，而界面显示已生效（假绿）。已在 `domainFromEmail()` 统一补齐，两线共用。
- 三家竞品都有（ROX Restricted Domains / ATTIO blocklist / Lightfield Do-not-track）；我方为零成本高信任项。

### §8.2 G8「未匹配不落库」（**对已批设计的收窄，需你确认**）

- ATTIO 原文：*"emails to/from addresses that do not match any Person are **NOT** logged"*。
- 已批设计 `2026-09-17-channel-adapter-unified-design.md` §3 写的是「通道信号**直接汇入** enrichment（自动）」——**全量汇入**。
- 本设计改为：**仅当行能匹配到我方客户粒子（域名/邮箱）才汇入 enrichment；未匹配行不落 enrichment**，但**保留丢弃计数**（`ingest_skipped_unmatched`）用于观测。
- 这是**对已批设计的收窄**（合规上更严，功能上更少），按 HARD-GATE 需你显式确认，不属于我可自行决定的偏离。
- ⚠ 影响面：`channelGraphIngest.js:24 ingestChannelEvent` 的调用前置新增判定；`account-360.html` 的合并时间线数据会变少（这是预期，不是缺陷）。

### §8.3 G11 敏感动作通道级不可表达（借鉴 ROX Tether）

ROX 原文：*"The agent's credentials cannot express confirmation."*（agent 调 confirm → `403 CHANNEL_REQUIRED`）。

- 我方现状：写操作经 `executor.js:157` 第 3 闸，需 `ctx.approvalPassed=true` —— **已是服务端强制，不是提示词约定** 🟢。
- 可补强：MCP 侧对 `target='crm'` 的回写**拒绝由 agent 通道携带的 `approvalPassed`**，只接受来自浏览器/审批流的签名凭证（`403 CHANNEL_REQUIRED` 语义）。列为 P9，非必须。

---

## §9 与竞品的差异声明（**不学什么**）

| 不学 | 理由 |
|---|---|
| 不收用户密码 | 三家一致规避；`direct` 形态降级为兜底并显式标注凭据去向 |
| 不以「替换客户 CRM」为目标 | Lightfield 路线切换成本高；坚持共存（`2026-09-15` 设计 §0 一致） |
| 不照抄「只有 MCP、无公开 REST」 | ROX 敢这样是因为它不打算被集成；我方是平台方，需保留 REST 面 |
| **不把 admin 直配生效当默认** | ROX 接入无评审闸门——这是我方**不该对齐**之处。**但前提是闸真的接线了**（§0-1） |

**必须保留并强化的我方独有**：`executor` 第 3 闸、出口健康闸 `exportGate`、信任三档无提权、读失败必留痕（`engine.js:26-36` 区分「同步在跑」与「一条没读到」）、拒因透传。

---

## §10 验证方案（每条判据自带反证方式）

| 判据 | 反证方式 | 变异自证 |
|---|---|---|
| P2 三类评审动作真接线 | 构造未批准 → 断言拒绝；批准 → 断言放行；**扫生产消费点非零** | 摘掉闸调用 → 必须变红 |
| P4 待写队列不丢意图 | **真库**：制造写失败 → 断言存在 `pending` 行 → drain 后落 `applied`/`skipped_stale` | 把落队列改回 `conflicted++` → 必须变红 |
| P4 drain 可对账 | 断言 `applied + skipped_stale + failed + pending = 写入总数` | 让 drain 静默丢弃 → 必须变红 |
| P5 客户侧回写真到达 | **本地真 HTTP 桩**（起假 CRM 端点）断言收到字段与 `Source` 头/字段 | 只断言 `counts.writeback>0` 视为**不合格**（那是计数不是到达） |
| P6 echo 不回环 | 写 out → 读回同值 → 断言 `created=0 && updated=0` 且无下游信号 | 去掉 echo 判定 → 必须变红 |
| P7 检查点可重放 | 同字段重放两次 → 第二次跳过 | 删 checkpoint 读取 → 必须变红 |
| P8 频率显示真实值 | 断言显示值 == 实测 `last_run_at` 差值 | 显示配置值 → 必须变红 |
| P1 隐私过滤真生效 | 排除域名/关键词行 → 断言不入库且计数可见 | 过滤写在入口之后 → 必须变红 |
| P2 三形态不互相冒充 | `connector` 验证通过后，断言 `local-bridge`/`direct` 仍为未验证 | 用同一 `verified` 字段覆盖 → 必须变红 |

**纪律**：静态 grep 不构成证据（既有教训）；否定断言必先剥离注释；守卫永不触发同属假绿；渲染类断言看**产物**（行数/字段值），不看请求发出。

---

## §11 分阶段交付（待批准后执行；每 Task 一 commit、显式 add）

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **P1** | 隐私排除清单：`sync-privacy` 配置 + `privacyFilter.js`（双线共用）+ 界面 + 丢弃计数 | 无 | 低 |
| **P2** | 接入三形态：`sourceKinds.js` + 描述符 `source_kind` + 向导 A/B/C + 分路验证 + 运行期校验器 | P1 | 低 |
| **P3** | **评审闸接线**：`enable-writeback` / `mapping-change` / `trust-elevate` 接入生产路径 + 扫「零消费点」守卫；`sync/trust.js` 与 `mount.js:21` 逻辑收敛到单一事实源 | 无（**必须先于 P5**） | 中 |
| **P4** | 出向集合确定性：字段级 `direction` + `mapping.outboundFields()` + 双闸；`target` 参数（默认 `internal`，零行为变化） | P3 | 中 |
| **P5** | 待写队列 + 快照对账（先 `target='internal'`，验证「不丢意图」） | P4 | 中 |
| **P6** | **客户侧回写放开**（红线③范围改写落地）+ 本地真 CRM 桩 + 三闸齐备 | P5 + **§6.1 裁决** | 高 |
| **P7** | 变更来源判定：`classifyOrigin()` + `external_ref.last_direction='out'` + `outbound_at` | P6 | 中 |
| **P8** | per-cell 检查点 + 安全重放 | P6 | 中 |
| **P9** | 逐对象频率 + `next_due_at` + 「显示真实频率」守卫 | P5 | 低 |
| **P10** | （可选）MCP 通道级不可表达 | P7 | 低 |

**DB 变更纪律**：只增不删（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），同步写 `db/schema.sql` 与 `db/migration-*.sql`，并遵守已发布的判据「migrate 字符串式 `.sql` 引用必须存在」（`2c04235`）。

---

## §12 风险与不做清单

| 风险 | 处置 |
|---|---|
| 放开回写后误写客户 CRM | `target` 默认 `internal`；`crm` 需 §6.1 三前置 + 人工闸；`Source='crm-ai-native'` 静态标记便于客户侧过滤与回滚定位 |
| pending 队列成为新黑洞 | §6.3 对账判据强制；`failed` 态人工可见；不做无限重试 |
| 隐私收窄导致「数据变少」被误判为故障 | 丢弃计数可见 + 文档说明；界面区分「未匹配丢弃」与「读取失败」 |
| 频率配置与实际不符 | §7.1 显示真实频率守卫 |
| 三形态并行导致双写 | `(channel_id, source_kind)` 联合键；同一通道只允许一个**已验证**形态生效 |
| **不做** | 不收用户密码（`direct` 仅兜底）；不新增粒子类型；不改业务域模型；不做 CRM 替换；不新增定时器；不删既有模块 |

---

## §13 待批准问题（建议一次一问）

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| **Q1** | **G1 红线③范围怎么改**（决定 P6 是否做） | A 保持不回写 / **B 单向白名单回写** / C 完整双向 | **B**，分期到 C |
| **Q2** | **G8 是否同意把「通道信号全量汇入」收窄为「匹配到客户才汇入」** | 同意收窄 / 保持全量（合规弱于 ATTIO）/ 只对邮箱通道收窄 | **同意收窄**（合规收益明确，且 ATTIO 即为事实标准） |
| **Q3** | P4 的 `target` 走「既有 Action 加参数」还是「新增 Action」 | 加参数 / 新增 Action | **加参数**（守住单一写通道，Action 面不增长） |

> **本轮未写任何实现代码**（HARD-GATE：未批准不写实现）。P1/P2 若要开工，请明确「批准 P1–P2」。
