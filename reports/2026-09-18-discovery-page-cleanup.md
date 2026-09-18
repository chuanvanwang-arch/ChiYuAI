# 线索发现工作台「一堆说明看不懂」→ 干净化修复报告

日期：2026-09-18 ｜ 页面：`src/web/discovery.html` ｜ 用户二次反馈（附截图）

## §0 结论先行

用户看到的「一堆说明」不是内容多，是**把机制原理当用户信息常驻显示**：

| 位置 | 原内容 | 性质 |
|---|---|---|
| triggerBar 三条说明 | 「ICP 画像：在『线索发现规则』中配置（未配置时付费源返回空＝预期 fail-open）」等 | 零数据、零 JS 消费的**写死说明** |
| 「说明：运行发现不在本页执行…」 | 解释写操作走 MCP 两阶段 + 决策第 0 闸 | 工程流程，用户不需要知道 |
| 定向拓客下方 6 句 | 讲 enrich 与 search 的语义差、data-particle-create、fail-open | 后端契约，不是操作指引 |
| 候选池空态 4 条 bullet | 讲 `payload.discovery.icp_fit_score`、两条链路关系 | 字段级原理，读不懂 |

常驻可见文案合计 **≈360 字**（全回退变异体实测 **536 字**）。

**另有版式根因**：本页用的 `.pg-card / .pg-title / .toolbar / .sub` 四个类，**全站 CSS 均无定义** ——
站点里是 `.card/.panel/.sect-title/.page-sub`（`.toolbar` 是全站页面级约定、须页内声明）。
类名写错不报错 ⇒ 卡片无边框、控件零间距、文字无色阶，正是截图里「挤成一坨」的成因。

## §1 改了什么

### 1.1 删（用户不可见信息一律撤出常驻区）

| # | 删除项 | 依据 |
|---|---|---|
| 1 | `#icp-summary` / `#data-source-badges` / `#last-run-at` 三个 div | 全仓 grep **各仅 1 命中（自身声明）** ⇒ 零 JS 消费，只能写死假值；写死的数据源名会与配置中心真实配置**相互撒谎** |
| 2 | 「说明：运行发现不在本页执行…」整段 | 信息已编码进按钮文案「去对话运行发现 →」 |
| 3 | 定向拓客 6 句说明 → 1 行 | 保留唯一有操作价值的：「不入候选池」+ 批量找候选去公海池 |
| 4 | 空态 4 条 bullet → 1 行 | 保留：数据从哪来 + 可点入口 |
| 5 | 下拉项注解（「需 GAODE_KEY」「需配凭据」） | 属配置侧知识，不占操作区 |
| 6 | 表头 `why_narrative` → **推荐理由**（原字段名收进 `th[title]`，hover 可见） | 用户上一份截图圈的就是它 |

### 1.2 版式（改前/改后对照）

| 项 | 改前 | 改后 |
|---|---|---|
| 容器 | 无 `.wrap`，内容贴视口 | `.wrap`（padding 18/20，max-width 1180，居中）——与 `discovery-rules.html` 同范式 |
| 卡片 | `class="pg-card"`（**无定义**） | `class="panel"`（common.css:68 单源组件） |
| 分区标题 | `class="pg-title"`（**无定义**） | `class="sect-title"`（common.css:137，带 accent 竖条） |
| 控件行 | `class="toolbar"`（**无定义** ⇒ 零间距） | 页内声明 `.toolbar{display:flex;gap:10px}` + input/select padding（照 `lead-pool.html`） |
| 提示文字 | `class="sub"`（**无定义**，且 common.css:119 声明该类已按规范移除） | `class="hint"`（页内声明，`--mut` 灰字） |
| 表头 | 5 个 `th` 挤成一行文字 | `.table` + `nowrap`，正常分列 |

### 1.3 保留的原则

- **入口不删**：`去对话运行发现 →`（写类动作本页不得裸调）+ `发现规则`
- **就近声明**：「不入候选池」放在*操作控件旁边*，而非候选池空态里远程解释
- **信息按需出现**：`data-particle-create`（落库指引）只在**画像取数成功后**的状态行出现 —— 用户刚拿到数据才是需要它的时刻

## §2 判据与自证（不靠手感，靠闸门）

新增两条可回归判据，落在 `scripts/verify-discovery-page-render.mjs`：

| 判据 | 内容 |
|---|---|
| **⓪ 文案预算** | 常驻可见文案 ≤160 字（现 **145**）；triggerBar 内不得有解释性 `.sub`；三个死元素不得回流；常驻文案不得出现 `fail-open` |
| **⓪b 类名有效性** | 页面所有 `class` 必须在**本页实际引用的样式表 + 页内 `<style>`** 中有定义 |
| **① 空态预算** | 空态文案 ≤60 字（现 **40**），且须含来源说明 + 可点入口 |

探针结果：**31 项断言全绿**（原 24 → 29 → 31）。

**变异自证 7/7 全被抓**（`tmp/_mutate_disc_clean.mjs`）：

| 变异体 | 红 |
|---|---|
| m1 塞回 triggerBar 三条说明 | 5 |
| m2 空态回退 4 条 bullet（259 字） | 1 |
| m3 定向拓客回退 6 句 | 3 |
| m4 表头回退 `why_narrative` | 1 |
| m6 类名回退 `.pg-card` | 2 |
| m7 删掉页内 `.toolbar` 定义 | 1 |
| m5 全部回退（536 字） | 6 |

### ⚠ 判据自身踩的两个坑（已修，也是本轮教训）

1. **扫了本页拿不到的样式表**：初版扫 `tokens/common/page` 三个 css，但本页**没引 `page.css`** ⇒ 把拿不到的类算成「已定义」。修正为只读 `<link>` 里真实引用的表。
2. **未剥 CSS 注释**：`common.css:119` 注释里写着「描述行(.page-sub/.muted/**.sub**)已按统一规范移除」—— 若不剥注释，`.sub` 会被当成**有效类**，而它在本页是零样式死类。⇒ **否定断言/定义集合必须剥离注释**（本仓既有纪律的再次验证）。

## §3 验证

| 项 | 结果 |
|---|---|
| `test/web/discoveryPage.test.js` | 11/11 通过（新增「文案预算 + 禁死元素回流」1 条） |
| `npm run probe:discovery-ui` | 31/31 通过 |
| 变异自证 | 7/7 被抓 |
| Playwright 实机 | 卡片/间距/表头分列正常；`#triggerBar` 内 `.sub`=0；残留死元素=0；**页面错误 0** |
| 全量 `test/web` | 596 通过 / **4 红（既有欠账）** |

4 红与本轮**无交集**（`grep -c discovery` 三个测试文件均为 **0**）：断言对象是
`sales-decision-monitor.html`、`decision-scenarios.html`、`pipeline.html`、校准页 —— 属工作区既有红。

## §4 遗留（本轮未动）

| 级别 | 项 |
|---|---|
| P1 | `gaode.js:15` 读 `ctx.gaodeKey`，而 `lookupRouter.js:33` 只传 `{tenantId, credentials}` ⇒ 配了凭据也不生效（只能靠环境变量）。对照正确写法 `qixin.js:38` 的 `ctx.credentials?.qixin` |
| P1 | `emailVerify`/`webResearch`/`tender` 依赖的 `ctx.verifyEmail`/`ctx.research`/`ctx.tenderSubscription`，`lookupRouter` 均未注入 ⇒ 经该通路恒空 |
| P2 | `#glassBoxDrawer` 的 `class="drawer"` 全站无定义（探针已白名单标注）；C2 抽屉整体未接线 |
| P2 | 候选池结构性永空未变：只显示带 `payload.discovery.icp_fit_score` 的客户，全库该字段命中 0 |
| 提示 | 开发库残留假凭据槽 `config_store(system,'integration-secrets').channel-email-system`（上一轮遗留，按禁 DELETE 铁律未自清） |
