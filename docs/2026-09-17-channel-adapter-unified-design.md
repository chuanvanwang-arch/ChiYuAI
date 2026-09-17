# 需求② · 邮箱 / 日历 / 会议 / 微信 统一适配器设计方案（v1 已批准 2026-09-17）

> 日期：2026-09-17
> 状态：**待批准（HARD-GATE：未批准不写实现）**
> 定位：补齐用户四需求中唯一 0/4 未落地的「开通期打通邮箱/日历/会议/微信 → 提取客户详细信息 → 形成图谱」。
> 前提约束：`docs/2026-09-08` 已批设计 §10（不新增粒子类型、不改业务域模型）+ 用户红线「做成通用接口，不能按某产品深度定制」。
> 关联：S2（CRM 记录读入）已交付同步内核；本方案将其**通道泛化**为「任意外部通讯/生产工具皆可接入」，不另造内核。

---

## 0. 结论先行

| # | 主张 | 判定 |
|---|---|---|
| 1 | 邮箱通道（IMAP/Exchange 邮件读入） | ❌ 0 实现 → 本方案新增通用 `generic-email` |
| 2 | 日历通道（iCal/CalDAV/Exchange 日历） | ❌ 0 实现 → 本方案新增通用 `generic-calendar` |
| 3 | 会议通道（Zoom/Teams/腾讯会议纪要/日程） | ❌ 0 实现 → 本方案新增通用 `generic-meeting` |
| 4 | 微信通道（企微会话/群聊/朋友圈线索） | ❌ 0 实现（历史占位假绿已识破）→ 本方案仅提供**契约与边界**，真实对接需企微 API 凭据，未接通不得宣称已接通 |
| 5 | 「提取客户详细信息 → 形成图谱」 | ⚠️ 图谱已存在但数据源=CRM 粒子，非外部通讯数据 → 本方案把 4 通道产出**汇入既有图谱构建管道**（见 §5） |

**总判**：需求② = 4 条通道 + 1 个图谱汇入点。方案 = **通道泛化（4 通用适配器模板）+ 复用 S2 同步内核 + 汇入既有图谱管道**。0 处新增粒子类型。

---

## 1. 架构一句话

```
外部通道（邮箱/日历/会议/微信）→ 通用通道适配器（generic-*，配置驱动）
        ↓ 契约三方法 verifyScope / fetchIncremental / extractEntities
        ↓ 归一化事件行（{channel, kind, ts, actor, participants[], content, external_id}）
        ↓ 入 S2 同步内核（engine/mapping/resolver/trust/gate 全复用，零新内核）
        ↓ 提取实体 → 图谱管道（CRM_ACCOUNT.payload.enrichment + sourcedFrom 弱边 + 账户记忆）
        ↓ 写操作过决策第 0 闸（L2/L3 才写，默认 L1 只读）
```

- **通道 ≠ 厂商**：`generic-email` 是通道类型，厂商差异（IMAP/Exchange/OAuth2）由 descriptor 表达，与 salesforce/neocrm/fxiaoke 预设同范式。
- **零新内核**：S2 的 engine/mapping/resolver/trust/gate/cursor 全部复用；新增的是「通道模板 + 事件行归一化 + 实体抽取」。

---

## 2. 铁律（不可逾越）

1. **§10 硬约束**：不新增粒子类型、不改业务域模型。通道产出只落 `CRM_ACCOUNT.payload.{enrichment,discovery}` + `sourcedFrom` 弱边 + 账户 append-only 记忆。
2. **唯一通用实现**：4 通道均为 `generic-*` 配置驱动模板（零厂商专属代码）；厂商差异 100% 在 descriptor（对齐 R3，同 salesforce 预设）。
3. **fail-closed**：凭据缺失/未配置 → `credentials_missing` 零请求（预期行为，非故障）；不 mock 出成功。
4. **信任分级**：默认 L1 只读（fetch+extract 不写）；L2 才批量入库；L3 才回写。**接入/映射/信任提升/启用回写四类动作过 review-gate 人工闸**（复用 S2 gate）。
5. **决策第 0 闸**：任何写（L2 入库 / L3 回写）每批携带 decision_id。
6. **隐私红线**：邮箱/微信属**高敏通道**；凭据必须进 credentialVault（不落描述符明文）；读取范围默认最近 30 天可配；**内容不落明文审计**，只落抽取后的结构化字段。
7. **图谱汇入而非新建**：复用既有 `ontologySync`/`monitorAccount` 管道；通道产出是**候选信号**，不是直接写库。

---

## 3. 通道模板（4 个 generic-*）

### 3.0 统一事件行契约（4 通道归一化输出）

```js
{
  channel: 'email' | 'calendar' | 'meeting' | 'wechat',
  kind: 'contact_change' | 'meeting_confirmed' | 'follow_reminder' | 'tender_push' | 'overdue',
  ts: 'ISO8601',             // 事件发生时间
  actor: { name, email? },   // 我方/对方主事人
  participants: [{ name, email?, corp? }],  // 对方参与者（实体抽取源）
  content: { subject, snippet, url? },      // 结构化内容（不落原始体）
  external_id: '通道侧唯一键',               // 幂等去重
  domain: '客户域名或企业名（抽取后回填）',
}
```

### 3.1 `generic-email`（IMAP/Exchange/企业邮）

| 项 | 取值 |
|---|---|
| 契约方法 | `fetchIncremental({since}) → rows[]`（新邮件） |
| descriptor | `{ type:'imap', host, port, tls, auth:{user,pass} }` 或 `{ type:'ms365', auth:{clientId,secret,tenant} }`（token-flow） |
| 归一化 | 发件人/收件人 → participants；主题/正文片段 → content；附件 URL → url |
| 实体抽取 | 邮箱域名 → 域名实体；签名/正文提及企业名 → 企业实体（对接既有企业识别） |
| 落点 | `CRM_ACCOUNT.payload.enrichment.email_intent[]` + sourcedFrom 弱边 |

### 3.2 `generic-calendar`（iCal/CalDAV/Exchange 日历）

| 项 | 取值 |
|---|---|
| 契约方法 | `fetchIncremental({since}) → rows[]`（新日程/改期/取消） |
| descriptor | `{ type:'caldav', url, auth }` 或 `{ type:'ms365', ... }` |
| 归一化 | 参与人/时间/地点 → 日程事件；改期/取消 → kind 信号 |
| 实体抽取 | 参与方邮箱/公司 → 企业实体；主题谈判/投标/拜访 → 阶段信号 |
| 落点 | `payload.enrichment.schedule[]`；**联动③日期驱动（tender_deadline/visit 信号）** |

### 3.3 `generic-meeting`（Zoom/Teams/腾讯会议）

| 项 | 取值 |
|---|---|
| 契约方法 | `fetchIncremental({since}) → rows[]`（会议记录/纪要/日程） |
| descriptor | `{ type:'zoom'|'teams'|'tencent', auth:{...} }`（token-flow 通用模型已支持） |
| 归一化 | 参会人/时长/纪要摘要 → meeting 事件 |
| 实体抽取 | 参会邮箱域名 → 企业；纪要点名客户/竞品 → 意图/异议信号 |
| 落点 | `payload.enrichment.meeting_intents[]` |

### 3.4 `generic-wechat`（企微会话/群聊）—— **只给契约与边界**

| 项 | 取值 |
|---|---|
| 契约方法 | `fetchIncremental({since}) → rows[]`（会话消息摘要） |
| descriptor | `{ type:'wecom', corpId, agentId, auth }`（企微 API） |
| 边界 | **个人微信无开放 API**（历史假绿已识破）；企微会话读取需企业授权+合规审批；**未接通不得宣称已接通** |
| 归一化 | 群聊成员/消息摘要 → 参与者；客户提问/意向 → 信号 |
| 落点 | `payload.enrichment.wechat_intents[]`（仅授权租户） |

---

## 4. 与 S2 内核的复用（零新增内核）

| S2 组件（已交付） | 本方案复用方式 |
|---|---|
| `src/sync/engine.js` | 通道行 → map → upsert，原样复用 |
| `src/sync/mapping.js` | 通道事件行 → 粒子 payload 映射（新增通道专用映射模板） |
| `src/sync/resolver.js` | external_id 幂等去重（通道 external_id 即去重键） |
| `src/sync/trust.js` | L1 只读 / L2 入库 / L3 回写 |
| `src/sync/gate.js` | 四类动作人工闸（接入通道 / 映射变更 / 信任提升 / 启用回写） |
| `src/sync/cursor.js` | 游标留痕（按通道×对象） |
| `src/sync/factory.js` | `SYNC_PROVIDER_FACTORY` 增 `generic-email/calendar/meeting/wechat` 键（同 generic-rest 范式） |
| `src/scheduler/timers.js` ⑩ | 定时器按租户轮询通道（enabled 判定复用） |

> **本质**：需求②与需求④是**同一内核的两个接入面**——④接 CRM 记录、②接通讯/生产工具。均「配置驱动 + 通用适配器 + 信任分级 + 第 0 闸」。

---

## 4.5 首次配置：系统主导的 Onboarding 向导（用户问题 2-①，参照 ATTIO 冷启动重写）

> **参照 ATTIO（核心认知修正）**：Attio 冷启动 = "**Self-building — Live from day one. Connect your inbox and calendar. Attio learns your business and builds itself around it**"。
> **本质**：**不是用户找入口，是系统首次使用时自动弹向导、主动问**。用户在首次登录或首次使用工具时，系统自动引导填入常用邮箱/密码、企业微信/飞书/钉钉账号、个人微信（可选）——**用户无需知道"配置页在哪"，也不需要键入任何命令**。
> **参照 Rox**（持续价值）：先用「读」进入（把用户已有系统当数据源）→ 用「回写」证明价值 → 渐进建立信任。**首次只读、不写**，打消"刚用就要授权写"的顾虑。

### 4.5.0 触发时机（系统主导，非用户寻找）

| 触发点 | 时机 | 形态 |
|---|---|---|
| **首次登录**（Web 门户） | 用户第一次登录 CRM 门户，检测到 `integration-providers` 为空（0 通道已接入） | **全屏 Onboarding 向导**（3 步，Attio "Live from day one"） |
| **首次使用**（WorkBuddy/插件） | 用户第一次打开销售助手胶囊/对话，检测到未接入任何通道 | 对话内**主动问候 + 接入卡片**（不要求用户键入命令） |
| **引导路径** | 上述两类入口都指向**同一个向导引擎** | 后端零差异（同一 Action/同一 vault/同一 config_store） |

> **key 判定**：接入状态为「0 通道」时**系统是主角**——主动弹向导、主动问；用户已有通道后系统才退居配角（补充通道走自助台，见 4.5.3）。

### 4.5.1 向导三步（两种入口共用同一引擎）

| 步 | 系统动作（主动） | 用户动作（回答即可） | 闸门 |
|---|---|---|---|
| **① 欢迎与问卷** | 弹「欢迎使用 · 让系统认识你的工作环境」卡片：列出**常用邮箱地址/密码**、**企业微信/飞书/钉钉账号**、**个人微信（可选，标注"未接入不影响核心功能"）**、日历（可选）——**全部默认可跳过** | 逐项填写或勾选跳过；密码/账号字段**直进 credentialVault**（明文不落会话/审计） | 读收集，无写闸 |
| **② 验证与说明** | 对已填项 `verifyScope`**真实探测**（fail-closed：凭据缺→`credentials_missing` 明确提示"该通道需补齐凭据"）；展示探测结果（邮箱域名/账号归属/可取对象清单）；**明确说明"当前只读，不会主动写你的系统"** | 确认探测结果，或修正凭据重试 | fail-closed（不 mock 代真） |
| **③ 确认接入** | 「以上通道可接入，确认？」卡片汇总本次接入清单 | 一键确认（或取消单条） | **接入=四类动作之一，过 review-gate 人工闸（HITL）**；信任档默认 **L1 只读** |

> **向导完成后**：描述符落 `config_store['integration-providers']`（enabled:true）→ 定时器⑩ 开始按 enabled 轮询 → **首轮全量拉取最近 30 天（游标空）→ 归一化 → 图谱汇入**。
> **用户全跳过也无障碍**：向导可整体跳过，系统进入「未接入」态，后续随时可再触发（4.5.3），功能不阻塞。

### 4.5.2 两种承载入口（向导引擎同一，外壳不同）

| 入口 | 承载形态 | 触发 | 对齐 |
|---|---|---|---|
| **A. WorkBuddy（对话内向导）** | 首次打开助手 → **系统主动发问候卡**：「检测到你还没接入邮箱/日历，需要现在配置吗？」→ 卡片内嵌 4 个输入项 | 系统主动，非用户键入命令 | Attio "connect inbox & calendar" / Rox "meet users where they are" |
| **B. 网页（门户内向导）** | 首次登录门户 → **全屏 3 步向导**（欢迎→填写→确认） | 登录后自动弹出（`integration-providers` 空时） | Attio "Live from day one" |

> **用户后续仍想主动配置**：两种入口都保留「通道配置台」（P3），供补通道/改凭据/升降信任档——但**首次体验绝不要求用户去找它**。

### 4.5.3 首次 vs 持续（接入后状态迁移）

| 状态 | 系统行为 | 用户入口 |
|---|---|---|
| **0 通道（首次）** | **系统主动弹向导** | 回答问卷即可，无需找入口 |
| **≥1 通道（日常）** | 系统退居配角：定时轮询/图谱增量/随时问答 | 「通道配置台」自助（补通道/改凭据/信任档） |
| **信任提升** | 默认 L1 只读起步 | L2/L3 需求 → 业务批准（独立闸门动作） |

> **一句话**：**首次 = 系统问、用户答；之后 = 用户问、系统答。** 这与 ATTIO "系统先认识你、再围绕你构建"完全同构，同时守住我方「接入/信任提升必过人工闸、凭据入保险库、首次只读」三条红线。

### 4.5.4 失败语义：拒因必须透传（2026-09-18 补充 · 实测驱动）

**背景**：设计 §4.5.1 步骤② 的 fail-closed 已保证「探测不过不放行」，但**只解决了"要不要放行"，没解决"为什么不放行"**。2026-09-18 用真实租户邮箱（163 个人邮箱）实测暴露：

| 层 | 实测事实 | 若吞掉拒因的后果 |
|---|---|---|
| TCP/TLS | `imap.163.com:993` 握手成功（Coremail IMap Server Ready） | — |
| 协议 | 我们发 `A1 LOGIN ...`，服务端回 `A1 NO LOGIN Login error or password error` | — |
| 语义 | 真因＝**国内邮箱 IMAP 只接受「客户端授权码」**，登录密码必被拒 | 页面只显示 `auth_failed` → 用户（含本系统作者）只会反复改密码；**方向被误导，属「假失败」** |

**条款（三件必须同时成立）**：
1. **探针层**：连接/认证/协议失败时，除可区分错误码外，必须把**服务端响应原话**脱敏后带回（`hint`）；脱敏＝抹掉本次发送过的 user/pass/host 字面量，截断 200 字符，明文凭据永不出现在响应或日志。
2. **透传层**：`verifyScope` 与 `channelRouter` **不得吞字段**——失败透传 `missing`（缺哪个字段）与 `hint`（为什么被拒）；成功透传 `detail`（真的取到了什么，如会议条数），以区分「连上了」与「取到了数据」。
3. **呈现层**：页面把 `hint` 原样呈现，并**按通道**追加可执行的下一步（如邮箱 `auth_failed` → 「163/126/QQ 须用客户端授权码：设置→开启 POP3/SMTP/IMAP→生成授权码」）；**跨通道不得套话术**（日历 401 不许出现邮箱授权码引导）。

> **判据**：失败提示若不能指向一个**不同的下一步动作**，则该提示不合格——它与「密码错」无法区分，用户只能靠猜。
> **验证要求**：该条款由运行期校验器 `scripts/verify-onboarding-guide-hints.mjs` 锁定（真跑 `doVerify` 断言页面输出文本，含跨通道误报反例），并以两组变异自证鉴别力（删分支 / 放宽通道条件各杀一条断言）。

---

## 4.6 每次持续的互动模式（用户问题 2-②）

> **对标**：Attio "**Ask, and it's there**"（常驻 Agent，随时问随时答）；Rox "Agent Swarms 常驻 + 在恰当时机浮现高价值洞察 + **meet sellers where they are**（iOS/Mac/Slack/API，不逼用户多登一个系统）"。

### 4.6.1 四种常驻互动（按触发方式分层）

| 模式 | 触发 | 用户侧形态 | 对应 Attio/Rox |
|---|---|---|---|
| **A 随时问** | 用户在 WorkBuddy 对话框提问「这个客户最近邮件说了什么」 | `channel-query` Action → 读 vault 凭据 → `fetchIncremental` 近 N 天 → 返回结构化摘要 | Attio "Ask, and it's there" |
| **B 定时浮现** | 定时器⑩ 轮询通道 → 归一化事件行 → 命中既有规则（tender/visit/overdue） | WorkBuddy 推送卡 / 网页「外部沟通维度」时间线 | Rox "Agent Swarms 常驻、恰当时机浮现洞察" |
| **C 图谱增量** | 新事件行 → 实体抽取 → 命中既有 CRM_ACCOUNT | account-360 视图「外部沟通时间线」区块自动更新 | Attio "It gets to know you"（自动学习） |
| **D 回写联动** | L3 租户：通道事件 → 回写 dispatcher → 决策第 0 闸 → 写回客户 CRM | 客户 CRM 侧出现我方结构化记录（可过滤 Source 标记） | Rox "回写任何富化/编辑内容到客户 CRM + 静态值标记" |

### 4.6.2 每次互动的标准循环（A/B 共通）

```
用户触发（问/推） → channel-query/fetchIncremental（读，走 vault 凭据）
→ 归一化事件行 → 实体抽取 → 图谱匹配（命中既有 CRM_ACCOUNT）
→ 返回结构化摘要（不落原始明文；内容只落抽取字段）
→ 若 L2/L3 且需写：决策第 0 闸 mint decision → 幂等入库 → sourcedFrom 弱边
→ 用户侧呈现（对话卡 / 页面时间线）
```

> **关键**：**每次互动都是「读优先」**——默认只读抽取+匹配；写（入库/回写）只在信任档达标且过第 0 闸时才发生。这既对齐 Attio 的"自动学习"，也守住我方「AI 不擅写」的零信任红线。

### 4.6.3 互动频率与数据新鲜度（配置化）

| 项 | 默认 | 配置键 |
|---|---|---|
| 通道轮询间隔 | 30 分钟（日历/会议）/ 15 分钟（邮箱） | `channel-poll.interval_ms` |
| 抽取时间窗 | 最近 30 天（可配） | `channel-poll.window_days` |
| 图谱命中阈值 | confidence ≥ 0.6 | `channel-graph.confidence_min` |
| 回写 Source 标记 | `via=ChiYuAI`（可过滤可识别） | `writeback.source_tag` |

> 全部走 config_store，**零代码字面量**——对齐「阈值/行业差异化 100% 配置化」铁律。

---

## 4.7 外部参照深度分析：Rox 与 Lightfield 究竟怎么做（2026-09-17 补充）

> 素材来源：Rox 官网 agent-workflows 页 + 官网客户引证（2026-09-17 抓取）；Lightfield 一手博客 `agentic-data-import-in-lightfield` / `why-we-built-lightfield`（2026-09-17 抓取）；本地底稿 `docs/2026-09-15-attio-lightfield-rox-three-way-comparison.md`（含 rox.com 官方文档原文引文）。

### 4.7.1 Rox：接上就完了——「行动系统」的冷启动与持续互动

**定位**：Rox 自我区分于传统 CRM 的话术是「记录系统 vs 行动系统」——传统 CRM 被动等录入、数据滞后；Rox 让 AI 智能体集群（Agent Swarms）主动执行，人只做决策。但更关键的是它的**进入姿态**：

> 对 Salesforce 公开姿态："*complementary, not competitive*"；"*Rox integrates with Salesforce, HubSpot, and other CRM platforms and does not require Salesforce as the foundational layer*"。（rox.com/articles/rox-vs-salesforce-agentforce）
> 终局明牌（官方文档原文）："*customers will graduate to a warehouse-native future where Rox writes directly to their warehouse (**and let's be honest: in that future, Rox is the CRM**)*"

**冷启动三板斧**（对本方案 §4.5 的直接启示）：

| 板斧 | Rox 做法 | 对 §4.5 的启示 |
|---|---|---|
| **① 零风险进入** | 不要求换系统：连接客户已有 Salesforce/Zendesk/Slack/邮件/会议等 100+ 工具，官方口径「1 天上线、零迁移成本」 | 我方本土反转——**「你不在任何 CRM 里，我就接你的『事实发生地』：企微/飞书/钉钉 + 邮箱 + 日历 + 会议」**。向导第①步只问 4 项、全默认可跳过，就是「零迁移」的等价物 |
| **② 价值前置到第一小时** | 官网客户引证："*Within the first hour of onboarding a rep into Rox, it was like, 'we just saved you 80% of your day'*"（Sr. RevOps Manager, $1.6B 公司） | 向导完成≠价值完成。**接入后系统应立即主动交付「第一小时价值物」**（如：「过去 30 天你与 X 客户的 12 封往来邮件、3 个会议已汇入客户图谱，点击查看」）——而非等用户自己来问 |
| **③ Day-one 情报** | 新销售代表入职第一天，接手的每个账户就有 AI 组装好的上下文（account intelligence from day one），**无需手动补录历史** | 对应我方「首轮全量拉取最近 30 天（游标空）→ 归一化 → 图谱汇入」——历史回灌必须在向导完成时**自动发生**，用户零操作 |

**持续互动**（对本方案 §4.6 的直接启示）：

- **Agent Swarms 常驻**：调研/执行/会议/预警智能体 7×24 运转，恰当时机浮现洞察（预警智能体「只标记不到 10% 的公共领域事件」——**浮现纪律**：宁缺勿滥）。
- **Command 指令台**：自然语言一句话下达任务（「帮我制定 A 客户 3 个月跟进计划」）→ 对应 §4.6.1 A 模式（随时问）。
- **Plays 定时剧本**：官方示例「每周一 9am 生成 forecast 发 Slack」「每周五汇总上周 closed-won 发 #sales」→ 对应 §4.6.1 B 模式（定时浮现），且印证了**浮现内容必须是业务产出物**（forecast/摘要/简报），不是原始数据流。
- **Agent Workflow 四步创建**：官方原文 "**1 Describe the task in plain English → 2 Answer a few clarifying questions → 3 Preview and test the workflow → 4 Let it run**"。**注意：这就是「首次=系统问、用户答」在工作流创建上的翻版**——用户用人话描述意图，系统用澄清问题收齐参数，预览确认后放手。§4.5 向导三步与它是同构的。

### 4.7.2 Lightfield：零录入零配置——「Save → Understand → Act」

**哲学**（why-we-built-lightfield 一手原文）：**「零录入、零配置、零负担」**——系统自动看到发生了什么，而非用户录入。销售只管 Save（邮件/日历/会议/文档自然发生），系统 Understand（自动捕获、理解），然后 Act。

**首次配置的真实形态**（agentic-data-import 一手原文）：

| 环节 | LF 做法 | 与我方 §4.5 的对应 |
|---|---|---|
| **数据搬入** | Agentic data import：上传 CSV → agent 自己读结构 → **生成字段映射** → 用户确认 → 自动导入（90k 记录/小时）。官方类比："*像对待能干的同事一样把文件交给它——读取、推断结构、提出映射、你确认、它干活*" | §4.5 步骤③「确认接入」= **LF 的「用户确认映射」人工闸位**。差别只在搬的东西：LF 搬存量 CSV，我方接增量通道 |
| **连接数据源** | 连接 inbox/calendar 后**自动回灌最多两年历史**；官方口径："*Connection is a one-time, pre-configured foundation — after first-use connect, data flows in automatically*" | 「连接=一次性前置基础，之后数据自动流入」——正是 §4.5.3 状态迁移表的 LF 版表述，可作为该节的设计背书 |
| **首入动线** | 首次使用 = 连接数据源 → **直接开始提问**。没有配置表单页、没有字段映射向导、没有「设置中心」 | §4.5「首次绝不要求用户去找配置台」的直接先例 |

**对我方的适配点**：LF 证明「确认」环节可以压到最薄——系统干所有活，人只在一个汇总卡上点一次确认。§4.5.1 步骤③的「一键确认（或取消单条）」与之完全同构；历史回灌窗口（LF 两年 vs 我方默认 30 天）应保持配置化（`channel-poll.window_days`），**不为对齐 LF 而扩大默认隐私窗口**。

### 4.7.3 三家对照（一句话定位 + 关键维度）

| 维度 | Attio | Lightfield | Rox |
|---|---|---|---|
| **一句话定位** | 「搬过来」——self-building CRM | 「搬过来但 1 小时」——agentic import | 「接上就完了」——不换系统 |
| **数据从哪来** | 自建记录系统（客户搬入） | 自建记录系统（agent 搬入） | **借用客户系统**（只建上下文与图） |
| **对既有 CRM 姿态** | 要求搬迁 | 要求搬迁（把摩擦降到 1 小时） | **共生**（"complementary, not competitive"） |
| **首次配置** | 连接 inbox/calendar → 系统围绕你构建 | 连接数据源 → 直接开始提问 | 接上现有工具 → 第一小时出价值 |
| **持续互动** | Ask, and it's there | 自动捕获 + 随时问 | Agent Swarms + Command + Plays |
| **对我方最大启示** | 首次=系统问用户答（§4.5 已取） | 连接=一次性基础，数据自动流入（骨架） | 先读后写、第一小时价值、浮现纪律（护栏） |

> 本地对照底稿（2026-09-15）的重要修正仍然有效：Rox 的「不淘汰现有系统」**对我方对象不匹配但直接适用**——Rox 客户已有 Salesforce 可接，我方目标客户（B2B 制造/医疗/化工）多数**没有**成建制 CRM，其「事实发生地」是企微/飞书/钉钉 + 邮箱 + Excel + 会议。需求②的通道适配器正是接这些。

### 4.7.4 融合建议（本方案的最终取位）

> **一句话**：**以 Lightfield 的「连接即基础、数据自动流入」为骨架，以 Rox 的「先读后写、第一小时价值」为护栏，以我方三条红线（vault/HITL/fail-closed）为底盘。**

| 取位 | 来源 | 落点 |
|---|---|---|
| **骨架** | LF：连接=一次性前置基础 → 数据自动流入 | §4.5 向导完成后定时器⑩自动轮询（已具此结构）；向导完成即触发首轮全量回灌，用户零操作 |
| **护栏一：先读后写** | Rox：先用「读」进入，用「回写」证明价值 | §4.5 信任档默认 L1 只读；§4.6 D 回写仅 L3+人工闸（已具此结构） |
| **护栏二：第一小时价值** | Rox："saved you 80% of your day" | **增量项**：向导完成后系统主动发「第一小时价值物」报告（汇入了哪些客户、多少邮件/会议/日程，附 account-360 链接）——将此补入 P3 验收 |
| **护栏三：浮现纪律** | Rox：预警只标记 <10% 事件 | §4.6.3 配置化阈值之外，浮现卡**必须带业务结论**（命中哪条规则、建议动作），禁止裸推原始数据流 |
| **底盘** | 我方独有红线 | 凭据入 vault、verifyScope 真探测 fail-closed、接入过 review-gate——三家均未明说此层，**不放松** |

**对 §8 决策点的修正建议**（深度分析后更新，**2026-09-17 已由用户裁决**）：
- **决策点④（首次配置入口优先级）**：~~修正原「WorkBuddy 先行」建议 → 网页全屏向导先行（P1）~~ → **✅ 用户裁决：WorkBuddy 对话入口先行**（对齐 Attio 冷启动；网页向导随 P3 交付）。两入口仍是同一引擎（§4.5.2 不变）；WorkBuddy 问候卡是离价值最近的入口，网页全屏向导兜底补上。
- **决策点⑤（持续互动范围）**：~~维持 A+B 先行~~ → **✅ 用户裁决：四种全做**（问/推/图增/回写）。C 图谱增量随 P2 汇入管道自然获得；D 回写依赖 L3 信任档批准，随信任提升触发。

---

## 5. 图谱汇入（形成图谱的真正落点）

- **既有图谱**：`CRM_ACCOUNT`（客户）↔ `CRM_DEAL`（商机）/ `CRM_CONTACT`?（既有粒子）↔ sourcedFrom 弱边 + `payload.enrichment`（本体富集）+ `account-insight.html`（360 视图）。
- **本方案汇入**：4 通道抽取出的实体 → 既有 `providerRegistry` 富化流程（`enrich` 契约已有）→ 域名/企业识别 → 命中既有 CRM_ACCOUNT → 追加 `payload.enrichment` + sourcedFrom 弱边（`autoWeakEdge` 范式）。
- **不新造图谱**：不新建粒子类型、不新建图数据库——图谱 = 既有粒子图（pgvector 边 + 记忆），通道只是**新的边来源**。
- **「客户详细信息」**：通道抽取的 email 域名/参与者/会议意图/日程信号 → 汇入 account-360 视图 = 形成「外部沟通维度」的客户图谱。

---

## 6. 分阶段交付（待批准后执行）

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 通道模板骨架：统一事件行契约 + generic-email/calendar/meeting/wechat 四个 template + 工厂注册（`SYNC_PROVIDER_FACTORY` 增 4 键） | 模板可构造；契约单测（fail-closed 凭据缺失） |
| P2 | 通道→图谱汇入：事件行→实体抽取→enrichment 追加 + sourcedFrom 弱边（复用 monitorAccount） | 通道产出可汇入既有图谱管道；幂等去重 |
| P3 | 前台呈现：account-360 增加「外部沟通维度」区块（通道信号时间线）+ 通道配置页 | 页面呈现通道抽取结果；配置页可配凭据 |
| P4 | 真实通道连通（Q2 类缺口）：需租户提供真实凭据（企业邮/企微授权）后实测 | `fetchIncremental` 返回真数据；**未接通不得宣称已接通** |

> P1–P3 可先行（模板+汇入+呈现，mock 可测）；P4 依赖真实凭据，同需求④ Q2-5 红线：**真实连通才算数**。

---

## 7. 与四需求关系（防漂移再确认）

| 需求 | 落点 |
|---|---|
| ① 拓客 | lead-pool + discovery（已补齐前台三缺口） |
| ② 邮箱/日历/会议/微信 | **本方案**（4 通道 + 图谱汇入） |
| ③ 日期驱动 | signal 链（contact_change/relation_cooling/tender_deadline/report_due + ICS） |
| ④ 原 CRM 集成 | `docs/2026-09-17-tenant-sync-onboarding-handbook.md`（一次性抽取/定时/回写） |

---

## 8. 待批准问题（决策点）

~~1. 通道优先级：P1 四模板一次做齐，还是先做邮箱+日历（会议/微信后置）？~~ **✅ 裁决 2026-09-17：P1 四模板一次做齐**
~~2. 隐私合规：邮箱/微信内容抽取是否限定「最近 N 天 + 仅结构化字段」？~~ **✅ 裁决 2026-09-17：默认 30 天，可配**
~~3. 图谱汇入粒度：通道信号直接汇入 enrichment（自动），还是先入候选池（人工圈选）？~~ **✅ 裁决 2026-09-17：直接汇入 enrichment（自动）**
~~4. 首次配置入口优先级（§4.5）：WorkBuddy 对话入口与网页自助台哪个先行？~~ **✅ 裁决 2026-09-17：WorkBuddy 对话入口先行**（对齐 Attio 冷启动；网页向导随 P3 交付）
~~5. 持续互动范围（§4.6）：四种常驻互动是否全做？~~ **✅ 裁决 2026-09-17：四种全做**（问/推/图增/回写）

> 待批准后进入 writing-plans（按 P1→P4 分 Task，每个 Task 含完整代码与测试，同 S2 计划格式）。
> 用户 2026-09-17 追加问题已在 §4.5/§4.6 落为「首次配置（WorkBuddy/网页两入口）+ 持续互动（问/推/图增/回写）」，对标 Attio（connect inbox & calendar 冷启动、Ask-and-it's-there）与 Rox（先用读进入、回写证明价值、meet sellers where they are）。
> **2026-09-17 Rox/LF 深度分析后修正**（见 §4.7）：决策点④原建议「网页全屏向导先行」**已被用户裁决改回「WorkBuddy 对话入口先行」**（对齐 Attio 冷启动；网页向导随 P3）；决策点⑤**用户裁决四种互动全做**（问/推/图增/回写）。仍保留的深度分析增量：「**第一小时价值物报告**」为 P3 验收项 + B 模式浮现纪律（浮现卡必带业务结论，禁裸推原始数据流）。融合口径：**LF 骨架（连接即基础、数据自动流入）+ Rox 护栏（先读后写、第一小时价值）+ 我方红线底盘（vault/HITL/fail-closed）**。
