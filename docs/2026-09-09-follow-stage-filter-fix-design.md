# 待跟进（follow）视角阶段过滤修复 · 设计文档

- 日期：2026-09-09
- 触发：alice 身份实测，follow 视角 18 条商机只报 2 条
- 状态：**待批准**（brainstorming 输出，未批准前不写实现代码）
- 决策记录：阶段语义集合 = **方案 A（非终态即 S1–S6）**（用户 2026-09-09 拍板）

---

## §0 结论先行

`follow` 视角仍在用**已废弃的旧英文阶段值** `lead` / `opportunity` 过滤商机，而全库阶段早在术语改造后统一为 S 码（S1–S8）。修复方式**不是补一个 value 列表**，而是复用已存在的单一事实源 `toStageCode()`，并把「是否终态」的判断也上移到 `stageTaxonomy.js`——**杜绝第三套命名**。

缺陷共 **2 处孪生代码**，不是 1 处。

---

## §1 现状证据（代码级）

| # | 位置 | 现状 | 判定 |
|---|---|---|---|
| 1 | `src/http/workbenchRouter.js:184-185` | `const st = p.payload?.stage \|\| 'lead'; if (st === 'lead' \|\| st === 'opportunity')` | 🔴 主缺陷 |
| 2 | `src/http/routes.js:1616-1617` | 旧入口 `/api/page/todo` 内**逐字相同**的分支 | 🔴 孪生缺陷（用户初报时未覆盖） |
| 3 | `src/sales/stageTaxonomy.js:53` `toStageCode()` | 已实现 `lead→S1 / opportunity→S2 / quoted→S3 / contracted→S4 / ordered→S5 / paid→S6 / lost→S7 / disqualified→S8` | 🟢 正解依赖，已存在 |
| 4 | `src/sales/stageTaxonomy.js:5-9` | `S_STAGES`、`S_LABEL`（S7=输单 / S8=丢单） | 🟢 终态定义来源 |

### 生产实测（只读探针，2026-09-09）

`crm.particles` 中 `type='CRM_DEAL'` 共 **18 条**，按 `tenant_id / stage`：

| 租户 | 分布 | 小计 |
|---|---|---|
| system | S1×2、S4、S5、S7、contracted、lead×2、**leads**、paid、quoted | 11 |
| acme-demo | S1×2、S2、S3、S4 | 5 |
| acme-chem | S1×2 | 2 |

- **过滤器实际只放行 2 条**（`stage='lead'`），**漏报 16 条**（非用户初报的 10 条）。
- 存在脏值 `leads`（复数，1 条），`toStageCode()` 无法归一。
- `follow` 视角**无 owner 过滤**：修完后 alice 看到的是整个 `system` 租户在跟商机，不止其名下 2 条（XX制造 S4 / B新能源 S7）。

---

## §2 目标 / 非目标

**目标**
1. follow 视角按 S 码判定「在跟」，覆盖全部未终结商机。
2. 旧英文值（lead/quoted/contracted/ordered/paid/lost/disqualified）经归一后行为正确，无需数据迁移。
3. 阶段判定逻辑唯一事实源化，供 workbenchRouter 与 routes.js 共用。

**非目标**
- 不改动任何阶段值数据（无 UPDATE、无迁移）。
- 不新增/修改 S 码语义、不动 `S_TRANSITIONS` / `S_GATE_DEFS`。
- 不动 follow 视角的 owner 过滤缺失（属独立议题，见 §7）。
- 不动其余 `'lead'` 硬编码点（见 §7）。
- 不含 P1「自审自」（`matchApprover` 缺 submitter≠approver 校验），另立一轮。

---

## §3 方案（唯一，已拍板 A）

### 3.1 新增单一事实源常量与判定函数

`src/sales/stageTaxonomy.js` 追加（纯新增，不改既有导出）：

```js
export const S_TERMINAL_STAGES = ['S7', 'S8'];              // 终态：输单 / 丢单
export const S_OPEN_STAGES = S_STAGES.filter(s => !S_TERMINAL_STAGES.includes(s)); // S1–S6

// 是否「在跟」：先归一（旧英文→S 码），再判非终态。
// 未知值（含脏值 'leads'）→ true（fail-open：宁可多报，不可漏报漏跟进）
export function isOpenStage(v) {
  const code = toStageCode(v);
  if (!code) return true;
  return !S_TERMINAL_STAGES.includes(code);
}
```

判据来源：`S_STAGES / S_LABEL` 定义 S7=输单、S8=丢单，故「在跟 = 非终态」。

### 3.2 判定表（验收依据）

| 输入 stage | 归一 | 是否进 follow | 说明 |
|---|---|---|---|
| `S1`–`S6` | 同 | ✅ | 在跟 |
| `S7` / `S8` | 同 | ❌ | 终态（输单/丢单） |
| `lead` | S1 | ✅ | 旧值兼容 |
| `opportunity` | S2 | ✅ | 旧值兼容 |
| `quoted` | S3 | ✅ | 旧值（此前漏报） |
| `contracted` | S4 | ✅ | 旧值（此前漏报，**会使一条旧断言失效**） |
| `ordered` | S5 | ✅ | 旧值 |
| `paid` | S6 | ✅ | 旧值 |
| `lost` | S7 | ❌ | 旧值 |
| `disqualified` | S8 | ❌ | 旧值 |
| `leads` / 其它脏值 | 原样 | ✅ | fail-open，行内保留原值便于发现脏数据 |
| 缺失 | `undefined` | ✅ | fail-open（与旧实现 `|| 'lead'` 默认计入一致） |

### 3.3 改造点（3 处代码 + 1 处测试）

**① `src/http/workbenchRouter.js`**
- 顶部新增 `import { toStageCode, isOpenStage } from '../sales/stageTaxonomy.js';`
- L183-185 由
  ```js
  const st = p.payload?.stage || 'lead';
  if (st === 'lead' || st === 'opportunity') todos.push({ ..., stage: st, ... });
  ```
  改为
  ```js
  const st = toStageCode(p.payload?.stage) || p.payload?.stage;
  if (isOpenStage(p.payload?.stage)) todos.push({ ..., stage: st, ... });
  ```
  即：`stage` 字段输出**归一化 S 码**（脏值保留原值），判定走 `isOpenStage`。

**② `src/http/routes.js:1616-1617`** 同构改造（同样 import；保持旧入口与新入口行为一致）。

**③ `test/http/workbench-routes.test.js:151-167`**（红线，必须同步改）
- 旧断言 `expect(rows.length).toBe(3); // x-1 contracted 不计入` —— 该前提**已过期**：方案 A 下 `contracted`→S4 属在跟，应计入。
- 改造：固件扩到覆盖判定表关键行（S1 / S4 / S6 / `contracted` / `lost` / `S8`），断言覆盖「旧英文值归一计入」+「S7/S8 排除」，杜绝回归。

**不受影响（已核验）**：`test/http/todo.test.js:43/54` 用 `stage:'lead'` → 归一 S1 仍计入；财务视角不含跟进是 **role 过滤**而非阶段过滤，不受本改动影响。

---

## §4 风险与回滚

| 风险 | 等级 | 缓解 |
|---|---|---|
| 待办条数从 2 → 十余条，用户感知噪声 | 中 | 方案 A 已由用户拍板；`stage` 输出 S 码便于前端分组 |
| 脏值 fail-open 引入垃圾行 | 低 | 保留原值显示，暴露数据问题；后续单独立项清洗 |
| 旧断言变更掩盖真实回归 | 中 | 断言改为显式覆盖 S7/S8 排除，比原断言更强 |
| `routes.js` 旧入口改动波及其它页面 | 低 | 与 workbenchRouter 同构；跑 `test/http/todo*.test.js` + `test/page/my-todo-page.test.js` 复验 |

回滚：3 处改动均为纯函数/纯过滤，git revert 单 commit 即可；无 schema、无数据变更。

---

## §5 验收标准（可验证，禁止口头 done）

1. **单测**：`test/http/workbench-routes.test.js`、`test/http/todo.test.js`、`test/http/todo-finance.test.js`、`test/page/my-todo-page.test.js` 全绿。
2. **只读探针复核**：修后同一统计口径下，follow 命中数由 **2 → 16**（18 条 − S7 1 条 − 脏值外均应计入；`leads` fail-open 计入 → 实际 17，以脚本实测为准）。
3. **真实 E2E**（非单测替代）：起独立实例（`PORT=3100`，避开开发用 3000），alice 登录取 token，`GET /api/my-todo?view=follow` 与 `GET /api/page/todo?role=sales` 两入口均返回 `ok` 且含 XX制造（S4）；断言 `statusCode===200` 且行数 ≥ 10。**改 src 后必须重启实例再测**。
4. **终态反向验证**：S7（B新能源）在 follow 中**不出现**。

---

## §6 实施步骤（批准后 → writing-plans → 执行）

1. `stageTaxonomy.js` 增 `S_TERMINAL_STAGES` / `S_OPEN_STAGES` / `isOpenStage`（纯新增）
2. `workbenchRouter.js` 改造 + `routes.js` 孪生改造
3. 改 `test/http/workbench-routes.test.js` 断言与固件
4. 跑 §5 全部验收项，含 E2E
5. 按功能线单 commit（不 `git add -A`）

---

## §7 不在本次范围（后续独立议题）

| 议题 | 说明 |
|---|---|
| P1 自审自 | `workbenchRouter.js:83` `matchApprover` 缺 `submitter ≠ approver` 硬校验，致 demo 单进提交人本人待办。**另立一轮 brainstorming**。 |
| follow 无 owner 过滤 | 修完后 alice 看到全租户在跟商机，是否加 owner 维度需产品决策。 |
| 其余 `'lead'` 硬编码 | `routes.js:896`、`portal/businessBoard.js:87`、`portal/detailSections.js:46`、`sales/namedAccountBoard.js:20`、`account/insightService.js:159`、`action/seed-actions.js:783/791/838`、`scheduler/timers.js:128` —— 同族技术债，单独立项。 |
| B新能源 stage=S7 疑点 | 库里为终态「输单」，业务上仍在推进（09-16 拿签字、25 台报价）。疑似数据错置，需核对是否应走 reopen。**数据问题，非本过滤器问题**。 |
| 脏值 `leads` | 1 条，建议后续清洗。 |

---

## §8 自查

- [x] 无占位符 / TODO
- [x] 判定表与方案 A 一致，无矛盾
- [x] 范围边界显式声明（§2 / §7）
- [x] 缺陷位置已由源码引用锚定（file:line），非口头推断
- [x] 实测数字已由只读探针核实（非沿用用户初报数字）
- [x] 测试影响已逐文件核验（含"不受影响"的显式说明）
