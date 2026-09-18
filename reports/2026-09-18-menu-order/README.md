# 销售组菜单：顺序调整 + 两项改名 — 交付说明（2026-09-18）

## §0 结论

「销售」组完成**两阶段变更**，均为**单源改动 + 契约锁定 + 三层取证**：

| 阶段 | 内容 | 依据 |
|---|---|---|
| ① 换序 | 销售组重排为 线索发现 → 公海池 → 销售管道 → 客户跟踪 → 销售过程看板 | 用户指令：「销售里面的顺序为：线索发现-公海池-销售管道-客户360-销售过程看板」 |
| ② 改名 | 菜单「线索·商机」→「销售管道」、「销售行为看板」→「销售过程看板」，**页面 title/h1 同期对齐** | 用户裁定「还有两个改名」；**保留「客户跟踪」**（2026-08-29 合并定名，用户口语「客户 360」） |

| 项 | 内容 |
|---|---|
| 改动单源 | `src/portal/layoutMenu.js`（`FULL_MENU` 销售组 label/次序） |
| 渲染链路 | `src/portal/layoutMenu.js` → `src/web/layout.js` `navHtml()` 按分组 push 次序渲染 ⇒ **数组次序 = UI 次序**（单源走 `sendFile`，每次读盘无模块缓存） |
| 覆盖旧契约 | 2026-09-14「公海池紧邻线索·商机」作废（公海池的紧邻前项改为「线索发现」） |
| 未改 | href / 页面文件名 / 路由 / 权益门禁 / 分组归属 / 「客户跟踪」显示名 |

## §1 最终态对照

| # | 菜单显示名 | href | 权益门禁 | 落点页 title / h1 |
|---|---|---|---|---|
| 1 | 线索发现 | `/discovery.html` | `core_crm` | 线索发现工作台 |
| 2 | 公海池 | `/lead-pool.html` | `core_crm` | 公海池 · 待领取线索 |
| 3 | **销售管道**（原名 线索·商机） | `/pipeline.html` | — | CRM 销售管道 |
| 4 | 客户跟踪（口语「客户 360」） | `/named-accounts.html` | `customer_360` | 客户跟踪 · CRM |
| 5 | **销售过程看板**（原名 销售行为看板） | `/sales-behavior-board.html` | — | 销售过程看板（原 销售个人行为看板，已同步改） |

动线含义：找线索（发现）→ 入池/认领（公海池）→ 推进（管道）→ 客户经营（360）→ 行为复盘（看板）。

## §2 真实渲染结果（Playwright · alice/sales）

```
销售:     线索发现 → 公海池 → 销售管道 → 客户跟踪 → 销售过程看板     ← PASS
协同:     外部沟通接入 → 销售自动化 → 我的待办
基础数据: 📚 基础数据门户
洞察:     账单
页面 JS 错误: 无

[菜单名 = 落点页名]  逐个点开真实页面读 title/h1
  PASS  线索发现       vs title="线索发现工作台"      h1="线索发现工作台"
  PASS  公海池         vs title="公海池 · 待领取线索"  h1=""
  PASS  销售管道       vs title="CRM 销售管道"        h1=""
  PASS  客户跟踪       vs title="客户跟踪 · CRM"      h1="客户跟踪"
  PASS  销售过程看板   vs title="销售过程看板"        h1="销售过程看板"
```

截图：`sales-menu-order.png`（侧栏）、`renamed-board-page.png`（改名后落点页 h1）。

## §3 为什么改名要补一条新守卫

改动前的缺陷形态不是「谁写错了」，而是**两层各叫各的**：菜单「线索·商机」/ 页面「CRM 销售管道」；
菜单「销售行为看板」/ 页面「销售个人行为看板」。用户从侧栏点进去看到的名字与入口不一致。

⚠ **顺序断言抓不到它** —— 菜单名和页面标题各自都「没错」，只有**跨层相等**才是被违反的性质。
故在 `test/portal/layoutMenu.test.js` 新增 describe「「销售」组菜单名 = 落点页名（跨层一致）」3 例：

1. 五项销售菜单名必须出现在其落点页 `title` 或 `h1` 中（新增销售项不同步页面名 → 红）；
2. 页面侧旧名已清除（`销售个人行为看板` 不得残留，**否定断言已剥离 HTML 注释**）；
3. `pipeline.html` 标题含新名。

同时 `test/web/layout-menu.test.js` 增「旧显示名不得残留」循环断言（`线索·商机` / `销售行为看板` / `信号中心`）。

## §4 验证证据（四层）

1. **变异自证 A**（菜单名回退、页面保持新名）→ `test/portal/layoutMenu.test.js` 跨层守卫 + `test/web/layout-menu.test.js` label 数组 + `test/web/layout.test.js` **共 3 处红**，报错原文即 `菜单「线索·商机」≠ 落点页「CRM 销售管道」`。
2. **变异自证 B**（仅页面标题回退、菜单保持新名）→ 跨层守卫 2 例红（`菜单「销售过程看板」≠ 落点页「销售个人行为看板」`）。
3. **还原校验**：两组变异后还原，三文件 md5 与变异前**逐字节一致**（`fb5b6105…` / `783c9d1e…` / `49c318ff…`）。
4. **运行期渲染探针**：`scripts/verify-sales-menu-order.mjs` —— 直调 `navHtml()` 解析真实 HTML，4 用例 × (次序 + 显示名) **全 PASS**，含「权益裁剪后其余四项相对次序与显示名不变」；零浏览器，可入 CI。
5. **真浏览器**：`scripts/shot-sales-menu-order.mjs`（Playwright + 真实登录）→ 侧栏文本一致 + 5 个落点页跨层 PASS + 零 JS 错误 + 2 张截图。

**测试结果**
- 菜单相关 6 文件 **43 例全绿**（`test/portal/layoutMenu`、`test/web/layout-menu|layout|layout-nav|discoveryPage`、`test/portal-pipeline`）。
- 回归 `test/portal + test/web + test/config + test/ui`：**91 文件 / 770 例**，4 例红**均非本次引入**（`calibrationMonitor`、`decision-network-linkage`×2、`pipeline-new-deal`；断言对象的源文件在工作区无改动，属历史欠账）。

## §5 改动文件

| 文件 | 变更 |
|---|---|
| `src/portal/layoutMenu.js` | 销售组重排 + 两项改名 + 注释（顺序/显示名同步均记为契约） |
| `src/web/sales-behavior-board.html` | `title` 与 `h1`：销售个人行为看板 → 销售过程看板（2 处） |
| `src/http/routes.js` | 仅注释（L1 页改名留痕）**1 行** |
| `test/portal/layoutMenu.test.js` | 顺序契约注释更新 + 新增跨层一致 describe（3 例）+ `fs` 引入 |
| `test/web/layout-menu.test.js` | 11 项 label 数组、销售组 label/href 整组断言 + 旧名残留断言 |
| `test/web/layout.test.js`、`test/web/layout-nav.test.js` | 标签断言改用新名 |
| `scripts/verify-sales-menu-order.mjs` | 探针新增「显示名」断言（4 用例） |
| `scripts/shot-sales-menu-order.mjs` | 新增真浏览器跨层校验 + `renamed-board-page.png` |
| `reports/2026-09-18-menu-order/` | 本报告 + 2 张截图 |

## §6 提交（用户在本地执行 · 按功能线分组）

```powershell
# ① 导航单源 + 落点页改名（需求本体）
git add src/portal/layoutMenu.js src/web/sales-behavior-board.html src/http/routes.js
git commit -m "nav(sales): 销售组改名为 销售管道/销售过程看板（落点页 title/h1 同步）"

# ② 测试契约（顺序 + 跨层一致守卫）
git add test/portal/layoutMenu.test.js test/web/layout-menu.test.js test/web/layout.test.js test/web/layout-nav.test.js
git commit -m "test(nav): 锁销售组顺序与「菜单名=落点页名」跨层一致（含旧名残留断言）"

# ③ 取证脚本与报告
git add scripts/verify-sales-menu-order.mjs scripts/shot-sales-menu-order.mjs reports/2026-09-18-menu-order
git commit -m "test(nav): 运行期渲染探针补显示名断言 + 真浏览器跨层截图与交付报告"
```

> ⚠ 工作区另有**其他未提交改动**（`channel-config.html`、`discovery.html`、`db/migrate.js`、`vitest.config.js`、`package.json` 等，属前序任务）——**不要**用 `git add .` / `git add -A` 一并提交。
