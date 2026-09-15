# 标讯主动搜索（tender active search）接入方案

> 状态：设计稿 v1（2026-09-15 brainstorming 收敛，用户批准「双模式：主动搜索 + 订阅推送」）
> 日期：2026-09-15
> 定位：把标讯（tender）从「仅被动接收订阅推送」扩展为「**像 anysite 一样可主动搜索**」的数据源，接入拓客（prospecting）管道。
> 结论先行：核心改动 = `tender.js` 增加 `async search()`（主动抓取公开招标公告 → 解析候选）+ 注册进 `prospecting-rules.sources`；订阅推送（`conn-tender-push`）全部复用，**不新增粒子类型、不改业务域模型、写走第 0 闸 + 两阶段确认**。

---

## 0. 背景与差距

### 0.1 现状（源码核实）

| 项 | 现状 | 锚点 |
|---|---|---|
| tender 适配器 | 只有 `enrich()`（从 `ctx.tenders` 缓存流取命中），**无 `search()`** | `src/connectors/discovery/adapters/tender.js:14-29` |
| 数据源设计 | 官方设计 = **大单网**（dadan.vip），订阅/推送形态 | `docs/2026-08-24-ai-native-sales-crm-design.md:182-183,628` |
| 拓客配置 | `prospecting-rules.sources` = `{qixin, xinbang, anysite}`（**无 tender**） | `src/config/prospectingRules.js:17-21` |
| 订阅管道 | `conn-tender-push`（第 0 闸 + confirm stage2 + sourcedFrom 弱边） | `src/connectors/connectorActions.js:95-126` |
| 匹配逻辑 | `filterTenders(sub, tenders)`（标题关键词 + 区域） | `src/connectors/tenderConnector.js:13-33` |

### 0.2 差距

1. **无主动搜索**：对话内「查北京 ERP/CRM 招标」无法实时返回——只能等外部把标讯推进来（`ctx.tenders` 注入）。
2. **未进拓客管道**：`prospecting-search` 的 `resolveAdapters({providers})` 只解析已启用源，tender 未注册 → 即使适配器有 search 也不会被调用。
3. **数据源形态存疑**：大单网（dadan.vip）实测为 **SPA**（疑似 API 路径全部回退 index.html），**无公开 JSON API**——「订阅推送」形态的实现在源码中只有接收端（`conn-tender-push`），**拉取端从未落地**。

### 0.3 实测结论（2026-09-15 trust-but-verify）

| 源 | 可抓取 | 链接结构 | 备注 |
|---|---|---|---|
| dadan.vip（大单网） | ✅ 200 但 SPA | 无服务端渲染列表 | **无公开 JSON API**（/api/search 等回退 index.html） |
| gxjtzb.com（采购招投标网） | ✅ 200 | 84 个 .html/.htm 链接 | 服务端渲染，可解析公告列表 |
| ccgp.gov.cn（政府采购网） | ✅ 200 | 134 链接 | 服务端渲染 |
| ccgp-beijing.gov.cn（北京市政采） | ✅ 200 | 195 链接 | 服务端渲染 |

**结论**：标讯主动搜索的可行形态 = **抓取公开招标公告站列表页 → 解析标题/链接/地区 → 标题含关键词（ERP/CRM）+ 区域（北京）过滤**。与既有 `filterTenders`（标题关键词+区域）**完美同构**。

---

## 1. 设计目标（双模式）

```
模式 A（主动搜索，本次新增）： 一句话「查北京 ERP/CRM 招标」→ tender.search() 实时抓取公告站 → 候选
模式 B（订阅推送，既有复用）： conn-tender-push 订阅（关键词/区域）→ 自动生成 S0 商机
```

两者共用 `filterTenders` 匹配语义（标题关键词 + 区域），零重复逻辑。

---

## 2. 方案 A：tender 适配器增加 `search()`

### 2.1 适配器签名（对齐 anysite/qixin 范式）

```js
async search(query = {}, ctx = {}) -> [candidate, ...]
// query: { keywords/industries → 关键词, geo → 区域, limit/count }
// candidate: { id, title, region, amount?, buyer?, published_at, url, tender_match:true, provider:'tender' }
```

- **关键词映射**：`query.keywords`（如 `"ERP"|"CRM"`）或 `query.industries`（如 `['ERP','CRM']`）→ 抓取词
- **区域映射**：`query.geo`（如 `['CN-BJ']` / `['北京']`）→ 标题/地区匹配「北京」
- **抓取源**：可配置列表（`config` 驱动，出厂 = `[gxjtzb.com, ccgp-beijing.gov.cn]`），逐个尝试，**全失败 fail-open 返回 `[]`**
- **解析**：抓列表页 HTML → 提取标题/链接/地区/时间 → 本地 `filterTenders({keywords, region}, tenders)` 过滤
- **候选字段**：`tender_match: true`（命中 `discoveryRules.signals.tender_match` 权重 0.8）→ 进 fit_score

### 2.2 铁律（对齐 anysite.js）

| 铁律 | 说明 |
|---|---|
| fail-open | 无凭据/抓取失败/解析空 → 返回 `[]`，不抛业务异常 |
| 不得注入 fit_score | 适配器只返回原始画像/信号字段；fit_score 由服务端 `computeFitScore` 计算（修订 2 契约） |
| 匹配语义复用 | 过滤走 `filterTenders`（tenderConnector.js:13-33），不重复造 |
| 不新增粒子类型 | 候选只在会话内存，落库走既有 `createLeadFromTender`（S0 公海） |

### 2.3 数据源配置（驱动化）

```js
// config: config_store['prospecting-rules'].sources.tender = {
//   enabled: true, weight: 0.8,
//   source_urls: ['https://www.gxjtzb.com/', 'http://www.ccgp-beijing.gov.cn/'],
//   region_keywords: ['北京', 'Beijing'],   // 本地区域过滤词（公告站无城市级筛选）
// }
```

---

## 3. 方案 B：订阅推送（既有复用，零新增）

- 订阅条件（关键词/区域）可配置：`config_store['prospecting-rules'].sources.tender.subscription = { keywords:['ERP','CRM'], region:'北京' }`
- 外部标讯流注入 `ctx.tenders`（既有机制）→ `conn-tender-push` 命中 → 自动生成 `CRM_DEAL(stage:'S0', pool_type:'new', source:'标讯')` + sourcedFrom 弱边
- 走第 0 闸（autoDecision）→ HITL 两阶段确认（confirm stage2）

**本次不做**：自动定时抓取+推送（需新定时器）。先落地「对话主动搜索」，定时拉取列为后续（YAGNI）。

---

## 4. 接入拓客管道（prospecting）

| 步骤 | 改动 | 锚点 |
|---|---|---|
| 1 | `DEFAULT_PROSPECTING_RULES.sources` 增加 `tender: { enabled:false, weight:0.8 }` | `src/config/prospectingRules.js:17-21` |
| 2 | 运行时写 `config_store['prospecting-rules'].sources.tender.enabled=true`（运维脚本，幂等 upsert） | `scripts/tmp-enable-tender.mjs` |
| 3 | `prospecting-search` handler 自动解析 tender（resolveAdapters 已遍历 enabled sources） | `src/action/prospectingActions.js:75-77` |
| 4 | tender 候选 `signals.tender=true` → `computeFitScore` 加权（signals.tender=0.8） | `src/config/prospectingRules.js:16` |

---

## 5. 端到端流程

```
用户「查北京 ERP/CRM 招标」
  → prospecting-search (query={keywords:"ERP|CRM", geo:["北京"]})
  → resolveAdapters → tender adapter 已启用
  → tender.search(): 抓 gxjtzb/ccgp-bj 列表页 → 提取公告 → filterTenders(关键词+北京) 过滤
  → 返回候选 [ { title:"...ERP系统建设项目", region:"北京", amount:350万, tender_match:true }, ... ]
  → 候选带 fit_score（服务端计算，tender 信号权重 0.8）
  → 用户圈选 select → 确认 confirm（第 0 闸 + 两阶段 confirm_token）
  → 批量 createLeadFromTender → CRM_DEAL S0 公海 + sourcedFrom 弱边
```

---

## 6. 验收标准（可断言）

| # | 判据 |
|---|---|
| V1 | `GET /api/action/prospecting-search`（query 北京 ERP/CRM）返回候选，provider='tender'，含真实公告标题/区域/金额 |
| V2 | 无凭据/抓取失败 → 返回 `[]`（fail-open，不 500） |
| V3 | 候选 `tender_match=true` → fit_score 按信号权重 0.8 计算（服务端） |
| V4 | 圈选 + 确认（MCP 两阶段）→ 生成 `CRM_DEAL S0 + source:'标讯'` + sourcedFrom 边，有真实 decision_id |
| V5 | REST 旁路 confirm 被第 3 闸拦（`gate:'approval_required'`）——安全设计不变 |

---

## 7. 写后自查（brainstorming P7）

| 检查项 | 结论 | 证据 |
|---|---|---|
| 占位符 | ✅ 无 | 全文无 TODO/TBD |
| 矛盾 | ✅ 无 | 方案 A（search）与 B（订阅）复用同一 `filterTenders`、互不冲突 |
| 歧义 | ✅ 已消除 | 抓取源配置驱动（§2.3）；候选只是列表，落库必走第 0 闸（§5） |
| 范围 | ✅ 守界 | 不新增粒子类型、不改业务域模型、不新增 Action（复用 conn-tender-push）、写走第 0 闸 |

---

## 8. 实施实证（2026-09-15 落地 + 修复两个存量缺陷）

> 批准后按 §2/§4 实施。实施完成，以下为实证记录（trust-but-verify）。

### 8.1 实施结果（对照验收 V1-V5）

| 验收 | 结果 | 证据 |
|---|---|---|
| V1 | ✅ | `prospecting-search`（REST + MCP）返回 `provider='tender'` 候选，ERP=2 条（北京京企融创/北京建筑机械化研究院），标题干净、region=北京、URL 完整 |
| V2 | ✅ | 无效关键词 `不存在的领域XYZ123` → tender 0 条、HTTP 200 不抛错（fail-open） |
| V3 | ✅ | 候选 `signals.tender=true` → 服务端 `fit_score=0.286`（tender 信号权重加权） |
| V4 | ✅ | MCP 两阶段 confirm（phase1 取表单 → phase2 confirm_token）→ `CRM_DEAL S0 + pooled_at` + `sourcedFrom` 边（真实 decision_id） |
| V5 | ✅ | REST 旁路 confirm（无 confirm_token）→ 第 3 闸 `approval_required` 拒绝（fail-closed） |

### 8.2 标题噪音清洗（gxjtzb 转载条目）

- 实测源站标题带 `『招标』`/`关于//2026年度】`/`【公告】`/`2026年-` 等转载前缀 → `extractTenderLinks` 增加前缀剥离正则族 + 尾部 30 字符去重锚点（同源转载条目收敛为一条）。
- 效果：ERP 检索 8 条噪音 → 2 条干净。

### 8.3 修复存量缺陷 ①：sourcedFrom 边从未建成（2026-09-15）

- **根因**：`prospectingActions.js` confirm 段 `createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', 'prospecting:<cand.id>', ...)` —— `crm.edges.target_id` 是 **UUID NOT NULL**，传字符串 id → INSERT 抛错被 `.catch(() => {})` **静默吞掉**，边从未真正落库（此前设计/审计认为已建，实测 0 条）。
- **修复**：先建 `CRM_KNOWLEDGE` 粒子（`term=公告标题`、`kind=icp`、`content=公告 URL`、`source='tender'`）再以真实 UUID 为边目标。
- **第二层根因**：`CRM_KNOWLEDGE.identity=['term']`（缺失抛 `missing required field: term`）+ `kind` 受控枚举 `{icp, competitors, objections, buyer_language}` → 首版只传 name/title/kind='tender_announcement' 又被吞。
- **实证**：修复后落库 2 KNOWLEDGE + 2 sourcedFrom 边（`provenance='prospecting-search'`），测试库 13/13 断言全绿。

### 8.4 修复存量缺陷 ②：writeConfig 整值覆盖挤掉其他数据源（2026-09-15）

- **根因**：`configStore.writeConfig` 是**整值替换**（`ON CONFLICT DO UPDATE SET value=$3`），e2e 写 `sources:{tender}` 会把 qixin/xinbang/anysite 全部挤掉（实测 config 只剩 tender）。
- **风险**：若生产上任何脚本/流程这样写，会静默丢失其他启用源。
- **修复**：所有写 prospecting-rules 的路径改为**先 read 再合并**（`{...prevValue, sources:{...(prevValue.sources||{}), key:patch}}`）。e2e 脚本 + 恢复脚本已对齐。

### 8.5 测试数据清理

- e2e 每轮向 `crm_native_test` 入池 2 条 DEAL（共 3 轮=6 条）。旧逻辑（无边）4 条已清理，保留最新带边 2 条 + KNOWLEDGE + 2 边作回归基线。
- 清理脚本：`scripts/tmp-cleanup-tender-e2e.mjs`（限测试库，非 test 库拒绝执行）。

### 8.6 回归

- `prospectingActions/prospectingConfirm/adapters` 22/22 绿；`discoveryOrchestrator/prospectingAgent/connectors` 16/16 绿。无回归破坏。

---

## 9. 下一步

- 定时自动抓取（订阅推送的拉取端）列为后续迭代（YAGNI，本期不做）。
- 大单网若获公开 API/凭据，仅替换 `DEFAULT_SEARCH_SOURCES` 即可（§2.3 配置驱动）。
