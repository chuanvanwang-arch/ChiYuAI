# 客户 360 重构设计：S06 + S35 合并为单页双 Tab（含选客户）

- 日期：2026-08-29
- 触发：用户截图反馈"客户 360 字段不会填" → 诊断（见 `.workbuddy/memory/2026-08-29.md` 客户360诊断段）后确认根因=三型字段视觉不分 + 默认命中空 fixture；用户拍板方向：将 S06 客户360 与 S35 客户洞察合并为单页、用 Tab 区分，且先有"选客户"。
- 状态：待评审批准（brainstorming 硬闸门，未批准不写实现代码）

---

## §0 背景与问题

三页现状（代码证据）：

| 页 | 文件 | 路由 | 鉴权 | 内容 |
|---|---|---|---|---|
| S06 客户360 | `src/web/account-360.html` | `/api/page/account-360` (routes.js:556) | **无闸** | 三字段(attr-field) + 最新动态(table) + AI 建议(result-card) + 七维(metric-card×7) + 推理链 |
| S35 客户洞察 | `src/web/account-insight.html` | `/api/page/account-insight` (routes.js:618) | **有闸**(resolveMe 401 + 角色字段权限 + self 范围 403) | KPI 四联 + L2C 六段(pipeline) + 回款/健康度(progress-card) + 时间线/任务线/决策链(table) + 推理链 |
| pipeline | `src/web/pipeline.html` | `/pipeline.html` | 看板 | 跨客户 L2C 聚合（与单客户两页正交，本次不动） |

S06/S35 已通过超链接互联（S06:25「查看深度洞察→」、S35:27「← 返回客户 360」），但**两页跳转割裂**，且：

1. **三型字段视觉不分**（renderer.js:226-244 badge + 287-319 attr-field 兜底）：`external` 类型被渲染成可写 `<input>`，与 `manual` 无视觉差异 → 用户"不会填 / 不知道干嘛"。
2. **默认命中空 fixture**：`routes.js:560` 取 `accounts[0]`，生产库有 4 条同名 Acme fixture（payload 仅 `{name,domains}`）→ 七维全"缺失"、状态 fallback 'ACTIVE'。
3. **"暂无数据"错位**：table 组件 evRows=[] 时占位被 grid 拖到下一行。

---

## §1 目标 / 非目标

**目标**
- 单页双 Tab：**画像 Tab（原 S06）** + **洞察 Tab（原 S35）**，顶部统一"选客户"下拉。
- 修复三型字段视觉：manual 可写 / external 只读+待接入徽标 / rule 锁定🔒。
- 默认不再盲取 `accounts[0]`；选客户后双 Tab 共享 accountId。
- 空 fixture / 缺字段时出"请补全画像"引导卡，不再一片"缺失"。
- 修复"暂无数据"错位。

**非目标**
- 不动 pipeline.html（跨客户聚合，正交）。
- 不改七维判定口径（routes.js:572-580 派生逻辑保留）。
- 不改 S35 的 KPI/管道/健康度算法（buildMetrics 等复用）。

---

## §2 新页面信息架构（单页 + 选客户 + 双 Tab）

```
┌─────────────────────────────────────────────────────────────┐
│ [← 返回]  选择客户：[上海印通包装 ▾]   角色：sales   (topbar) │
├─────────────────────────────────────────────────────────────┤
│  Tab: [ 画像 ]  [ 洞察 ]                                      │
├─────────────────────────────────────────────────────────────┤
│ 画像 Tab（S06）：                                              │
│   三字段卡：客户名称(人工)│所属行业(外部采集·待接入)│客户状态(规则🔒)│
│   七维完整度：身份/结构/语义/时间与配置/决策历史/运营状态/治理   │
│   最新动态(table 3 条) │ AI 下一步建议(result-card)           │
│   推理链(reasoning-trace)                                      │
├─────────────────────────────────────────────────────────────┤
│ 洞察 Tab（S35）：                                              │
│   KPI 四联(交易金额/过程活跃度/决策与风险)                      │
│   L2C 六段(pipeline) │ 回款进度/客户健康度(progress-card)      │
│   时间线/任务线/决策链(table) │ AI 洞察(reasoning-trace)        │
└─────────────────────────────────────────────────────────────┘
```

- **选客户**优先于 `accounts[0]`：进入页面先渲染 topbar 的 `account-select`（复用 S35 既有下拉逻辑，account-insight.html:51-58）；默认选中项 = 最近查看 / 我的客户（self 模型取 owner_id=actor）；无则首个有完整 payload 的客户；仍空则提示"请先创建客户"。
- **空画像引导**：画像 Tab 检测 `industry/region/owner` 全缺 → 顶部插入"请补全画像"引导卡（指向 crm-account-create / 编辑入口），七维仍渲染但标注"待补全"。

---

## §3 组件映射（复用既有 schema，不重写）

| Tab | 复用 schema | 数据端点 |
|---|---|---|
| 画像 | `src/pages/S06.schema.js` | `/api/page/account-360?accountId=` |
| 洞察 | `src/pages/S35.schema.js` | `/api/page/account-insight?accountId=` |

- 两个端点**保留不动**，前端用 Tab 切换时各取各的数据（避免一次拉全量）。
- `account-insight.html` 改为：检测 `?id=` 直接以"洞察 Tab 激活"打开统一页（或 301 重定向到 `account-360.html?id=...&tab=insight`）。推荐后者，单页唯一入口。

---

## §4 三型字段视觉规范（修本 bug，renderer.js）

`src/page/renderer.js` 的 `renderSourceBadge`(226-244) 与 `attr-field`(287-319) 改造：

| data_origin | 输入态 | 徽标 | 说明文字 |
|---|---|---|---|
| `manual` | 可写 input | 绿点「人工填写」 | 用户可维护 |
| `external` | **disabled 灰底只读** | 蓝标「外部采集 · {source} {confidence}」+ 副标「待接入/已同步」 | 不可手填；空时显「待外部源接入」占位，不显空白 input |
| `rule` | disabled + 🔒 | 紫标「规则派生」 | 锁定，由引擎计算 |

- 关键修复：renderer.js:307-318 兜底分支**仅对 `manual` 放开可写**；`external`/`rule` 一律 disabled。消除"external 空 input 能填"的误导。

---

## §5 鉴权模型（合并后）

- **整页需登录**：统一页 `/api/page/account-360` 增加 `resolveMe` 闸门（401 未登录）；洞察 Tab 数据沿用 S35 既有 `applyFieldPerms` + `scope` 过滤（self 模型 owner 不符 403）。
- 理由：洞察含交易/回款/决策，本就需权限；合并后整页统一鉴权最简单且安全一致。失去 S06 原"演示开放"属性，对内 CRM 可接受。
- 若需保留 S06 开放预览：画像 Tab 在无 token 时降级为只读摘要（另议，本期不采用）。

---

## §6 路由 / 文件变更

| 文件 | 变更 |
|---|---|
| `src/web/account-360.html` | 重写为单页壳：topbar(选客户+角色) + Tab 切换 + 两个 `#root`（画像/洞察）；fetch 两端点 |
| `src/web/account-insight.html` | 改为重定向/以 `tab=insight` 打开统一页（保留深链兼容） |
| `src/http/routes.js` | `/api/page/account-360` 加 `resolveMe` 闸 + 默认客户选择逻辑（最近查看/我的客户优先）；`/account-insight` 路由调整 |
| `src/page/renderer.js` | 三型字段视觉（§4） |
| `src/pages/S06.schema.js` | 新增"空画像引导卡"组件（或前端条件插入），其余不变 |
| `src/portal/page.css` / `common.css` | 三型徽标子样式 + Tab 样式 |

---

## §7 默认客户与 fixture 引导

- `routes.js:560` 选客逻辑改为：`accountId || 最近查看(本地缓存) || 我的客户(owner=actor) || 首个 payload 完整客户 || 提示创建`。
- 不再盲取 `accounts[0]`，规避 Acme fixture 默认命中。
- 诊断脚本 `tmp/diag-2026-08-29-acme.mjs` 已确认：生产库 12 条 CRM_ACCOUNT 中 4 条为 Acme fixture（建议后续清理或迁移 demos 库，不在本期范围）。

---

## §8 验收口径

- 选客户下拉出现，切换后双 Tab 数据随选客刷新。
- 画像 Tab：所属行业（external）显"外部采集·待接入"灰底只读，不可填；客户状态（rule）显🔒；客户名称可写。
- 选真实客户（上海印通）七维不全"缺失"；选空 fixture 出"请补全画像"引导卡而非一片缺失。
- 洞察 Tab 带角色字段权限；sales 金额🔒；self 模型非本人客户 403。
- "暂无数据"不再错位。
- 既有 S06/S35 单测不回归（renderer 视觉变更需补 1-2 例三型断言）。

---

## §9 任务拆分（每 Task 一 commit，用户本地提交）

1. **T1 统一页壳 + 选客户**：重写 `account-360.html`（topbar + 双 Tab + 两 root），复用 S35 下拉逻辑；`account-insight.html` 改深链兼容。
2. **T2 路由鉴权 + 默认选客**：`/api/page/account-360` 加 `resolveMe` 闸 + 选客优先级（最近查看/我的客户/完整 payload）；`routes.js` 调整。
3. **T3 三型字段视觉**：`renderer.js` badge + attr-field 改造（external 只读待接入 / rule 锁定 / manual 可写）+ page.css 子样式。
4. **T4 空画像引导 + 暂无数据错位**：S06 schema 加引导卡组件 / 前端条件插入；修复 table 空态贴位。
5. **T5 测试与验收**：补 renderer 三型断言；agent-browser 走查双 Tab + 选客户 + 空 fixture 引导 + 权限；既有 S06/S35 测试绿。

---

## 待用户拍板的开放点

- A. 鉴权：**整页登录**（推荐）vs 画像 Tab 开放降级。
- B. `account-insight.html`：301 重定向到统一页（推荐）vs 保留独立页仅加 Tab 同步。
- C. 默认客户：最近查看缓存（推荐）vs 我的客户优先 vs 完整 payload 优先。
