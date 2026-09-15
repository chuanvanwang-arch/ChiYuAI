# 线索导入 · MCP 端测试场景集（场景 1–18）

> **性质**：**不改任何代码**，只形成测试问题。待「线索导入」相关任务开发完成后，在 **MCP 通道**逐条执行验证。
> **输入**：《数博会47张名片签4单，80张名片0转化？销冠的5步法我全拆了》（林姑娘快跑 2026-08-25，DSM 体系：⭐商机/△目标/○潜力/✕凑热闹 + BANTCC + 展后 7 天清单）
> **被测工具**：`crm-import-batch`（`src/action/seed-actions.js:1253`）、`data-particle-read`、`crm_login` 等 MCP 面
> **日期**：2026-09-11

---

## §0 勘误与本轮代码事实（先纠上一份文档的错）

上一份 `docs/2026-09-11-lead-import-test-scenarios.md` 判「G1 无批量导入通道」——**结论错误，特此更正**：批量导入通道**已存在且已接第 0 闸**。本轮源码级核实事实如下：

| 事实 | 位置 | 含义 |
|---|---|---|
| `crm-import-batch` 已注册：`kind:write, confirm:'critical', autoDecision:true, decisionScenario:'IMPORT_BATCH', agentTool:true, force:false` | `src/action/seed-actions.js:1253-1257` | 已在 MCP 工具面暴露，两阶段确认、过第 0 闸 |
| 入参仅 4 个：`particle_type / rows / mode(insert\|upsert) / required` | `seed-actions.js:1258-1264` | **无去重键参数、无分类参数** |
| upsert 语义 = **按 `rows[].id` 分派**（有 id→update，无 id→create） | `src/sales/importService.js:10-17` | 幂等**仅对带 id 的行成立** |
| `createParticle` 是**纯 INSERT**（无 upsert / 无唯一键冲突处理） | `src/particles/particleRepo.js:106-113` | **无 id 的名片行重复导入 → 必然产生重复粒子** |
| 行级校验失败只 `skipped++` 并继续（不中断整批） | `importService.js:40-46` | 批量容错已具备 |
| `CRM_DEAL` 导入自动开账户归属守护 `accountGuard` | `importService.js:48-58, 69-79` | 商机导入有账户防错绑 |
| `CRM_ACCOUNT` 缺 `named_owner` 直接抛错（禁无主） | `particleRepo.js:70-74` | 名片导入**必须带归属人**，否则整行失败 |
| 完成事件 `import-batch-done` 已 emit | `importService.js:87` | 下游记忆/事件可订阅 |
| `force` 是协议级参数（高危写确认位），须显式声明否则被 zod strip | `src/mcp/tools.js:72-80` | 注释把 `crm-import-batch` 列为需 force 的高危写，但其定义 `force:false` → **注释与实现矛盾，须实测（场景 4）** |

> **三个 P0 测试问题**（文章场景与实现的直接冲突，优先测）：
> 1. **去重缺失**（场景 6、7）：300 张名片 → 80 家公司，但 `crm-import-batch` 无去重键，同公司 3 张名片会建 3 个 `CRM_ACCOUNT`。
> 2. **幂等有条件**（场景 8、9）：无 `id` 行重复导入必然翻倍；文章「分批 10-20 张传」若重试即重复。
> 3. **分类无载体**（场景 16）：⭐△○✕ 不在 schema，只能塞进自由 payload；是否被元模型自适应登记、能否被下游消费未知。

---

## §1 MCP 端统一前置（所有场景共用）

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const unpack = (r) => { const t = r?.content?.[0]?.text; if (!t) return r;
  try { return JSON.parse(t); } catch { return { ok: false, raw: String(t).slice(0, 300) }; } };

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: process.env.PGDATABASE },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-lead-import', version: '1.0.0' });
await client.connect(transport);

const lr = unpack(await client.callTool({
  name: 'crm_login',
  arguments: { username: process.env.E2E_USER || 'alice', password: process.env.E2E_PASS || 'secret123' },
}));
const auth = { api_token: lr.token };   // api_token 必须显式传（tools.js:64 已声明，否则被 strip）
```

> **通用判据**：每个场景的通过判据一律是 **`ok === true`**（记忆铁律：未登录时 `gate=auth_required` 也是合法 JSON，只判字段会假绿）。
> **运行注意**：改了 `src/` 后必须重启 MCP 实例（node 无 `--watch`），否则拿到旧进程结果；PG 连 `localhost`/`::1`，勿写 `127.0.0.1`。

---

## A 组 · 通道与闸门（场景 1–5）

### 场景 1：`crm-import-batch` 是否真的暴露在 MCP 工具面？

- **测试问题**：`agentTool:true` 是否足以让该动作出现在 `listTools()`？还是被 `data-*` 屏蔽规则或命名空间规则挡住？
- **调用**：`client.listTools()`，检查 `names.includes('crm-import-batch')`。
- **断言**：① 工具名存在；② 其 `inputSchema.properties` 含 `confirm_token / decision_id / api_token / force` 四个协议字段（缺 `force` 即 `tools.js` 声明遗漏）；③ 标注为两阶段写。
- **失败含义**：AI 销售助手在 MCP 端根本调不到导入能力，文章「AI 名片整理 → 同步 CRM」链路断。

### 场景 2：未登录 / 无效 token 导入是否被拦且不落库？

- **测试问题**：无 `api_token` 时是 `gate=auth_required`，还是**静默落库**（最危险的假绿）？
- **调用**：`callTool({ name:'crm-import-batch', arguments:{ particle_type:'CRM_ACCOUNT', rows:[...], mode:'insert' } })`（不带 `api_token`）。
- **断言**：① 返回 `ok===false` 或 `gate==='auth_required'`（合法 JSON，非抛错）；② **落库数 = 0**（导入前后 `COUNT` 比对，硬判据）；③ 不得出现「部分写入」。

### 场景 3：两阶段确认是否真实生效（phase1 不执行）？

- **测试问题**：`confirm:'critical'` 在 MCP 端是否真要求二次确认？phase1 是否会**偷偷写库**？
- **调用**：phase1 `callTool({ name:'crm-import-batch', arguments:{...args, ...auth} })` → 取 `confirm_token`；phase2 带 `confirm_token` 再调。
- **断言**：① phase1 **返回 `confirm_token` 且库中行数不变**；② phase2 带 token 后 `created` 数 = rows 数；③ phase1 的 token 不可复用第三次（重放即拒）。

### 场景 4：`force` 位到底是必需还是多余？（注释与实现矛盾点）

- **测试问题**：`tools.js:72` 注释把 `crm-import-batch` 列为 `def.force===true` 的高危写（需 `force:true`），但 `seed-actions.js:1256` 定义 `force:false`。MCP 端实际行为是哪个？
- **调用**：A/B 两次：A 不带 `force`；B 带 `force:true`。
- **断言**：① 两者行为**可解释且一致**（要么都拒、要么都过）；② 若 A 被拒且报「需 force=true」→ 高危写经 MCP **永久不可用**（与 `api_token` 同款 strip 陷阱第三次），判 P0 缺陷；③ 若 A 直接通过 → 说明该动作实际非高危写，`tools.js` 注释失真，应修注释而非加 force。

### 场景 5：第 0 闸是否留痕（decision_id 落两处）？

- **测试问题**：`autoDecision:true` + `decisionScenario:'IMPORT_BATCH'` 是否真 mint 决策？还是「声明未兑现」的假绿（本项目历史高发问题）？
- **调用**：执行导入后，查 `crm.decision`（scenario=`IMPORT_BATCH`）与 `particles.decision_id` 列。
- **断言**：① `crm.decision` 新增 ≥1 行且 `scenario_id='IMPORT_BATCH'`；② 新建粒子 `decision_id` 列**非空**（`particleRepo.js:109-113` 透传）；③ 该 decision 可被 `crm-decision-trace` 追溯。

---

## B 组 · 幂等与去重（场景 6–9）★ 文章核心冲突

### 场景 6：同一公司 3 张名片 → 建几个客户？（去重缺失验证）

- **测试问题**：文章「300 张名片 = 80 家公司」，但导入无去重键。同一公司 3 人（同域名、不同联系人）导入后是 1 个 `CRM_ACCOUNT` 还是 3 个？
- **调用**：`rows=[{name:'M涂料科技',contact:'苏研发',email:'su@m.com'},{name:'M涂料科技',contact:'吕生产',email:'lv@m.com'},{name:'M涂料科技',contact:'郑采购',email:'zheng@m.com'}]`，`particle_type:'CRM_ACCOUNT'`。
- **断言**：① 记录实际创建数（**预期 3**，因无去重）；② 若判「应合并为 1」→ 则需在导入层或 `duplicateCriteria` 补去重，这是**待开发任务**而非当前缺陷；③ **无论如何**：同域名应生成 `auto_weak` 关联边（`src/ontology/hooks.js:65`），验证边是否建立。

### 场景 7：重复导入同一批名片是否翻倍？

- **测试问题**：文章「分批 10-20 张传」+ 网络重试，同一批导入两次 → 库里是 300 还是 600？
- **调用**：同一 `rows`（无 id）连续导入 2 次，`mode:'upsert'`。
- **断言**：① 第二次 `created` 数（**预期 = 首批行数，即翻倍**）；② 若要求幂等 → 必须让 rows 携带确定性 `id` 或业务唯一键；③ 明确记录当前幂等边界（**仅带 id 时幂等**，见 `importService.js:14-16`）。

### 场景 8：带 id 的 upsert 是否真更新不新增？

- **测试问题**：`mode:'upsert'` 且 rows 带 `id` 时，是否 `updated` 递增、`created=0`、总数不变？
- **调用**：先导入建 3 条 → 取回 id → 再以 `mode:'upsert'` + 修改字段导入。
- **断言**：① `created===0` 且 `updated===3`；② 总数不变；③ **未传字段原样保留**（字段级并入、禁删，`data-particle-update` 同款语义）。

### 场景 9：并发两路导入同一批 → 是否产生重复或死锁？

- **测试问题**：两个 MCP 会话并发导入同批无 id 名片，是否重复建、是否报错、是否互相阻塞？
- **调用**：两个 `client` 并发 `callTool` 同一 rows。
- **断言**：① 无 500/死锁；② 记录重复条数（**预期 = 2 倍**，与场景 7 同源）；③ 两侧的 `decision_id` 各自独立可追溯。

---

## C 组 · 行级容错与数据保真（场景 10–12）

### 场景 10：缺必填行是否只跳过该行、不炸整批？

- **测试问题**：文章「OCR 准确率 90%」→ 总有残缺行。一行缺 `named_owner` 是否导致整批 300 条全废？
- **调用**：rows 中第 2 条故意缺 `named_owner`（`CRM_ACCOUNT` 禁无主、`particleRepo.js:70-74` 抛错），其余正常。
- **断言**：① `skipped===1` 且 `created===N-1`；② `errors[]` 含明确原因（行号 + 字段名）；③ 其余行**正常落库**（不中断整批）。

### 场景 11：手机号/邮箱等易损字段是否保真？

- **测试问题**：名片 OCR 后的电话（前导零、`+86`、分机）、中文公司名、邮箱大小写，导入后是否被改写/截断？
- **调用**：rows 含 `phone:'021-61234567转802'`、`email:'Su@M.com'`、`name:'M涂料科技（上海）有限公司'`。
- **断言**：① `data-particle-read` 读回与传入**逐字一致**；② 邮箱不被强制小写化（或明确其归一化规则）；③ 中文与全角字符不乱码。

### 场景 12：未知粒子类型 / 脏类型是否被拒？

- **测试问题**：`particle_type:'CRM_LEAD'`（若未注册）或拼错类型 → 是拒绝还是静默建成脏数据？
- **调用**：`particle_type:'CRM_LEAD'` 与 `'crm_account'`（小写）各一次。
- **断言**：① 返回 `ok===false` 且错误信息含「未知粒子类型」（`particleRepo.js:61`）；② 库中**零新增**；③ 不得因 `resolvePrototype` 兜底而建成类型错误的粒子。

---

## D 组 · 隔离与权限（场景 13–15）

### 场景 13：跨租户导入是否隔离？

- **测试问题**：alice（`system` 租户）导入的 300 条，另一租户能否读到/改到？跨租户 id 更新是否被拒？
- **调用**：alice 导入 → 换另一租户 token 用 `data-particle-read` 读、`crm-import-batch`（upsert + 该 id）改。
- **断言**：① 他租户**读不到**（结果不含该记录）；② 跨租户更新被拒且不生效；③ `system` 租户的写保护（若有）按既有红线 400。

### 场景 14：未开通 `core_crm` 套餐的租户是否被拦？

- **测试问题**：`requiresEntitlement:['core_crm']` 在 MCP 端是否真拦？（三层套餐闸门之一）
- **调用**：用一个未开通 `core_crm` 的租户 token 调导入。
- **断言**：① 返回 entitlement 拒绝（非 500）；② **零落库**；③ 错误信息可读（能指引管理员去开通）。

### 场景 15：导入商机（`CRM_DEAL`）账户归属守护是否生效？

- **测试问题**：文章「⭐ 商机客户 → 建项跟进」。导入 `CRM_DEAL` 时账户名与库中不一致/不存在，是自动 find-or-create、错绑无关账户、还是拒绝？
- **调用**：`particle_type:'CRM_DEAL'`，rows 含 `customer:'M涂料科技'`（库中无此客户）与另一条 `customer:''`（空）。
- **断言**：① 无客户 → **find-or-create** 出正确归属（`importService.js:50-52`）；② 名称不一致时**不错绑无关账户**；③ 守护失败的行记 `errors` 并 `skipped`，不静默写脏归属。

---

## E 组 · 业务语义闭环（场景 16–18）

### 场景 16：⭐△○✕ 分类能否写入并被下游识别？

- **测试问题**：文章四分类是核心业务语言，但 `crm-import-batch` schema 无分类参数。把 `lead_tier:'⭐'|'△'|'○'|'✕'` 塞进 rows 后：能否落库？能否被元模型登记？能否被 `crm-funnel-classify` / 看板消费？
- **调用**：rows 带 `lead_tier`、`bantcc:{N,T,A}`、`next_action`、`next_action_date` 导入 `CRM_ACCOUNT`。
- **断言**：① 字段**落库**（自由键不被 strip）；② 元数据自适应登记不阻断主写（`particleRepo.js:118+` fail-open）；③ 用 `data-particle-read` 可按 `lead_tier` 过滤回读；④ 记录下游是否消费（**预期当前不消费**，属待开发接缝）。

### 场景 17：仅采集 N/T/A 的线索，过 BANT 闸是否被误杀？

- **测试问题**：展会现场只问到需求/时间/决策三条（B/M/C 未知），六维缺三。导入后走 `crm-funnel-classify` / 阶段推进时，是否被 `bantcc.pass=0.6` 判为不达标而**误杀**（本项目最典型的假绿/误杀点）？
- **调用**：导入一条仅 `{N:0.9,T:0.8,A:0.7}` 的线索 → 调 `crm-funnel-classify` 或 `method-stage-progression` 相关 MCP 工具。
- **断言**：① 判定结果须能区分「**低分**」与「**未知待补**」两种语义；② 仅因字段未采集而判不达标 → 判 **P0 缺陷**（应进补全队列而非淘汰）；③ 「✕ 凑热闹」只能是**标记**，不得物理删除（禁 DELETE 红线）。

### 场景 18：导入事件是否驱动下游（记忆/监控闭环）？

- **测试问题**：`import-batch-done` 事件 emit 后，是否有订阅者？导入的线索能否进入线索发现引擎的候选池，被 `lead-fit` 重评分、被 C3 `monitorAccount` 持续监控？
- **调用**：导入后查事件/记忆表；待 discovery 引擎完成后调 `discovery-run`（或对应 MCP 工具）观察是否覆盖已导入线索。
- **断言**：① `import-batch-done` 可被订阅（或有明确「暂无订阅者」结论）；② 导入线索**不被发现引擎重复建**（去重接缝）；③ 后续补字段能触发重评分且**历史值不被覆盖**（append 语义）。

---

## §2 执行顺序与优先级

| 优先级 | 场景 | 理由 |
|---|---|---|
| **P0** | 6、7、9（去重/幂等） | 与文章「300 名片=80 家公司」直接冲突，数据污染后果最重 |
| **P0** | 17（BANT 误杀） | 假绿/误杀高发点，会静默淘汰有效线索 |
| **P0** | 2、5（未登录不落库 / 第 0 闸留痕） | 零信任红线，假绿后果不可逆 |
| **P1** | 1、3、4（通道/两阶段/force 矛盾） | 决定导入能力在 MCP 端是否可用 |
| **P1** | 10、11、15（容错/保真/账户归属） | 批量导入的日常正确性 |
| **P1** | 13、14（隔离/套餐） | 多租户红线 |
| **P2** | 8、12、16、18 | 幂等有 id 路径、类型校验、分类载体、事件闭环 |

**建议执行方式**：照 `scripts/e2e-particle-update-mcp.mjs` 的范式新建 `scripts/e2e-lead-import-mcp.mjs`，把 18 个场景固化为 `check()` 断言，一次跑完输出 ✅/❌ 清单；每场景独立 try/catch，单场景失败不阻断后续。

---

## §3 写后自查

| 检查项 | 结论 |
|---|---|
| 未改系统 | ✅ 本文档零代码改动，仅形成测试问题 |
| 事实锚点真实 | ✅ 全部经本次源码核实（`seed-actions.js:1253-1264`、`importService.js:10-17,40-58,87`、`particleRepo.js:61,70-74,106-113`、`tools.js:64,72-80`、`hooks.js:65`） |
| 已勘误 | ✅ 上一份文档「无批量导入通道」结论错误，本文 §0 明确更正 |
| 无占位符/臆测 | ✅ 未实现的接缝（场景 16 下游消费、18 discovery 接缝）均标注「预期当前不消费/待开发」 |
| 判据 fail-closed | ✅ 全部以 `ok===true` 或落库行数比对为硬判据，禁用「字段非空」类恒真断言 |
