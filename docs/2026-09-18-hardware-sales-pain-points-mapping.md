# 硬件产品制造商（服务器/笔记本）销售领域业务痛点 × 本平台能力映射（v3 定稿）

> 日期：2026-09-18 · 性质：调研存档 + 能力映射（对外演示/销售解决方案口径）
> 输入：用户提供的行业业务痛点材料（§1–§2）
> **v2 修正说明**：v1 曾将「报价引擎未落地」「项目型全生命周期未落地」列为真实缺口（G1/G3），
> 经源码取证判断错误，予以撤回——报价引擎、项目型生命周期、行业包扩展机制均已落地。
> **v3 补充审计说明（本轮）**：用户追问「还存在缺口吗」，对材料全景（含次要痛点：库存不同步、
> 回款/信用管控弱、维保资产台账、附件/投标文件、多级分销、政策适配）做系统性取证，新确认 3 个真实缺口
> （G5′ 信用实时卡控 / G6′ 渠道商机归属判定 / G7′ 附件→商机默认挂边），同时确认 2 处「载体能力已有，
> 不算缺口」（报价政策适配、投标/技术方案）。**最终缺口全景 G1′–G7′，全部走既有轨道补齐（零内核）。**

---

## §0 结论先行

1. **本平台已能覆盖硬件制造商（服务器/笔记本）销售痛点的主要部分，且以「行业包自适应 + 报价引擎 + 项目型生命周期」为核心机制，无需另造模块**：
   - **报价引擎 ✅ 已落地**：`src/sales/quoteService.js` 完整实现（取价/金额自动计算/写后验证 + 审批前后状态机），配套 `crm-quote-create` / `crm-quote-submit`（分档审批）/ `crm-quote-activate` 三个 Action，场景 `QUOTE_PRICING` 全链接线（`src/action/seed-actions.js:1262/1279`）。
   - **项目型销售全生命周期 ✅ 已落地**：S1–S8 阶段机（`src/sales/stageConfig.js`，S4 报价定价 / S6 合同后），交易实体粒子 `CRM_QUOTATION / CRM_CONTRACT / CRM_INVOICE / CRM_ORDER / CRM_PAYMENT_RECORD / CRM_TECHNICAL_PROPOSAL`（粒子类型已注册），Action `crm-proposal-write / crm-contract-create/submit / crm-invoice-submit / crm-order-submit / crm-payment-plan-create / crm-payment-record-create` 全链（`src/action/seed-actions.js:1194/1294/1374/1390`）。
   - **行业包扩展机制 ✅ 已落地**：`db/seed/tenant-profile-manufacturing.js`（制造业/渠道分销行业模板，含经销商 `MFG_DEALER` / 终端项目报备 `MFG_PROJECT` / 提货订单 `MFG_ORDER` / 返利结算 `MFG_REBATE` / 渠道库存动销 `MFG_CHANNEL_STOCK`，审批域 quote/contract/dealer_onboarding/order/rebate/settlement，计算字段 order_net_amount/rebate_amount），多行业合并 `src/config/profileMerger.js`，行业上线 Runbook `docs/runbooks/2026-09-03-new-industry-onboarding.md`。
   - **招投标/信号 ✅ 已落地**：`tenderConnector` 标讯、`entityExtractor` 招标/投标意图识别、`signals` `tender_deadline` 投标截止信号（`src/portal/signalLabels.js:205`）。
2. **用户论断成立**：「通过行业 HANDBOOK（行业包）对硬件销售制造业的产品、报价进行扩展」是**真实能力**，不是纸面能力——制造业模板已实装 `db/seed/tenant-profile-manufacturing.js`，报价引擎与项目型生命周期均已接线到生产。
3. **剩余缺口（最终全景 G1′–G7′）**：① 多层 BOM 配置校验与报价版本对比（报价引擎做**明细行计算**，非 BOM 层级/套餐组合校验）；② 样机管理（无样机申请/测试记录粒子或动作）；③ 显式窜货/撞单检测规则（载体已存在：项目报备制 + 渠道库存动销，但无自动冲突检测逻辑）；④ 维保/续保资产台账与自动回流（集成线可支撑读取，未落维保粒子）；⑤ **信用实时卡控缺失**（`credit_limit` 有画像字段但无业务消费点，仅审批兜底 R4）；⑥ **渠道商机归属判定缺失**（MFG_PROJECT/MFG_DEALER 载体在、归属逻辑无）；⑦ **附件→商机默认挂边入口缺失**（上传能力在、默认前端入口无）。其中 ①–③⑥ 属**行业包扩展**（零内核，配置驱动轨道）；④ 属**集成线**（读取侧重获）；⑤ 属**审批线增强**；⑦ 属**附件线**（现成能力补入口）。
4. **边界不越界**：订单/库存/生产/回款的**主记录**仍以 ERP 为准，本平台负责决策链、商机、报价、文件与知识、线索回流——「硬件不可变/交付已发生」的事务不迁进 CRM。

---

## §1 硬件产品制造商销售领域 TOP3 业务痛点（原文存档）

> 企业特点：项目型+渠道分销并存、硬件有配置 BOM、报价复杂、交付周期长、维保/续保是增值业务、客户分直销大客户/代理商/中小客户

| # | 痛点 | 原文要点 |
|---|---|---|
| **P1** | **项目报价与配置管理复杂，报价出错、周期长** | 服务器/笔记本可定制硬件（CPU/内存/硬盘、配件、维保套餐、批量折扣、渠道返点组合繁多）；手动搭配置算价格 → BOM 错配、报价漏项；同客户多版本报价难追溯、反复内部核对 → 拉长投标/签单周期 |
| **P2** | **渠道与直销两套客户、订单数据割裂，管控难** | 大客户直销+代理商分销并行：撞单、窜货；代理商的客户线索/库存/回款无法实时同步；直销与渠道政策（价格/返利/备货规则）不一致，销售难快速判断适用政策 |
| **P3** | **商机周期长，阶段转化难跟踪，售前/售中/售后断层** | 政企/机房服务器大单：线索→需求调研→测试→投标→合同→备货→交付→维保数月至跨年；原 CRM 只记基础状态，无法关联样机申请/测试记录/投标文件/排产交付；交付后维保/续保商机无法自动回流 → 增值收入流失 |

**补充次要痛点**：库存信息不同步、回款与信用管控弱、维保资产台账难管理。

---

## §2 原有 CRM 系统存在的 TOP3 核心问题（原文存档）

| # | 问题 | 原文要点 |
|---|---|---|
| **Q1** | **和后端业务系统不通，数据孤岛严重** | CRM 独立于 ERP/BOM 配置器/库存/生产/售后维保；商机合同不能自动同步 ERP 下单；硬件配置/库存交期/维保资产需跨系统手动复制；无法自动拉设备序列号、维保到期信息 |
| **Q2** | **标准化通用 CRM，不匹配硬件 BOM/报价/渠道业务特性** | 通用 CRM 以“客户+商机”为主，缺多层 BOM、套餐组合、阶梯报价、渠道返利、样机管理；只能自定义字段勉强记录，无法配置校验与报价版本对比；渠道代理商/多级分销的权限、归属、窜单校验弱 |
| **Q3** | **重前端线索记录，缺少项目全流程和履约跟踪能力** | 停留在“登记客户、写跟进记录”；不支持项目型销售阶段（需求→测试→投标→合同→备货→到货验收）；缺与交付、售后联动机制；商机签单后履约/到货/验收/回款/维保不在 CRM 闭环 → 营收预测偏差大 |

---

## §3 痛点 × 本平台能力映射（v2 证据版）

> 每条映射均带源码/文件锚点，可对外演示时直接引用。

### §3.1 P1 项目报价与配置管理复杂、报价出错、周期长

| 子问题 | 平台能力 | 证据锚点 | 判定 |
|---|---|---|---|
| 报价算价错误/漏项 | 报价引擎自动算价，金额=Σ(单价×数量×(1-折扣)×(1+税))，写后验证一致才落库 | `quoteService.js:10-33` computeQuoteAmount/verifyQuoteAmount；`seed-actions.js:1262` crm-quote-create handler | ✅ 已解决（明细行级） |
| 取价靠销售手填 | 从租户价目表 `CRM_PRICE_LIST` 自动填单价 | `quoteService.js:42-58` fillUnitPrices + loadTenantPriceData | ✅ 已解决 |
| 报价审批周期长、无审批流 | 分档审批 T1/T2/T3 按金额解析审批链，审批通过才生效（draft→approved 单向终态） | `seed-actions.js:1262`(crm-quote-submit) startGradedApproval；`quoteService.js:106` activateQuote | ✅ 已解决 |
| 配置组合/套餐/BOM 校验 | 行业包可扩展：manufacturing 模板已有产品/订单原型，但**显式多层 BOM/套餐组合校验未落**（报价引擎做明细行，非 BOM 分层） | `tenant-profile-manufacturing.js`（MFG_ORDER 等）；quoteService 无 BOM 层级 | 🟡 载体在、细分能力缺 |
| 同客户多版本报价追溯 | 每次报价独立粒子 + decision_id 决策凭证溯源，可对比多版；但**无显式「版本 diff」视图** | 粒子模型（每次 createQuote 新建粒子）；`writeback.js:43` decision_id 凭证 | 🟡 追溯有、对比视图缺 |

### §3.2 P2 渠道与直销两套客户、订单数据割裂，管控难

| 子问题 | 平台能力 | 证据锚点 | 判定 |
|---|---|---|---|
| 渠道/直销两套业务并存 | 行业包 manufacturing 模板原生建模「厂商→经销商→终端客户」链路 | `tenant-profile-manufacturing.js` MFG_DEALER / MFG_PROJECT / MFG_ORDER | ✅ 已解决 |
| 渠道政策（返利/折扣/备货）不一致 | 行业包含返利结算 `MFG_REBATE`（pending→calculated→approved→paid）+ 自动计算 rebate_amount；经销商画像含 discount_rate/credit_limit/rebate_rate；审批域全覆盖 | `tenant-profile-manufacturing.js` + calculations | ✅ 已解决（模板级） |
| 撞单 | 项目报备制（终端项目 `MFG_PROJECT` flow reported→approved）+ 商机归属锁定，天然防撞单；**显式撞单检测规则未落** | `tenant-profile-manufacturing.js` MFG_PROJECT；渠道冲突检测逻辑 grep 无命中 | 🟡 报备制防撞单、自动检测缺 |
| 窜货 | 渠道库存动销 `MFG_CHANNEL_STOCK`（sku/qty/month/sell_through）+ 经销商 territory/region 归属可支撑异常动销识别；**显式窜货规则未落** | `tenant-profile-manufacturing.js` MFG_CHANNEL_STOCK | 🟡 载体在、规则缺 |
| 渠道线索/库存/回款实时同步 | 集成线（通道线+同步线）可定时读取外部库存/回款；回款粒子 `CRM_PAYMENT_RECORD` 已注册 | 集成设计 `2026-09-18-unified-integration-design-v2.md`；粒子类型已注册 | 🟡 骨架在、真实租户连通未验证 |
| 渠道商机归属判定（撞单仲裁） | 制造业模板有 `MFG_PROJECT`（终端项目报备，含 end_customer/dealer_name）+ `MFG_DEALER`，但**无 dealer→项目→商机归属判定逻辑**（src/sales、src/action 中 dealer 零命中） | `tenant-profile-manufacturing.js`；`src/sales`/`src/action` grep dealer 无消费 | 🟡 **G6′** 载体在、逻辑缺（行业包扩展） |
| 适用渠道政策判断 | `CRM_OFFER_POLICY` 粒子 + `discountAuthorityCheck`（角色折扣上限矩阵）+ `resolveOfferPolicy`（deal 关联 > standard active）在决策侧已消费 | `offerPolicyFacts.js:11/60`；`adviseService.js:56/61`；`scenarioAdvisors.js:60` | ✅ 已解决（非缺口） |
| 回款/信用管控 | 回款粒子 + `CRM_PAYMENT_PLAN/RECORD` + R4 审批（超信用→财务VP，`approvalConfig.js:22/30`）；**但 `credit_limit` 字段只有画像、无业务消费点**（grep 仅命中 `tenant-profile-manufacturing.js:17`），无订单/报价实时卡控 | `approvalConfig.js:22,30`；credit_limit grep 无消费 | 🟡 **G5′** 审批兜底有、实时卡控缺（审批线增强） |

### §3.3 P3 商机周期长、阶段转化难跟踪、售前/售中/售后断层

| 子问题 | 平台能力 | 证据锚点 | 判定 |
|---|---|---|---|
| 阶段转化难跟踪 | S1–S8 阶段机 + 赢率表 + 单向推进 + 退出边（S7输/S8丢）+ 商机重开 | `stageConfig.js`（S1 10%→S4 85%→S6 100%）；`seed-actions.js:454` 推进边 | ✅ 已解决 |
| 售前（技术方案/投标） | `CRM_TECHNICAL_PROPOSAL` 粒子 + `crm-proposal-write` Action + 投标信号（tender_deadline） | `seed-actions.js:1194`；`signalLabels.js:205`；标讯 tenderConnector | ✅ 已解决 |
| 售中（合同/订单/发票/回款） | 合同 `CRM_CONTRACT`、订单 `CRM_ORDER`、发票 `CRM_INVOICE`、回款 `CRM_PAYMENT_RECORD` 全链 + POST_CONTRACT 场景决策 | `seed-actions.js:1294/1374/1390/1411`；`stageTaxonomy.js` S6 POST_CONTRACT | ✅ 已解决 |
| 售后（维保/续保回流） | **未落**：无维保资产台账/续保线索回流动作；集成线可支撑读取序列号/维保到期，但无闭环 | grep 维保/续保仅命中风险提示模板 `thinkingTemplates.js:215` | 🔴 **G4′** 真实缺口（集成线可补） |
| 样机申请/测试记录 | **未落**：无样机申请/测试记录粒子或动作 | 样机 0 命中 | 🔴 **G2′** 真实缺口（行业包可扩） |
| 投标文件/证据附件 | 上传能力已有（`/api/assets/upload` → `CRM_UNSTRUCTURED_ASSET` + sha256 + 审计；`seed-actions.js:696` 可挂 `evidenced_by` 边关联目标实体），但**无「投标文件/测试记录挂到对应商机」的默认前端入口** | `src/assets/upload.js:78/118`；`seed-actions.js:696` | 🟡 **G7′** 能力在、默认挂边入口缺（附件线） |
| 营收预测偏差 | 商机阶段×赢率 + 决策链可支撑管道预测；履约真实现状在 ERP（只读对账） | `stageConfig.js` 赢率表 | 🟡 商机侧有、履约侧靠集成线 |

---

## §4 真实缺口全景（G1′–G7′，定稿，不虚构能力）

| # | 缺口 | 现状（证据） | 补齐路径 | 是否新内核 |
|---|---|---|---|---|
| **G1′** | 多层 BOM/套餐组合配置校验、报价版本 diff 视图 | quoteService 做明细行计算（`quoteService.js:10-33`）；无 BOM 分层、无版本对比视图 | **行业包扩展**（manufacturing 模板加 BOM/套餐原型 + 校验 calculation，走既有 `profileMerger` 轨道） | 否（零内核，配置驱动） |
| **G2′** | 样机申请/测试记录管理 | 无粒子、无动作（样机 0 命中） | **行业包扩展**（新增 MFG_PILOT 类原型 + 审批域，同 MFG_REBATE 范式） | 否（零内核） |
| **G3′** | 显式撞单/窜货检测规则 | 报备制与渠道库存动销载体已存在（`tenant-profile-manufacturing.js` MFG_PROJECT/MFG_CHANNEL_STOCK），检测逻辑无 | **行业包扩展**（挂检测 calculation + 告警规则，复用既有阈值/告警配置化） | 否（零内核） |
| **G4′** | 维保/续保资产台账与自动回流 | 无维保粒子（维保仅命中 `thinkingTemplates.js:215` 风险模板）；集成线可读序列号/维保到期 | **集成线**（外部售后系统只读同步 → 商机回流，走 2026-09-18 集成设计待批通道） | 待批准（读取侧，非回写客户侧） |
| **G5′** | **信用实时卡控缺失** | `credit_limit` 字段仅在经销商画像（`tenant-profile-manufacturing.js:17`），**无业务消费点**（grep 无命中）；仅审批 R4「超信用→财务VP」事后兜底（`approvalConfig.js:30`） | **审批线增强**（订单/报价写时挂 credit 卡控 calculation + 告警，复用既有审批/告警配置化） | 否（零内核） |
| **G6′** | **渠道商机归属判定缺失** | MFG_PROJECT（含 end_customer/dealer_name）+ MFG_DEALER 载体在，但 src/sales、src/action **无 dealer 消费逻辑**（撞单靠人工报备，无自动仲裁） | **行业包扩展**（挂 MFG_PROJECT 归属判定 calculation + 撞单告警，复用报备制） | 否（零内核） |
| **G7′** | **附件→商机默认挂边入口缺失** | 上传能力已有：`/api/assets/upload` → `CRM_UNSTRUCTURED_ASSET`（sha256+审计，`src/assets/upload.js:78/118`）+ 可挂 `evidenced_by` 边（`seed-actions.js:696`）；但无「投标文件/测试记录挂到对应商机」的默认前端入口 | **附件线**（现成能力：前端补默认挂边入口 + 引导） | 否（现成能力补入口） |

> **口径提示（对外演示）**：上表七项均非「平台缺陷」，而是「**行业包尚未播种的细分能力**」——按行业 HANDBOOK 扩展 + 集成线 + 既有审批/告警轨道的既定产品叙事扩展即达，**零内核、零新粒子类型**（遵守 2026-09-08 已批设计 §10 硬约束）。

### §4.1 同时确认的「非缺口」（载体能力已在，不虚报）

| 维度 | 能力 | 证据 |
|---|---|---|
| 报价政策适配（直销 vs 渠道政策） | CRM_OFFER_POLICY + 折扣权限矩阵 + deal 关联优先解析，已在决策侧消费 | `offerPolicyFacts.js:11/60`；`adviseService.js:56/61`；`scenarioAdvisors.js:60` |
| 投标/技术方案 | CRM_TECHNICAL_PROPOSAL + crm-proposal-write + 标讯 + tender_deadline 信号 | `seed-actions.js:1194`；`signalLabels.js:205` |
| 回款 | CRM_PAYMENT_PLAN/RECORD + 挂边协议 | `contractService.js:6,24`；`seed-actions.js:1411/1425` |
| 信用审批链（事后兜底） | R4 审批（超信用→财务VP） | `approvalConfig.js:22,30` |
| 附件上传能力 | /api/assets/upload + sha256 + 审计 | `src/assets/upload.js:78/118` |

---

## §5 明确不做的（避免越界，对外口径同样适用）

- **订单/库存/生产/回款的主记录留在 ERP**：本平台做决策链、商机、报价审批、文件与知识、线索回流；履约真实现状经集成线读取，不迁主数据。
- **不回写客户侧 CRM**（红线③，须审批闸接线后按约束放开；`writeback.js:15`）。
- **不收客户侧邮箱/IM 凭据**（接入形态三形态红线，connector/local-bridge 凭据留用户侧）。
- **不新增粒子类型、不改业务域模型**（2026-09-08 §10 硬约束；行业扩展一律走 tenant-profile 配置）。

---

## §6 证据与参考

| 证据 | 位置 |
|---|---|
| 报价引擎（取价/算价/写后验证/审批状态机） | `src/sales/quoteService.js`（computeQuoteAmount :10、fillUnitPrices :42、loadTenantPriceData :72、createQuote :88、activateQuote :106） |
| 报价三动作（创建/提交分档审批/激活） | `src/action/seed-actions.js:1262`（crm-quote-submit）、`:1279`（crm-quote-activate）；crm-quote-create handler `:1240-1265` |
| 项目型生命周期动作链 | `seed-actions.js:1194`（proposal-write）、`:1294`（contract-create）、`:1361`（contract-submit）、`:1374`（invoice-submit）、`:1390`（order-submit）、`:1411`（payment-plan）、`:1425`（payment-record） |
| 阶段机与赢率 | `src/sales/stageConfig.js`（S1–S8 + 赢率表，S4 85% / S6 100%）；`src/sales/stageTaxonomy.js` S4 QUOTE_PRICING / S6 POST_CONTRACT |
| 制造业行业包（经销商/项目报备/订单/返利/渠道库存） | `db/seed/tenant-profile-manufacturing.js`（MFG_DEALER / MFG_PROJECT / MFG_ORDER / MFG_REBATE / MFG_CHANNEL_STOCK + approvalDomains + calculations） |
| 行业包多行业合并 | `src/config/profileMerger.js`（mergeProfile :30） |
| 行业上线 Runbook | `docs/runbooks/2026-09-03-new-industry-onboarding.md` |
| 投标信号/标讯 | `src/portal/signalLabels.js:205`（tender_deadline）；`tenderConnector` |
| 知识注入（报价谈判场景注入竞品/异议话术） | `2026-09-03-tenant-knowledge-design.md` §6.2（QUOTE_PRICING → competitors/objections） |
| 集成线（通道/同步/回写对账，待批） | `docs/2026-09-18-unified-integration-design-v2.md`（P0–P10，P6 回写放开需裁决） |

---

> **v3 定稿要点回顾**：① v1→v2 已把「报价引擎/项目型生命周期未落地」的错误判断撤回，确认二者**均已接线到生产 Action**；② v2→v3 对材料全景（含次要痛点）补充审计，新增 G5′（信用实时卡控）/G6′（渠道商机归属）/G7′（附件→商机默认挂边）三个真实缺口，确认「报价政策适配、投标/技术方案」为非缺口；③ 最终缺口全景 **G1′–G7′**，全部走既有轨道（行业包扩展 / 集成线 / 审批线增强 / 附件线补入口），**零内核、零新粒子类型**。**对外口径**：「行业 HANDBOOK 自适应 + 报价引擎 + 项目型生命周期」是已落地能力，细分能力按行业包扩展即达。
