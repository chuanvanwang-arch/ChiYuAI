# 全链集成 Q1「出口接电」验收报告

> **版本** v1.0 ｜ **日期** 2026-09-16 ｜ **结论**：代码侧 **PASS**（全部单测 + 真库 e2e 绿）；**但生产口径判据① 不成立，须先决**
> **设计来源**：`docs/2026-09-16-full-chain-integration-design.md` v1.1 §3.1 / §3.1.1 / §3.2 / §3.3 / §5
> **实施计划**：`docs/superpowers/plans/2026-09-16-full-chain-q1-export-dispatch.md`

---

## 0. 一句话结论

**「水泵」已造好并验证可抽水，但全库（含平台租户）没有任何租户配置过 `signal-delivery` ⇒ 泵上线后在本库 419 条 open signal 上将以「零投递」空转。**

因此：**面板四条 `delivery_silent` 红框会消失，但不是因为链路通了，而是因为「没有任何渠道被开启」**——这是「判据不再携带假前提」的正确结果，**不可对外叙述为「提醒已送达」**。

---

## 1. 交付与测试证据（全部为实跑输出）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Q1-2 路由 | `npx vitest run test/signal/route.test.js` | **16 passed**（计划预期 15，+1 为 P-2 新增用例） |
| Q1-1 编排器 | `npx vitest run test/signal/dispatcher.test.js` | **13 passed**（计划预期 11，+2 为 P-5 新增用例） |
| Q1-3 定时器 | `npx vitest run test/timers.test.js` | **5 passed**（`EXPECTED_TIMERS` 16 → 17） |
| Q1-4 判据修正 | `npx vitest run test/monitor/signalMetrics.test.js` | **8 passed**（既有 5 + 新增 3） |
| Q1-4 观测链回归 | `signalObservabilityScan` / `http/signalMetrics` | **4 passed**（修正后需补配置前置，见 §3） |
| Q1-5 真库 e2e | `npx vitest run test/signal/dispatch-e2e.test.js` | **6 passed**（判据① + 幂等 + N2 + N8 + N9 + P-5） |
| 广域回归 | `npx vitest run test/signal test/monitor test/timers.test.js` | **156 passed / 3 failed**（3 处失败与本改动无关，见 §4） |

### Q1-5 判据①（真库 `crm_native_test`）

`pumpOnce` 后 `crm.signal_delivery` 出现 `status='sent'` 且 `delivered_at` 非空 → **成立**（受控条件下）。

---

## 2. 受控验收探针（真库 `crm_native`，一次性租户，跑完自清）

> 探针脚本为临时文件，**已删除**；以下为原始输出摘录。仅写入 `q1-acc-<uuid>` 一次性租户，未触碰任何既有行。

```
① BEFORE 快照
   signal-delivery / signal-dispatch 配置行 = 0
   crm.signal_delivery 总行数 = 0
   status='open' 的 signal 按租户：
       acme-demo -> 83   system -> 82   acme-chem -> 79
       acme-consult2 -> 77   acme-training -> 77
       smoke-sync -> 6   smoke-followup -> 6   smoke -> 5   smoke-writeback -> 4
   （合计 419 条 open signal，signal_delivery 恒 0 行）

② 受控验证（探针租户，配置仅 inbox=on）
   pumpOnce 返回 = {"signals":1,"sent":1,"failed":0,"skipped":0,"idle":{}}   (25 ms)
   crm.signal_delivery（探针租户）行数 = 1
       channel=inbox status=sent delivered_at_present=true last_error=null
   二次泵（幂等）= {"signals":1,"sent":0,"failed":0,"skipped":0,"idle":{}}；投递行总数仍为 1
   未配置租户（P-5 空转归因）= {"signals":1,"sent":0,"failed":0,"skipped":0,
                              "idle":{"delivery_config_missing":1}}

③ 计划 §Q1-5 Step 3 取证查询
   [判据① 出口] crm.signal_delivery 24h 聚合：
       q1-acc-<uuid> | inbox | sent | 1

④ 清理与零残留复核
   探针租户残留 = {"sig":0,"dl":0,"cfg":0,"cfg_anywhere":0}（应全为 0）→ 全 0
   crm_native 全库 signal_delivery 总行数 = 0（清理后）
   AFTER 快照与 BEFORE 逐项等值
   探针结果：PASS
```

**结论**：链路本身（signal → route 决策 → registry.deliver → `signal_delivery` 落流水）在真实库上**可跑通、幂等、可归因**；缺的只是**配置**。

---

## 3. Q1-4 对既有测试的连带影响（已处理，且**未削弱断言**）

`detectNegativePredicates` 改为配置驱动后，**两个既有测试文件编码的正是被消除的假前提**（"无配置也按四渠道全开报警"）。处理方式：**只补前置条件（为测试租户写入 `signal-delivery` 配置），断言一字未改**。

| 文件 | 原断言 | 处理 |
| --- | --- | --- |
| `test/http/signalMetrics.test.js` | webhook 无投递 → silent；email 有投递 → 非 silent | beforeAll 声明四渠道均 `on`；断言不变 |
| `test/monitor/signalObservabilityScan.test.js` | 有信号零投递 → `delivery_silent` 触发报警 | beforeAll 声明四渠道均 `on`；断言不变 |

> **为何这不是"改测试凑绿"**：修正前这两个用例之所以能过，靠的是判据里的硬编码默认值；配置驱动后，同一断言只有在"渠道确实开启"这一正确前提下才有意义。断言强度未降，前提被补全。
>
> **同时发现第三个生产调用点**：`src/http/signalMetricsRouter.js:17` 调用时同样不传 `enabledChannels`（计划只盘点了 2 个测试调用点）。该路径现在读取真实配置，面板口径已与判据一致。

---

## 4. 广域回归中的 3 处失败 —— 与本改动无关（附证）

| 失败 | 归属模块 | 判定依据 |
| --- | --- | --- |
| `test/monitor/agent-summary.test.js > getAgentSummary 无数据时返回空聚合` | `src/monitor/monitorStore.js`（**本会话未改动**） | 断言 `getAgentSummary({days:0}).totals.runs === 0`，实得 6 → 纯依赖共享库 `crm.monitor_event` 残留行数（实测 25 行） |
| `test/monitor.test.js > getDecisionList T13 按租户过滤` | `src/monitor/monitorStore.js`（未改） | 依赖 `crm.decision` 共享库残留（实测 1 行） |
| `test/monitor.test.js > 监控持久化订阅` | 同上（未改） | 同上 |

补充证据：① 本改动的**写入集**仅为 `crm.signal_delivery`（`grep monitor_event` 在改动文件中零命中）；② 两次连续运行的**失败集合不同**（首跑为 `getAgentSummary`+`getDecisionHealth`，次跑为 `getDecisionList`+`agent-summary`+`monitoring persistence`）→ 共享库干扰特征；③ 上述测试文件均未在本会话被修改（`git status` 为空）。

> **未做**：未与 pristine HEAD 做逐字节对照复跑（工作树有并行会话，`git stash` 会危及他人改动）。故本节结论限于「证据指向与本改动无关」，**不主张已证明为先存失败**。

---

## 5. 执行期修正清单（计划文档未覆盖，已回写计划）

| 编号 | 缺陷 | 证据 | 处置 |
| --- | --- | --- | --- |
| **P-1** | 计划原文 `import { readConfig, query } from '../config/configStore.js'` —— `configStore.js` **不导出 `query`**，ESM 链接期即失败 | `grep '^export' src/config/configStore.js` 仅 `readConfig`/`writeConfig` | 改为 `query` 从 `../db.js` 引入作默认值（既修链接错误，又使限速闸在未注入时**真实生效**；原写法默认 `undefined` = 限速静默失效） |
| **P-2** | `loadPolicy` 用 `.catch(() => null)` 把「DB 读取失败」压成「配置缺失」 | 与 Q1-4 自身确立的 read-failed ≠ missing 原则自相矛盾 | 拆为两个 reason：`delivery_config_read_failed` / `delivery_config_missing`；+1 用例 |
| **P-3** | 工厂名 `createSignalRouter` 与既有 `src/signal/router.js` **同名导出**，文件路径仅差一字符 | `grep createSignalRouter src/` 已有 4 处引用 | 更名 `createDeliveryRouter` |
| **P-4** | 计划原文顶部 import 了 `createDeliveryRegistry` / `createDeliveryStore` 但最终代码**均未使用** | 代码审查 | 删除。未使用 import 在 ESM 下仍执行被引模块体（连带拉入 4 个 provider），属噪声与隐式耦合 |
| **P-5** | 泵的空转**完全不可见**：`sent/failed/skipped` 全 0 时不 emit 任何 trace | 真实库实测：配置 0 行 → 首日每 5 分钟空转且零日志 | `pumpOnce`/`pumpAllTenants` 回带 `idle: {reason → 条数}`；定时器 emit `signal-dispatch-idle`；+2 用例 |
| **P-6** | 计划 e2e 导入 `'../src/db.js'`，而文件位于 `test/signal/`（应深一级） | 对照既有 `test/signal/delivery.test.js` 用 `'../../src/'` | 改为 `'../../src/db.js'` |
| 附 | 计划中两处预期值失准：`test/signal/delivery.test.js` 为 **5** 例（计划写 7）；Step 6 路径 `test/signalObservabilityScan.test.js` **不存在**（实际在 `test/monitor/`） | 实跑 | 计划 Step 6 因路径不存在而**只跑了 1 个文件**，这正是"声称回归通过"的盲点；已按正确路径复跑并暴露 2 处真实回归 |

---

## 6. 残留风险与未做事项（如实登记）

| 编号 | 事项 | 影响 | 建议 |
| --- | --- | --- | --- |
| **R-A（阻塞级）** | **零租户配置 `signal-delivery`**：`crm_native` 中 0 行（config_store 1018 行内），`signal_delivery` 恒 0 行 | Q1 上线后生产口径**判据①仍不成立**；面板转绿属"未开启渠道"而非"已送达" | 需一次**显式决策**（配置写入属第 0 闸管辖）确定：哪些租户、哪些渠道、收件人、静默时段。**模型不得自行写业务配置。** |
| **R-B** | 泵对**每条 signal** 各读一次 `signal-delivery` 配置 → 本库 419 次/周期（每 5 分钟） | 纯粹浪费；且引入无关的读放大 | 后续把 policy 提升到 `pumpOnce` 租户级缓存一次（改动 `route.resolve` 调用形状，不在本批） |
| **R-C** | `createSignalObservabilitySweep` 的租户选择器仍排除 `system`（`src/monitor/signalMetrics.js:139`） | D1 之后**平台信号会被投递但永不被观测**（投递失败在面板不可见）——D1 引入的新不对称 | 建议纳入 Q1 后续增量：与 D1 对齐（同时须评估对既有巡检测试的影响） |
| **R-D** | route 解析出的 `recipient` **未透传**给 provider（`deliveryRegistry.deliver` 签名不含 recipient；provider 亦不读） | 目前 recipient 仅作"能否投递"的闸门；`email`/`im`/`webhook` 的真实收件人落地仍缺 | 属 S1 契约扩展，留待后续批次；**不阻塞**判据①（inbox 路径无需收件人） |
| **R-E** | Q1-4 的「配置缺失」只在 `emit('trace')` 可见，**面板无任何提示** | 面板"无告警"与"配置齐全且链路通"不可区分——Q1-4 消除了一层假绿，又留下一层更细的 | 建议面板增设"投递未配置"状态位（设计 §3.3 未定义，需设计增补） |

---

## 7. 提交命令（AI 无提交凭证，请在本仓库执行）

> **严禁 `git add -A`**（工作树有并行会话：40 M / 46 D / 41 ??）。以下 11 个文件**逐一核对归属后**为本会话改动。

```powershell
git add src/signal/route.js src/signal/dispatcher.js `
        src/scheduler/timers.js src/monitor/signalMetrics.js `
        test/signal/route.test.js test/signal/dispatcher.test.js test/signal/dispatch-e2e.test.js `
        test/timers.test.js test/monitor/signalMetrics.test.js test/monitor/signalObservabilityScan.test.js `
        test/http/signalMetrics.test.js
git commit -m "feat(q1): 出口接电——signal/route+dispatcher 投递编排层+定时器17(EXPECTED_TIMERS 16->17)，修正 signalMetrics 判据假前提(config驱动)，含D1泵含system/D2时间窗/P-1..P-6执行期修正；单测+真库e2e全绿"
```

**单独回写设计/计划的提交**（计划文档的执行期修正记录）：

```powershell
git add docs/superpowers/plans/2026-09-16-full-chain-q1-export-dispatch.md docs/2026-09-16-q1-export-acceptance.md
git commit -m "docs(q1): 回写执行期修正P-1..P-6+验收报告(含R-A阻塞项:零租户配置signal-delivery致生产判据①不成立)"
```

---

**— 报告结束 —**
