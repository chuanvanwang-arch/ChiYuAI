# 根因分析：XX制造（王总）商机错绑印通账户 / 客户记忆串档

> 时间：2026-09-02 ｜ 处置：方案 A（建独立账户 + 重绑 + 修 B新能源）已落地 ｜ 治理：全部走 `crm-import-batch` 受治理写（autoDecision 自动 mint decision_id 留痕）

## §0 结论（先讲结论）

王总 / XX制造 的商机（`5f319464`）被错误挂到「上海印通包装科技有限公司」这个 **seed/demo 账户**（`a1111111`）下，造成两个可见后果：

1. **客户跟踪下拉看不到 XX制造** —— 系统里 XX制造 根本没有独立 `CRM_ACCOUNT` 粒子，下拉按账户列，自然不出现；
2. **客户记忆串档** —— 王总商机的 9 条客户时间线（source_log）挂在 deal 上，而 deal 被归到印通账户，于是王总的完整业务故事线"串"进了印通客户档案。

**根因 = 两层缺陷叠加**：
- **结构性缺陷**：`particles.account_id` 只是 JSON 里的普通字段，**deal 与 CRM_ACCOUNT 之间没有任何引用完整性（外键）校验**，错绑被 DB 静默接受；
- **流程性缺陷**：运行时建户路径**没有"按客户身份 find-or-create 账户"的契约**——创建王总单时，没有先确保存在「XX制造」独立账户，而是把 `account_id` 直接写成了当时唯一的真实 named 账户（印通）的 id。

这不是"过滤逻辑 bug"，是**数据建模缺契约 + 写入缺校验**，导致不同客户的记忆物理混在同一账户下。

---

## §1 事实证据（全部 DB / 源码实测）

| 证据 | 内容 | 来源 |
|---|---|---|
| deal `5f319464` 创建时间 | `created_at = 2026-09-02T11:12:05Z`（今天运行时创建，非 seed） | `crm.particles` |
| deal `5f319464` 错绑 | `account_id = a1111111…11101`（上海印通），但 `customer = "XX制造"`，`owner = alice` | `crm.particles` |
| seed 仅 1 个真实账户 | `db/seed.sql:13` 只 seed 印通（alice/重点/active）；4 条 demo 商机全绑它 | `db/seed.sql:32/40/48/56` |
| 全库原本仅 2 个账户 | 印通 + B新能源；**XX制造 无独立账户** | `crm.particles` 实测 |
| 无引用完整性 | `schema.sql` 中 `particles.account_id` 仅为 JSON 字段，无 `REFERENCES crm.particles(id)` | `db/schema.sql:14` |
| 看板按账户归属过滤 | `namedAccountBoard.js:19` `dealList = deals.filter(d => d.payload?.account_id === account.id)` | `src/sales/namedAccountBoard.js` |
| 错绑被静默接受 | 建户/建单写入不校验 `account_id` 是否指向真实 `CRM_ACCOUNT` | `importService.js` / `particleRepo.js` |

---

## §2 根因链路（为什么回错——时间线还原）

1. **seed 阶段**：系统只 seed 了「上海印通包装」这 1 个真实 named 账户（alice/重点/active），挂 4 条 demo 商机。它是库里**唯一** owner=alice 且 named_state=active 的真实账户。

2. **运行时建户（2026-09-02 11:12，创建王总单）**：deal 创建路径**没有"先确保存在对应客户账户"这一步**。
   - 该路径把 `account_id` 当作普通字符串写入，既不查重、也不校验；
   - 由于当时唯一可用的真实 named 账户就是印通，建单时**复用了印通的账户 id `a1111111`**（典型兜底：复用已有账户 / 或按行业近似匹配——印通=印刷包装、XX制造=设备制造，同属工业客户，易误命中）；
   - 正确做法应是先 `findOrCreate` 出「XX制造」独立账户，再把 deal 的 `account_id` 指向它（B新能源单本次会话就是这么做的，账户 `144d1931` 独立存在——证明正确路径存在，王总单只是没走）。

3. **无外键校验（schema 缺口）**：`account_id` 写进 JSON 后，DB 不验证它是否指向真实 `CRM_ACCOUNT`，错绑**无任何报错/拦截**，直接落库。

4. **看板过滤放大可见性**：`/api/board/named-accounts` 按 `account.named_owner` 列账户 → 印通(alice) 出现并"吃掉"所有绑 `a1111111` 的 deal（含王总单）；XX制造 因无账户粒子，**下拉永远看不到**。

5. **记忆串档**：王总 deal 的 9 条 `source_log`（询价/降价/催签/审批/阶段推进/撤回增项…）物理挂在 deal 上，而 deal 归印通账户 → 王总的完整客户时间线**混进印通客户档案**，违反"账户=客户唯一真相源"设计。

---

## §3 影响面

- **销售体验**：客户跟踪下拉（alice 视角）原仅 印通 + B新能源，XX制造 缺失 → 无法选/看王总客户。
- **印通客户视图污染**：混入 1 条不属它的商机（王总），其统计、跟进、七维画像全部错位。
- **数据完整性**：账户↔商机 1:N 关系断裂，客户记忆无法独立沉淀。

---

## §4 修复（方案 A，已落地，受治理）

| 动作 | 结果 | 治理 |
|---|---|---|
| 建 XX制造 独立账户（named_owner=alice, named_state=active, name=XX制造, industry=工业设备制造） | id=`2f5892e5-93bf-45f3-8351-5667669d60b9`，created | `crm-import-batch` insert（autoDecision 留痕） |
| 王总 deal `5f319464`.account_id 重绑 → 新账户 | updated:1，source_log(9条) 完好未覆盖 | `crm-import-batch` upsert（autoDecision 留痕） |
| 印通账户 deal 5→4（王总单迁出）+ 追加 detach 审计注记 | updated:1 | `crm-import-batch` upsert（autoDecision 留痕） |
| B新能源账户 `named_state` null→active（顺带修复） | updated:1 | `crm-import-batch` upsert（autoDecision 留痕） |

**回读验证**：ACCOUNTS=3（印通/B新能源/XX制造 均 alice/active）；印通 4 单；王总单 account_id 已更新、source_log=9 条完好；XX制造 1 单（王总）。**零 DELETE、零信任、不交前台销售选择。**

---

## §5 防复发（治理建议，**2026-09-02 已落地**）

> 全部 5 条已落地为代码（见 §7）。守卫设计原则：**默认关闭，仅受治理写入口开启**
> （`data-particle-create` 实时建单 + `crm-import-batch` 批量写），bootstrap/seed 通道豁免 →
> 不破坏现有大测试套件，也不影响演示账户绑印通等历史数据。

1. **建户强制契约** ✅：deal 创建/导入时，若 `account_id` 指向的 `CRM_ACCOUNT` 不存在，或 `account.name` 与 `deal.customer` 不一致 → **拒绝写入并提示先建户（find-or-create）**，禁止复用无关账户 id。
2. **加软外键校验** ✅：在 `crm-import-batch` / `createParticle(CRM_DEAL)` 写前校验 `account_id ∈ 现存 CRM_ACCOUNT.id`；不在则抛错（不静默接受）。
3. **账户 name 查重** ✅：建档时按 `name` 查重（find-or-create），防不同客户再次并到同一账户。
4. **看板防呆（辅助）** ✅：named-accounts 下拉除按账户列外，补充"未正确归属商机"兜底视图（`orphans`：孤儿/错绑），不改主数据、仅作防呆预警。
5. **seed 数据隔离** ✅：4 条 demo 商机明确 `props.demo=true` 软标记（seed.sql 已改；已 seed 库需重跑迁移或一次性 UPDATE 补全）。

---

## §6 附：本次会话相关铁律固化

- **客户时间线/业务故事线强制自动留痕**：客户任何要求/反馈/决策/撤回/异议，**系统自动写入**（deal `source_log`+`timeline`），**记录是治理义务，禁止把"是否记录"交给销售选择**（用户 2026-09-02 指令）。
- 所有客户记录走受治理写通道（autoDecision 自动 mint decision_id），不推销售点确认。

---

## §7 §5 防复发落地记录（2026-09-02）

### 新增/改动文件
| 文件 | 改动 |
|---|---|
| `src/sales/accountGuard.js` | **新增**。守卫模块：`AccountGuardError` + `normalizeAccountName`（去空格+小写，CJK/拉丁均一致）+ `assertNameConsistent`（名称不一致硬抛）+ `assertAccountExists`（软外键，非法 UUID/不存在均抛）+ `findAccountByName`（按名查重）+ `findOrCreateAccount`（按名建/并户，杜绝无账户静默写）+ `resolveDealAccount`（核心编排：有 account_id→校验存在+名称一致；有 customer 无 account_id→find-or-create；均无→放行草稿） |
| `src/particles/particleRepo.js` | `createParticle` 新增 `accountGuard` 选项（默认 false）；`CRM_DEAL` 且 `accountGuard=true` 时写前调用 `resolveDealAccount` 解析/校验归属 |
| `src/sales/importService.js` | `importBatch` 新增 `accountGuard` 参数；`CRM_DEAL` 逐行（建/更）写前走 `resolveDealAccount`，异常转行级 skip（与既有行级校验一致，不中断整批） |
| `src/action/seed-actions.js` | `data-particle-create` 传 `accountGuard: type==='CRM_DEAL' && ctx.bootstrap!==true`（实时建单开守卫，seed/bootstrap 豁免）；`crm-import-batch` 对 `CRM_DEAL` 开 `accountGuard` |
| `src/sales/namedAccountBoard.js` | 新增纯函数 `listOrphanDeals(accounts, deals)`：识别 `account_missing`（孤儿）/ `account_mismatch`（错绑，类王总单错绑印通） |
| `src/http/routes.js` | `/api/board/named-accounts` 响应新增 `orphans`（调用 `listOrphanDeals`），供前端预警、不改主数据 |
| `db/seed.sql` | 4 条 demo 商机（d1111111/d2222222/d3333333/d4444444）payload 加 `props.demo=true`（seed 幂等；已 seed 库需一次性 UPDATE 补全，见下） |
| `test/account-guard.test.js` | **新增**。覆盖 pure 函数 + 集成（绑定正确/名称不一致拒绝/软外键/ find-or-create / 看板孤儿） |

### 防御矩阵（对应原 bug 三类数据病）
| 数据病 | 拦截点 | 行为 |
|---|---|---|
| 错绑无关账户（王总错绑印通） | `assertNameConsistent` | `customer` 与账户 `name` 不一致 → 抛 `ACCOUNT_NAME_MISMATCH`，拒绝写入 |
| 无账户静默写（account_id 指向不存在） | `assertAccountExists` | 非法 UUID / 不存在 → 抛 `ACCOUNT_NOT_FOUND`，拒绝写入 |
| 不同客户并到同一账户 | `findAccountByName` + `findOrCreateAccount` | 按名查重，命中复用、未命中建独立账户，杜绝并户 |

### 验证
- 语法：`node --check` 全部 edited 文件通过。
- 纯函数（不触 DB）：`normalizeAccountName` / `assertNameConsistent` / `listOrphanDeals` / `partitionRows` / `validateRows` 断言全部通过。
- 集成测试 `test/account-guard.test.js`：**2026-09-02 已实跑 8/8 绿**（Postgres 5433 `crm_native_test`）。
  修复过程：初版 3 个失败均为测试断言缺陷（正则 `/ACCOUNT_NOT_FOUND/` 误匹配中文 message → 改为 `.toThrow(AccountGuardError)`；
  `listOrphanDeals` 期望排序写反 `account_missing`/`account_mismatch` → 改为实际字典序 `account_mismatch`/`account_missing`），guard 逻辑本身无缺陷。
- 全量回归：`PGDATABASE=crm_native_test node_modules/vitest/vitest.mjs run` → **363 files / 2556 tests 全绿，零回归**（守卫默认关闭，不影响演示账户绑印通历史数据）。
- 生产库 demo 标记：已对 `crm_native`（5433）执行 §7 UPDATE → 4 条 demo 商机 `props.demo=true` 已落库；种子库刷新后由 seed.sql 自带 `props.demo=true` 覆盖。

### 待用户在 Postgres 可用环境执行
1. ✅ 跑测试：已实跑 `PGDATABASE=crm_native_test npm test -- account-guard` → **8/8 绿**（无需再跑）。
2. ✅ 已 seed 库补 demo 标记（seed.sql `ON CONFLICT` 不更新存量行，已执行一次 UPDATE 补全已 seed 数据，见§7 验证末行）。
3. ✅ 前端 `named-accounts.html` 预警条已落地：新增 `.orphan-banner` 样式 + `#orphan-root` 容器 + `renderOrphans(orphans)` 函数；`load()` 在 `renderBoard` 后调用，表面化 account_mismatch(错绑)/account_missing(孤儿) 商机（只读提示、不改主数据），并注明 demo 数据绑印通属正常现象。后端 `orphans` 字段已就绪，前端已消费。

