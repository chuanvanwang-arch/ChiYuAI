# 全面系统检测报告：风格不统一 / 菜单混乱 / 开会后数据显示异常与新增失效

- 日期：2026-08-27
- 范围：src/web（31 个 HTML 页面）+ src/portal（7 个配置中心）+ src/page/pageStore.js + src/particles/particleRepo.js + src/decision/autonomyEngine.js + src/http/routes.js + db/schema.sql + db/seed.sql
- 方法：真实代码文件级证据（file:line）+ 运行态 API 实测（http://127.0.0.1:3000）+ 数据库直查（PG16 @5433 / crm schema）
- 结论形式：判定块（问题 → 证据 → 根因 → 修复建议）

---

## §0 结论摘要（先结论后细节）

| # | 问题 | 严重度 | 根因一句话 |
|---|------|--------|------------|
| P1 | 各业务页面风格严重不统一 | 高 | 31 个 HTML 每页自带独立内嵌 CSS，无统一主题 Token/组件库；CSS 量 0~5805 字符、主题变量 0~12 个、字体 4 类 |
| P2 | 左侧菜单与顶部菜单关系混乱 | 高 | 存在两套互不相关的导航体系：顶部 nav.js 条（22 项）与手写左侧 `<aside class="side">` 栏；不同页面拼装不同，无统一导航模板 |
| P3 | 开会后"数据显示不正常"：部分商机在管道/六段统计中不可见 | 中高 | `seed-test-deal` 的 `payload.stage='leads'`（非法值域，不在六段 key 内），`dealStageOf` 精确匹配导致进不了任何列/六段 |
| P4 | "新增/添加"无法真正生效 | 高 | 前端"新建线索/新增"入口走 `/api/page/from-nl` → 只产内存 draft 页面（pageStore.js 内存 Map），**不写数据库**；且 Action Registry 无"创建商机"Action |
| P5 | 部分写操作跳过决策第 0 闸 | 中高 | userManagement POST/PUT 直接 INSERT/UPDATE 后再 `recordDecisionEvent` 记账；与 configRouter/businessTier/alertRule 等先 `requireDecision` 拦截不一致 |
| P6 | 数据面存在运行期脏数据 | 中 | `seed-test-deal`、3 条 slug=`deal` 重复商机非种子来源，污染渲染与统计 |

---

## §1 P1：各业务页面风格不统一

### 证据（量化扫描，31 个 HTML）

| 页面 | 内嵌 CSS 字符数 | CSS 变量(Token)数 | 字体族 | `--ac` 强调色 |
|------|------|------|------|------|
| sales-decision-monitor.html | 5805 | 0 | system-ui / ui-monospace | 无 |
| portal-stage3-mockup.html | 5504 | 12 | -apple-system,Segoe UI,Roboto,PingFang SC | 无 |
| index.html | 3905 | 7 | system-ui,PingFang SC | #4f46e5 |
| decision-graph.html | 3488 | 9 | -apple-system,Microsoft YaHei | 无 |
| particle-detail.html | 2850 | 0 | system-ui | 无 |
| page-market.html | 2535 | 7 | system-ui,PingFang SC | #4f46e5 |
| … | … | … | … | … |
| deal-detail / contract-detail / order-detail / payment-detail / todo | **0** | 0 | 无 | 无 |

### 判定
- **无统一设计 Token**：仅 4 个页面定义过 `--ac` 强调色且只两处同为 #4f46e5；其余页面硬编码 hex。
- **无统一字体系统**：至少 4 类字体族混用；detail 类页面甚至无任何 CSS（完全靠受控渲染器内联样式）。
- **单页内联 CSS 差异 100 倍级**（0 vs 5805）。
- 根因：页面按 Task 逐页手写，未接入统一的 tokens.css / 组件样式；portal-stage3-mockup.html:16 自述 "sidebar (Attio 副骨架)" 也佐证"借鉴自不同骨架"。

### 修复建议
1. 建立一套 `src/web/tokens.css`（对齐 index 页 `--bg/--panel/--ink/--mut/--line/--ac/--as` 7 Token，index.html:6），全部页面首行引入。
2. 抽公共组件样式（nav 条、卡片、表格、表单、按钮）到 `src/web/common.css`，各页删除重复内嵌块。
3. detail 类 5 页（deal/contract/order/payment/todo）统一经 renderer 注入同一基础样式（当前 0 CSS 说明它们只靠渲染器 inline，风格与其他页完全脱节）。

---

## §2 P2：左侧菜单与顶部菜单关系混乱

### 证据（导航注入路径扫描，30 个业务页）

| 导航形态 | 页面 | 证据 |
|---------|------|------|
| 顶部 nav.js 条（22 项） | pipeline/workbench/kanban/deal-detail/quotation-detail/contract-detail/order-detail/payment-detail/decision-graph/rbac/approval-flow/… | `import '/portal/nav.js'`（各页） |
| **左侧 `<aside class="side">` 栏（无顶部条）** | index.html:52-62、page-market.html:38-46、portal-stage3-mockup.html:83-98 | 手写侧栏 220px |
| **左侧栏 + 顶部条双导航** | meta-attr-drawer.html（aside 20-23 + nav.js:56） | 顶部与左侧并存 |
| 无任何导航 | agents.html、config.html、decision-scenarios.html、business-tier.html、alert-rules.html、mcp-identities.html、home.html | nav.js=0 且无 aside |

### 判定
1. **两套导航互不相关**：
   - 顶部条 = `src/web/nav.js` 动态注入（`ITEMS` 22 项，nav.js:4-26），深色底 22 个链接平铺，无分组、无层级。
   - 左侧栏 = 各页手写的 220px `<aside>`（index.html:8-13 / page-market.html:8-13 / portal-stage3:17-25），菜单项本身与顶部条**内容不一致**。
2. **同一产品存在 3+ 种导航组合**（仅顶部 / 仅左侧 / 顶左都有 / 都没有），用户无法建立一致的"菜单在哪里"心智模型——这正是"左侧菜单与顶部菜单什么关系"的困惑来源。
3. **链接目标分叉**：page-market.html:41 左侧栏把"线索池/商机/L2C 看板"都指向 `/kanban.html`，而顶部 nav.js:6 的同类入口指向 `/pipeline.html`（`🎯 线索池 / 💼 商机`）→ 同一业务菜单在不同页面落到不同路由。
4. **nav.js 引入路径不一致**：绝大多数 `import '/portal/nav.js'`，users.html:31 用 `/web/nav.js`，todo.html:8 用非 module `<script src>` → 存在两种资源定位方式。
5. **nav.js 22 个平铺项本身过载**（首页/线索/商机/审批/决策网络/报告/任务执行/智能体工作台/客户360/待办/5 个详情页/池配置/粒子详情/智能体监控/监控台S04/配置中心/决策场景/用户管理），把"业务页"与"配置页"与"详情页"全部平铺，无分组。

### 修复建议
1. 定导航规范：**全局唯一顶部条（角色自适应，分组折叠）**或**全局唯一左侧栏**，二选一，全站统一；nav.js 作为唯一导航源。
2. nav.js ITEMS 分组：业务（首页/线索池·商机/审批/客户360 …）→ 分析（决策网络/报告）→ 执行（任务/智能体工作台/监控）→ 管理（配置中心/用户/决策场景/页面市场）；22 项折叠为 4 组下拉。
3. 统一 nav.js 资源路径（`/portal/nav.js`）与引入方式（全 module）；修正 page-market 左侧栏路由指向 `/pipeline.html`。
4. 消除双导航页（meta-attr-drawer）与无导航页（config/agents 等），全站同一导航注入。

---

## §3 P3：开会后数据显示不正常——商机在管道/六段统计中不可见

### 证据（运行态直查数据库 + 接口实测）
- 数据库 8 条 CRM_DEAL 的 stage：
  - `deal-lead` stage=`lead` ✔ / `deal-quoted` stage=`quoted` ✔ / `deal-contracted` stage=`contracted` ✔ / `deal-paid` stage=`paid` ✔（seed.sql:30-58，规范值域）
  - `deal` ×3（contracted×2 + lead×1）——**非种子重复 slug**
  - `seed-test-deal` stage=`leads` ✘ **不在六段 key 内**（`lead/opportunity/quoted/contracted/ordered/paid`，scoring.js:33-40）
- `/api/business/board`（routes.js:231-246）返回 grouped 全量，但前端管道按 `dealStageOf(p) === st.key` 精确匹配（scoring.js:42-51；pipeline.html:70-77）→ `leads` 落入任何列之外的"幽灵"。
- seed.sql:6 明确纪律："业务阶段存 payload.stage"、六段 key 固定——`leads` 违反该契约。

### 判定链
1. 数据并未丢失（8/20 粒子都在），但对**管道列视图**与**首页 L2C 六段**（index.html:150 经 pipelineCounts）而言，`leads` 不计入任何段 → 看起来"开完会后商机不见了"。
2. 开会/拜访归来回写（docs/2026-08-27-拜访归来回写操作卡.md）若通过 NL 或脚本写入新商机，若 stage 未按六段枚举取值（如 `leads`），即产生此类不可见数据。
3. 重复 slug `deal` ×3 + `seed-test-deal` = **运行期测试/演示写入残留**，污染统计口径。

### 修复建议
1. 强制 stage 值域校验：`createParticle`（particleRepo.js:11-23）对 CRM_DEAL 增加六段枚举白名单，非法值拒绝或规范化为最近合法段。
2. 数据修复（一次性 SQL）：把 `leads` → `lead`；重复 slug 的 `deal` 重命名或清理。
3. 管道/六段渲染对未知 stage 增加"未分类"兜底列（既不丢数据也可发现脏值），不要静默丢弃。

---

## §4 P4：无法新增——"新增/添加"入口不落库

### 证据
1. **首页命令栏是"新增"主要入口**：index.html:66 占位"一句话驱动动作：给 30 天未跟进的商机生成唤醒邮件 / 生成本周 pipeline 一页报告"；index.html:115 调 `POST /api/page/from-nl`。
2. **from-nl 只产内存 draft 页面**：pageStore.js:10-11 `const pages = new Map()`；createPageFromNl（pageStore.js:13-46）→ ③校验 → ⑤ `pages.set(pageId, record)` ——**全程无 SQL 写入**。routes.js:762-767 确认"不入库，内存 Map"。
3. **Action Registry 无"创建商机/线索"Action**：seed-actions.js 全线只有 deal_id 操作（advance 98 / pick 130 / recycle 183 / proposal 237 / rollback 321 / wake 494），grep `create|new_deal|新建` 无 CRM_DEAL 创建型 Action。
4. **pipeline.html:95** "暂无商机 — 用命令栏「新建线索」入池" → 命令栏产物不进粒子库 → **新增永远不生效**（按钮看似"做了"，刷新后无数据）。
5. businessTier/mcpIdentity 有新增表单（business-tier.html:47、mcp-identities.html:30 "+ 新增身份"）——但那是**配置类新增**（写 crm.business_tier_config / crm.mcp_identity），与"业务商机新增"是两回事；用户若在业务场景点"新增"却只得到配置类表单，即感知"无法新增"。

### 判定
- **业务数据新增（线索/商机/客户/报价）缺少真实写通道**：没有"创建粒子"的 HTTP 端点 / Action；唯一 NL 入口是页面生成器，与业务数据面完全隔离。
- 配置类新增可用（businessTier PUT 等），但用户"开完会想新增一个商机/客户"无处下手 → "无法新增添加"。

### 修复建议（按阶段）
1. **最小可用**：新增 `POST /api/particles`（经 executor 写通道：requireDecision('scene-deal-create'，走第 0 闸) + createParticle）→ pipeline 与首页即可新增。
2. **Action**：seed-actions.js 增 `crm-deal-create`（含 stage 枚举、name/account/owner 必填），供 NL 引擎与智能体引用。
3. 前端：命令栏 NL 命中"新建线索/新增商机"时路由到该 Action（确认→提交），而非 page draft；或 pipeline 页加"＋ 新建商机"按钮直达写通道。
4. 保留 from-nl 只做"页面/报告生成"，两者职责分离（页面 draft ≠ 业务数据）。

---

## §5 P5：部分写操作偏离"写经决策第 0 闸"

### 证据
- 规范路径：configRouter.js:33 `requireDecision(scene, ctx)` → 拦截后才写；businessTier.js:61 先 `requireDecision` 后 `upsertTier`（businessTier.js:96-97 顺序 = produceDecision → upsert）；alertRuleConfig.js:98 / approvalFlow.js:99 / rbacMatrix.js:138 / mcpIdentity.js:89 同模式；seed-actions.js:106/158/198/245/511 业务 Action 全走 requireDecision。
- **例外**：userManagement.js POST（161-180）**先 `createUser` INSERT（168-174）→ 后 `recordDecisionEvent`（175）**；PUT 同样先 recordDecisionEvent（189-193）再 updateUser（194）。文件头注释自称"写经决策第0闸"（userManagement.js:5），实现却是**事后悔账**。
- requireDecision 本体（autonomyEngine.js:46-133）设计为**写前**判定（先算 tier→先例→置信度→createDecision 落决策→返回 mode），与"无决策不写"契约一致；userManagement 未调用它。

### 判定
- 同一"配置写"面上，5 个 router 走写前第 0 闸、1 个（用户管理）走先写后记 → **决策闸行为不一致**。
- 影响：新增用户等写操作无决策上下文也照样落库（闸失效）；也解释了为何"新增"有时看起来生效（配置类）有时不生效（业务类）——治理规则不统一。

### 修复建议
- userManagement.js 对齐：POST/PUT 前置 `await requireDecision('config-change', {type:'user_create'|'user_update', ...})`（失败返回 403 不写库），再执行 INSERT/UPDATE；决策事件由 requireDecision 内部 produce，删除重复的 `recordDecisionEvent`。
- 建议加一条回归测试：无决策上下文时 user POST 应被拦截（对照现有 configRouter 测试）。

---

## §6 P6：运行期脏数据残留（测试/演示写入未治理）

### 证据
- 数据库 CRM_DEAL 8 条中：`seed-test-deal`（stage=leads）+ 3 条 slug=`deal`（contracted/contracted/lead）。
- seed.sql 只有 4 条 DEAL（deal-lead/quotd/contracted/paid）；`seed-test-deal` 与 3 条 `deal` **均不在 seed.sql**（grep 无结果），来自运行期测试/演示脚本。
- state 列也不规范：`deal`（lead）state=`lead`、`deal`（contracted）state=`contracted`——本应是粒子生命周期 ACTIVE（schema.sql:17 默认 ACTIVE，seed.sql:6 纪律"state 列是粒子生命周期"），却被写成业务 stage。**state 与 stage 语义混用**。
- board 接口原样返回这些脏行（routes.js:231-246 无过滤）→ 前端渲染出混乱数据（同一 slug 多条、state 值异常）。

### 判定
- 脏数据 = 测试/演示用粒子直接写入了生产库 crm.particles，未清理、未隔离（测试应走独立库或事务回滚）。
- state/stage 语义混用会连锁破坏：审批流按 state=submitted 判定（routes.js:155/264）、状态机按 state 迁移，污染后"数据异常"。

### 修复建议
1. 一次性 SQL 审计清理：DELETE/重命名 `seed-test-deal` 与重复 slug；将误写 state 的 `deal` 改回 ACTIVE。
2. 测试基建隔离：E2E/演示写入显式标记（如测试专属 type 或租户 `tenant_id='test'`），或测试前后 TRUNCATE 相关表（对齐 Stage1 教训：test 与生产数据面分离）。
3. 评估类写入（evaluateAiAttributesFor 写回 payload）与手工 SQL 统一入口，防止再次直接注入。

---

## §7 修复优先级与工作量参考

| 优先级 | 动作 | 涉及文件 | 预估工作量 |
|-------|------|---------|-----------|
| P0（止血） | 数据清理 SQL（leads→lead、去重 deal、state 归位） | db/ 一次性脚本 | S |
| P0 | 新增业务写通道（POST /api/particles + crm-deal-create Action + 前端按钮） | routes.js、seed-actions.js、pipeline.html、index.html | M |
| P1 | 导航统一（nav.js 分组 + 全站唯一导航 + 修正 link 分叉） | nav.js、index.html、page-market.html、portal-stage3、meta-attr-drawer | M |
| P1 | 启动 tokens.css / common.css 统一主题 | src/web/tokens.css 新建 + 31 页接入 | M |
| P2 | userManagement 补 requireDecision 第 0 闸 | userManagement.js | S |
| P2 | stage 枚举校验 + 未分类兜底列 | particleRepo.js、scoring.js、pipeline.html | S |
| P2 | 测试数据隔离（test 租户/清理） | test/、db/seed | M |

注：以上为检测结论与修复方向，未改写任何实现代码；如需实施请按项目铁律先补齐对应设计/计划并经确认。

---

## §8 检测方法说明（可复现）

1. 页面扫描：`for f in src/web/*.html` 统计 nav.js/aside/header 出现次数；node 脚本统计 CSS 量/Token/字体/内联样式。
2. 接口实测：`curl /api/business/board`、`/api/agents`（本机 3000 端口）。
3. 数据库直查：`SELECT slug, payload->>'stage' FROM crm.particles WHERE type='CRM_DEAL'`（PG16 @5433，crm schema）。
4. 源码 grep：requireDecision 引用点、seed-actions 的 Action 清单、pageStore 内存 Map、nav.js ITEMS。