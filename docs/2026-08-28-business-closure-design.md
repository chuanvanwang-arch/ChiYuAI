# 业务闭环增量 · 门户级打通设计（item 方向1）

> 状态：已批准（用户选「方向 1：新建统一业务闭环看板页」+ 设计审批「1」）
> 日期：2026-08-28
> 铁律：设计先行 → writing-plans → 实现；每 Task 一 commit；TDD 红→绿；只读、无写、绝对禁删、不绕决策第0闸。
> 复用范式：本会话已验证的「渲染纯函数子模块（零服务端 import）+ 静态路由」QA 安全范式（杜绝根因 A 复发）。

## §1 目标与边界

**目标**：在门户层把 L2C 全链路（客户→商机→报价→合同→订单→回款）串成一张统一看板，按阶段卡展示数量 + 金额，支持条目下钻到现有 detail 页。

**明确不做（YAGNI / 红线）**：
- 不引入报表引擎 / 图表库（阶段3 既定「复用看板视图、不做复杂报表」）。
- 不新建 LEAD 粒子（线索 = `CRM_DEAL` 的 `stage='lead'`，阶段3 既定）。
- 无写操作、无 DELETE、不绕决策第0闸（纯只读聚合页）。

## §2 架构与组件

| 组件 | 文件 | 说明 |
|---|---|---|
| 富化端点 | `src/http/routes.js` `/api/business/board` | 在原端点上扩展为结构化 stages（不改路径，向后兼容） |
| 渲染纯函数 | `src/portal/businessClosureRender.js` | 零 `express`/`db.js`/服务端 import；导出 `renderBusinessClosure(data)` |
| 页面 | `src/web/business-closure.html` | `import '/portal/businessClosureRender.js'`；一次 fetch 只读快照，无轮询 |
| 静态路由 | `src/http/routes.js` | `/business-closure.html` + `/business-closure` 302 别名 + `/portal/businessClosureRender.js` |
| 导航 | `src/web/nav.js` | 增「📊 业务闭环」入口（业务门户，不进 configCenter） |

**复用关系**：`/api/business/board` 已存在且被 `/api/page/home` 复用，富化后两者同源；`businessClosureRender.js` 与 `agentConfigRender.js`/`memoryConfigRender.js` 同范式，浏览器可原生 ESM 加载。

## §3 数据契约（代码已探查，落盘对齐）

### §3.1 数据源
- 统一入口：`queryParticles({ type, tenantId: 'system', limit: 100 })`（`particleRepo.js:67`）。
- 粒子数据在 `p.payload`（`name`/`amount`/`stage`/`status`）；`p.id`/`p.type` 为元数据。

### §3.2 富化后的 `/api/business/board` 响应
```jsonc
{
  "stages": [
    { "key":"account",   "label":"客户", "type":"CRM_ACCOUNT",        "count":N, "totalAmount":null,
      "items":[{ "id","title","amount":null,"stage":null }] },
    { "key":"deal",      "label":"商机", "type":"CRM_DEAL",           "count":N, "totalAmount":X,
      "items":[{ "id","title","amount","stage" }] },
    { "key":"quotation", "label":"报价", "type":"CRM_QUOTATION",       "count":N, "totalAmount":X,
      "items":[{ "id","title","amount","stage":null }] },
    { "key":"contract",  "label":"合同", "type":"CRM_CONTRACT",        "count":N, "totalAmount":X,
      "items":[{ "id","title","amount","stage":null }] },
    { "key":"order",     "label":"订单", "type":"CRM_ORDER",           "count":N, "totalAmount":X,
      "items":[{ "id","title","amount","stage":null }] },
    { "key":"payment",   "label":"回款", "type":"CRM_PAYMENT_PLAN,CRM_PAYMENT_RECORD,CRM_INVOICE", "count":N(三类合计), "totalAmount":Y(已回款 paid_amount 合计),
      "items":[{ "id","title","amount"(按类映射),"stage":null }] }
  ],
  "leadPool": { "count": M, "note": "线索=CRM_DEAL 中 stage='lead'" },
  "total": { "dealAmount": X1, "contractAmount": X2, "receivedAmount": Y }
}
```

### §3.3 金额字段映射（服务端 SUM）
| type | 金额字段（payload） |
|---|---|
| `CRM_DEAL` / `CRM_QUOTATION` / `CRM_CONTRACT` / `CRM_ORDER` | `amount` |
| `CRM_PAYMENT_PLAN` | `plan_amount` |
| `CRM_PAYMENT_RECORD` | `paid_amount` |
| `CRM_INVOICE` | `invoice_amount` |
| `CRM_ACCOUNT` | 无（null） |

- **回款阶段合并**：`PAYMENT_PLAN`+`PAYMENT_RECORD`+`INVOICE` 三类为「回款」总览；`totalAmount` = 三类 `paid_amount`（已回款）合计；`count` = 三类条目数合计；`items` 三类合并，金额按各自字段。
- **线索池**：`leadPool.count` = `CRM_DEAL` 中 `payload.stage==='lead'` 的数量（派生，非独立查询）。
- **total**：`dealAmount` = 全部 DEAL `amount` 合计；`contractAmount` = 全部 CONTRACT `amount` 合计；`receivedAmount` = 全部 PAYMENT_RECORD `paid_amount` 合计。
- 向后兼容：保留 `grouped` 原结构字段（旧 `/api/page/home` 仍可用）。

### §3.4 下钻落点（复用现有 detail 页）
| 条目 type | 下钻 URL |
|---|---|
| `CRM_DEAL` | `/deal-detail.html?id=` |
| `CRM_QUOTATION` | `/quotation-detail.html?id=` |
| `CRM_CONTRACT` | `/contract-detail.html?id=` |
| `CRM_ORDER` | `/order-detail.html?id=` |
| `CRM_PAYMENT_PLAN`/`RECORD`/`INVOICE` | `/payment-detail.html?id=` |
| `CRM_ACCOUNT` | `/particle-detail.html?type=CRM_ACCOUNT&id=` |
| 阶段标题点击 | 该类型列表（复用：`/pipeline.html` 或粒子通用列表；默认落 `/business-closure.html#<key>` 高亮，不建新列表页） |

## §4 UI（复用 page.css 的 pg-* 类）

- 顶部「🎯 L2C 业务闭环」标题 + 「线索池 M 条」标注条。
- 6 张 `pg-card` 阶段流（横向/网格排列）：客户→商机→报价→合同→订单→回款。
- 每张卡：阶段名 + 数量徽标 + 金额（¥ 千分位格式化，null 显示「—」）+ Top 5 条目（标题 / 金额 / 状态）。
- 条目 `<a>` 可点下钻；卡片标题可点下钻。
- **只读页**：无新增/编辑/删除按钮。
- 空数据降级：`count=0` 显示「暂无数据」，不报错。

## §5 测试（TDD 红→绿）

1. `test/web/businessClosure.test.js`（新建，RED→GREEN）：
   - `renderBusinessClosure` 纯函数：6 阶段卡数正确、金额 ¥ 格式化、空降级、下钻链接正确。
   - `businessClosureRender.js` 守卫：零 `express`/`db.js`/`./decision`/`./alerts`/`./events` import（白名单放行 `particles/particleModel.js` 纯数据）。
   - handler 注入 `getBoard` 断言富化结构（stages 6 项 + leadPool + total）。
2. `test/web/browserLoadable.test.js` 补第 9 个 CASE（`businessClosureRender.js`）。
3. 全量 `test/web/` 回归无退化（基线 182/182，加上新增后应稳定）。

## §6 红线

- 只读、无写、绝对禁 DELETE、不绕决策第0闸。
- 不引报表引擎、不建 LEAD 粒子。
- 沿用 QA 安全范式（Render 子模块），杜绝根因 A。
- 每 Task 一 commit（沙箱无凭证，交付本地提交命令）。

## §7 验收口径

- `GET /business-closure.html` 200；`/api/business/board` 返回 6 阶段 + leadPool + total。
- 真浏览器快照确认 6 卡渲染、金额正确、下钻链接可点。
- `test/web/` 全绿；`browserLoadable` 守卫 9 项全过。

## §8 实施 Task 拆分（writing-plans 展开）

- **T1**（RED）：写 `test/web/businessClosure.test.js` 失败测试。
- **T2**（GREEN）：实现 `src/portal/businessClosureRender.js` 纯函数（含 ¥ 格式化、下钻链接、空降级）。
- **T3**：富化 `/api/business/board`（补 `CRM_ACCOUNT` + 金额映射 + 回款合并 + leadPool + total，保留 `grouped`）。
- **T4**：建 `src/web/business-closure.html` + routes 挂载（3 路由）+ `/business-closure` 302 别名。
- **T5**：`browserLoadable` 第 9 CASE + nav 入口 + 全量 web 回归 + 路由冒烟 + 真浏览器验证。

## §9 自检

- 无占位符、无内部矛盾（§3.2 与 §3.3 字段一致；§2 组件与 §8 Task 对应）。
- 范围明确：§1 已列「不做」清单；§3.4 下钻落点均指向现有页面，无新建列表页需求（YAGNI）。
- 待核实项均已消解（leadPool 数据源已定位为 DEAL-stage=lead）。
