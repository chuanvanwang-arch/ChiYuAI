# 2026-08-28 · CRM 业务主数据配置体系设计（Business Master Data Configuration）

> 状态：✅ 用户已批准（2026-08-28 15:59 确认）
> 前置结论：报价单的「品类 / 基础价格 / 合同模板与条款」不在现有配置中心（configCenter 18 项，均为平台/治理类），业务主数据需独立门户承载。
> 本次设计范围：全量蓝图 + P0/P1/P2 优先级；标准品报价 + 方案式报价双支持；实现路线 A（基础数据门户 + 粒子统一建模）。
> 明确暂缓：合同模板/条款、产品品类/目录分类（P2）。

---

## §0 背景与目标

### 0.1 问题溯源

用户在配置中心（`/config`，`src/portal/configCenter.js` CONFIG_ITEMS 18 项 id 11–28）找不到「品类 / 基础价格 / 合同模板与条款」配置面。核查代码事实：

- 配置中心 18 项均为**平台/治理类**：LLM、用户、RBAC、决策场景、七维、SKILL 注册表、审批流、业务分级、元模型、池、预警规则、本体/词汇、智能体、页面市场、决策质量、记忆、MCP 身份、系统设置。
- **无任何业务主数据面**：产品/价格表/商务规则/字典/回款政策/竞争情报/交付产能均不在其中。

### 0.2 已确认的产品决策

1. **范围**：上线前业务主数据全量蓝图 + 优先级（P0/P1/P2）。
2. **报价形态**：标准品报价（SKU 价格表）与方案式报价（组件+服务组合+成本/毛利/三档价/折扣政策）**两者均支持**。
3. **路线**：**A——基础数据门户 + 粒子统一建模**，与配置中心边界分离。

### 0.3 成功标准

- 上线前 P0 主数据可在门户维护（产品/价格表/商务规则包/字典/回款政策），无需 SQL/seed 手工改。
- 报价自动取价（E15）与报价决策评估（QUOTE_PRICING 场景）消费主数据，不再靠口述/拍脑袋。
- 写经决策第 0 闸：主数据变更也是决策事件，可溯源、禁删（软停用）。
- 与配置中心语义边界清晰：平台配置 vs 业务数据不混。

---

## §1 设计总览

### 1.1 边界划分（铁律）

| 维度 | 配置中心（既有，**不动**） | 基础数据门户（本次新增） |
|------|------------------------|------------------------|
| 内容 | 平台/方法论/治理配置（LLM/RBAC/审批流/预警/本体/记忆…） | 业务主数据（产品/价格/商务规则/字典/回款政策/对手/产能…） |
| 角色 | admin 独享（config.html 守卫 + layoutMenu ADMIN_MENU） | admin + 商务 + 销售管理（细分 data_scope） |
| 写通道 | 决策第 0 闸 + sysadmin | 决策第 0 闸 + 业务角色（RBAC matrix） |
| 数据形态 | config_store / 专用配置表 | **粒子（crm.particles）** |

### 1.2 架构对齐（复用既有范式，不发明新框架）

- 粒子 = 一行 `crm.particles`（type 自由 TEXT，payload JSONB）；属性模型在 `src/particles/particleModel.js` 注册，值域/白名单在 `src/page/schema.js` 同步。
- 读：默认直连通道（`GET /api/particles?type=...`，`src/http/routes.js`）。
- 写：`POST /api/particles` → `actionExecutor.dispatch('data-particle-create', ...)` + 决策第 0 闸（`requireDecision`）+ 元模型 #19（meta-attr）校验。
- 页面：受控渲染页（S02–S15 经 renderPage）**必链 `/portal/page.css`**；新页复用 configCenter 卡片范式 + nav 入口。
- 禁删：软停用（state 流转，杜绝物理删除）。

### 1.3 与 DEMO 的对应

`doc/sales-platform-features.html` 四幕场景依赖的主数据：多智能体分工（产品/价格/商务规则）、7 大决策（字典/对手/回款政策/止损）、记忆底座（本体词汇）、越干越好（交付产能/预警）。本设计为这些场景补上**上游主数据来源**。

---

## §2 粒子模型扩展

在现有粒子（9 基础 + 9 业务闭环 + 审批域 6 + 售前 1）基础上新增 4 类，注册进 `particleModel.js` 与 `schema.js` PARTICLE_TYPES_ENUM：

### 2.1 新增粒子

| 粒子类型 | 承载主数据 | 核心属性（coreAttributes） | 状态机 |
|---------|-----------|--------------------------|--------|
| `CRM_OFFER_POLICY` | 方案式报价商务规则包 | name、cost_structure(items：组件+成本)、price_bands(开盘/目标/底价三档)、discount_conditions(折扣对等条件)、margin_redline(毛利红线)、tier_discount(阶梯价)、change_billing(变更计费)、valid_from/to | draft→active→expired |
| `CRM_DICT_ENTRY` | 字典值域（行业/规模/对接人级别/决策力/付款方式/区域） | dict_key、dict_value、sort_order、active | registered→deprecated |
| `CRM_COMPETITOR`（P1） | 竞争情报 | name、solution、price_quote、strength/weakness、source | active→deprecated |
| `CRM_RESOURCE_CALENDAR`（P1） | 交付产能/实施资源 | resource_type、capacity_day、booked_day、start/end | draft→active→expired |

> 字典值域与 `CRM_KNOWLEDGE` 词汇体系同源（可互查/联动，ontologyConfig 已支持词汇软停用禁删范式）。

### 2.2 既有粒子补字段/补维护面

| 粒子 | 变更 | 依据 |
|------|------|------|
| `CRM_PRODUCT` | 补 `category`（品类，暂缓启用可先留空）+ 补维护 UI | `particleModel.js:45` 模型已有，无 UI |
| `CRM_PRICE_LIST` | 补维护 UI（模型已完整：name/valid_from/valid_to/permission/products/change_log，`:51-59`） | 报价取价 `priceCalc.js` 已实现，缺数据维护 |
| `CRM_PERSON` / `CRM_ORGANIZATION` | 补 `region`（区域）属性 | 高管区域对比场景 |

> 注：粒子属性无需 DDL 新表（统一 `crm.particles` + payload JSONB），新增粒子 = 注册类型 + 定义 coreAttributes + meta-attr 值域接入。

---

## §3 基础数据门户设计（P0 第一批 5 面）

### 3.1 门户入口

- `src/web/nav.js` 加「📚 基础数据」组（对齐 ADMIN_MENU 分组范式，但角色可见性 = admin + 商务 + 销售管理，非 admin 独享）。
- 首屏：基础数据总览（5 面卡片网格 + 总计数 + 15s 轮询可读项），复用 `configCenter.js` 卡片范式（新建 `src/portal/businessDataCenter.js`，同构不复制）。

### 3.2 P0 五个配置面

| # | 面 | 粒子 | 页面 | 路由/端点 | 关键能力 |
|---|----|------|------|----------|---------|
| 1 | 产品目录 | CRM_PRODUCT | `/product-catalog.html` | GET+POST `/api/particles?type=CRM_PRODUCT` | 名称/单位/价格/状态/软停用、补 category 字段 |
| 2 | 基础价格表 | CRM_PRICE_LIST | `/price-list.html` | 同上 type=CRM_PRICE_LIST | 多套定价/有效期/权限/变更自动 appendChangeLog（`priceCalc.js` 已有） |
| 3 | 报价商务规则包 | CRM_OFFER_POLICY | `/offer-policy.html` | 同上 type=CRM_OFFER_POLICY | 成本结构/三档价/折扣对等条件/毛利红线/阶梯价/变更计费 |
| 4 | 字典值域 | CRM_DICT_ENTRY | `/dict-entries.html` | 同上 type=CRM_DICT_ENTRY | 值域维护，meta-attr select 下拉自动消费 |
| 5 | 回款政策 | CRM_OFFER_POLICY（subtype=payment）或独立粒子 | `/payment-policy.html` | 同上 | 账期/催收分级（沟通·施压·法务）/预付比例 |

> 每个面复用「表单 + 写通道确认（decision_id）+ 决策留痕 + 15s 刷新读」范式；写必经决策第 0 闸，禁删 = 软停用。

### 3.3 权限模型

- 复用 `RBAC 矩阵`（configCenter #13，`data_scope`）：admin 全管；商务可维护产品/价格/商务规则/字典；销售管理可维护回款政策；销售只读。
- 门户入口按角色过滤可见性（复用 `layoutMenu.js menuFor` 范式 + 路由守卫）。

---

## §4 配置消费链路（闭环）

| 场景 | 消费链路 | 现状 → 目标 |
|------|---------|-----------|
| 报价自动取价 | 报价创建 → `fillUnitPrices → getUnitPrice`（价格表）→ 无价回退产品价 | 已有逻辑（`quoteService.js:40-46`、`priceCalc.js:54-58`）→ 补数据源维护面 |
| 报价毛利透视 | 报价 → OFFER_POLICY.cost_structure → 毛利/成本透视 | 缺失 → P0-B 落地（DEMO 案例A「成本可透视」） |
| 三级报价决策 | QUOTE_PRICING 场景 → `price_vs_floor`/`discount_condition`/`margin_redline` 评估维 → OFFER_POLICY.price_bands | 评估维已存在（seed.sql:246）→ 补数据源（DEMO 决策4「报价有底气」） |
| 字典联动 | 新建商机/客户 select 属性 → meta-attr 值域 → DICT_ENTRY 活跃项 | 元模型已有（#19）→ 补值域维护（DEMO 案例B 需求补全） |
| 回款催收分级 | 财务应收 → 回款政策（账期/分级）→ 催收建议 | 预警触发已有（#21）→ 补业务参数（DEMO 决策6/案例C） |
| 决策先例/记忆 | 主数据变更 → 决策事件（decision_id）→ 记忆三构件 | 写通道已强制第 0 闸 → 主数据变更自动纳入（决策脊椎可溯源） |

---

## §5 实施批次（P0/P1/P2）

| 批次 | 内容 | 交付物 | 对齐场景 |
|------|------|--------|---------|
| **P0-A** | ①产品目录 ②基础价格表 | 2 维护页 + 门户首屏 + 粒子补字段 + permissions | DEMO 案例A 报价取价；报价单明细来源 |
| **P0-B** | ③报价商务规则包 ④字典值域 ⑤回款政策 | 3 维护页 + OFFER_POLICY/DICT_ENTRY 粒子 + 消费链（报价毛利/决策取数/字典下拉） | 案例A 商务规则附着+成本透视；决策4 三级报价；决策6 回款；案例B 需求补全 |
| **P1** | ⑥竞争情报 ⑦交付产能 ⑧选型评分标准 ⑨需求补全模板 ⑩复购SOP参数 ⑪组织区域 ⑫止损点规则 | COMPETITOR/RESOURCE_CALENDAR 粒子 + 配置面 + 消费链 | 案例C 交期预警；案例D 复购SOP；高管区域对比；决策7 止损 |
| **P2** | 合同模板/条款、产品品类 | （与用户确认暂缓） | — |

---

## §6 测试与验收（TDD）

对齐项目测试范式（`test/web/*.test.js` + `node node_modules/vitest/vitest.mjs run`，禁 npx）：

1. **粒子注册测试**：OFFER_POLICY/DICT_ENTRY（+COMPETITOR/RESOURCE_CALENDAR）类型注册、coreAttributes 值域白名单断言。
2. **门户渲染测试**：`businessDataCenter.test.js`（5 面卡片计数/分组/状态徽标，类比 `configCenter.test.js`）。
3. **消费链测试**：`offerPolicyConsume.test.js`——quotation 缺价→OFFER_POLICY 取价带毛利透视；QUOTE_PRICING 场景评估取 price_bands；dict 值域下拉联动。
4. **写通道闸测试**：主数据变更无 decision_id → 拒绝；有 → 留痕可溯源（对齐现有第 0 闸测试）。
5. **验收冒烟**：curl `/product-catalog.html`、`/price-list.html`、`/offer-policy.html`、`/dict-entries.html`、`/payment-policy.html` 全 200；GET `/api/particles?type=CRM_OFFER_POLICY` 有数据。

---

## §7 明确边界与风险

- **不做**：合同模板/条款、产品品类（用户明确暂缓，P2）。
- **不混**：不把业务主数据塞进配置中心 18 项（保持平台/治理语义）。
- **风险**：报价商务规则 JSONB 结构复杂度（cost_structure/price_bands 嵌套）；处理策略——P0-B 先支持明确 schema 的固定形状，不规则扩展留给 meta-attr 元模型。
- **禁删铁律**：所有主数据粒子软停用（state 流转），物理删除绝对不做。

---

## 附录 A：业务主数据全景清单（上线前）

**P0（上线必需）**：① 产品目录 ② 基础价格表 ③ 报价商务规则包 ④ 字典枚举 ⑤ 回款政策
**P1（上线后快速补）**：⑥ 竞争情报 ⑦ 交付产能/实施资源 ⑧ 选型评分标准 ⑨ 需求补全模板 ⑩ 复购转化 SOP 参数 ⑪ 组织/区域/人员 ⑫ 止损点规则
**P2（暂缓）**：合同模板/条款、产品品类/目录分类

## 附录 B：涉及文件清单

- `src/particles/particleModel.js`（改：+4 粒子注册 + PRODUCT.category + PERSON/ORGANIZATION.region）
- `src/page/schema.js`（改：PARTICLE_TYPES_ENUM/ATTR 值域同步）
- `src/portal/businessDataCenter.js`（新：门户总览渲染）
- `src/web/nav.js`（改：📚 基础数据组）
- `src/web/product-catalog.html` / `price-list.html` / `offer-policy.html` / `dict-entries.html` / `payment-policy.html`（新×5）
- `src/http/routes.js`（改：静态路由挂载；读直连复用既有 GET/POST `/api/particles`）
- `src/metaAttr/metaAttrRepo.js`（改：值域联动 DICT_ENTRY）
- `src/sales/quoteService.js` / `priceCalc.js`（改：消费 OFFER_POLICY 毛利透视/price_bands）
- `src/decision/autonomyEngine.js`（如需：主数据变更场景挂决策第 0 闸）
- `test/web/businessDataCenter.test.js`、`offerPolicyConsume.test.js`（新）
- 本设计文档

## 附录 C：与既有配置中心边界对照（防混）

| 既有配置中心（不改） | 本次新增（基础数据门户） |
|---------------------|------------------------|
| #13 RBAC 矩阵（data_scope 权限来源） | 权限消费方（业务角色可维护主数据） |
| #19 粒子属性元模型（meta-attr） | 值域联动数据源（DICT_ENTRY） |
| #21 预警规则（触发） | 回款/交期预警的业务参数（回款政策/资源日历） |
| #22 本体/词汇（CRM_KNOWLEDGE） | 字典值域同源互查 |
| #14 决策场景配置（评估维定义） | 评估维数据源（OFFER_POLICY.price_bands 等） |