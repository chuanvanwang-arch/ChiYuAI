# 需求② · 邮箱 / 日历 / 会议 / 微信 统一适配器设计方案（v0 待批准）

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

1. **通道优先级**：P1 四模板一次做齐，还是先做邮箱+日历（会议/微信后置）？
2. **隐私合规**：邮箱/微信内容抽取是否限定「最近 N 天 + 仅结构化字段」？（默认 30 天，可配）
3. **图谱汇入粒度**：通道信号直接汇入 enrichment（自动），还是先入候选池（人工圈选）？（对齐①的公海认领模式）

> 待批准后进入 writing-plans（按 P1→P4 分 Task，每个 Task 含完整代码与测试，同 S2 计划格式）。
