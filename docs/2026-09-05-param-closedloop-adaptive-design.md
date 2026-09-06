# 22 项参数「每夜体检 → 处方 → ADMIN 待办 → my-todo 批准」全面闭环设计

> 设计日期：2026-09-05 · 状态：**已批准并全部落地（P0/P1/P2 完成 2026-09-05）**
> 上游：`docs/2026-09-05-param-closedloop-coverage-audit.md`（32 项配置 / 22 项算法参数全景 + 五大断裂点）
> 方案：**A 全面版**（用户已选）——22 项参数全量体检 + 统一巡检器 + my-todo 参数调优视角 + 处方引擎接线
> 铁律：设计先行（本草案经批准后才进入 writing-plans）；写操作必经决策第 0 闸（produceDecision 锚定）；禁 DELETE；HITL。

---

## §0 目标与成功标准

**目标**：让后台所有算法/参数配置都纳入「**每日夜间 02:00 智能体运行 → 参数体检报告 → 明确调整建议（处方）→ 生成 ADMIN/tan_admin 待办 → 在 /my-todo.html「我的审批」中批准生效**」的闭环。

**成功标准（验收）**：
1. 每夜自动跑批产出**参数体检报告**（独立段落，覆盖全部 22 项算法参数），且每项有「当前值 / 健康度 / 建议（或无建议原因）/ 依据样本」。
2. 对判定为「应调整」的参数生成 **PENDING 处方**入 `calibration_patch`（assignee=ADMIN / tan_admin），去重幂等，绝不自动 apply。
3. 处方**可在 `/my-todo.html` 新「参数调优」视角列出**，批准/驳回/回滚走既有 `approvePatch/rejectPatch/rollbackPatch`（第 0 闸 + 事务原子），零新增写通道。
4. 处方前经**定量护栏**（`prescribe()` 接线，max_step / min_step / floor / ceiling / sensitivity），LLM 不可自由定步长。
5. 一键修复既有断裂点：`retro.js:24` 键名错配（`decision-retro` → `retro-config`）。
6. 全程无 DELETE、无自动写 config_store（红线）、处方审批闭环全在既有写闸内完成。

---

## §1 现状断裂点（承接审计）

| # | 断裂点 | 代码锚点 | 本设计修复归属 |
|---|---|---|---|
| 1 | 夜批只对 `knob==='config_store'` 推待办，LLM 自由输出 knob 无约束 → 实测 `calibration_patch` 0 行 | `retro.js:331` | §2.1 参数巡检器（确定性产出，不依赖 LLM knob） |
| 2 | `/api/admin/todos` 零前端消费；`/my-todo.html` 五视角无参数处方 | `calibrationRouter.js:282`；`workbenchRouter.js:23-29` | §2.4 my-todo 增「参数调优」视角 |
| 3 | `prescribe()` / `findKnobSpec()` 全仓零 import；`retro-knob-map` 无代码读、库中无键 | `prescription.js`；`db/schema.sql` 无种子 | §2.3 定量护栏接线 + 播种 `retro-knob-map` |
| 4 | 报告只覆盖「决策质量」5 指标 + 7 根因类，与 22 项参数零交集 | `retro.js:131-149` | §2.2 报告新增「参数体检」段落 |
| 5 | `retro.js:24` 读 `decision-retro`，库实为 `retro-config` → 超时配置恒走兜底 | `retro.js:24` | §2.6 键名修正（读 `retro-config`） |

---

## §2 功能设计（A 全面版）

### §2.1 参数巡检器 `src/calibration/paramInspector.js`（新）

**定位**：确定性、无 LLM 的「22 项参数每夜体检」引擎。纯函数式判据 + 采样 SQL，产出统一结构的「体检条目」。

**对外契约**：
```js
inspectAllParams({ tenantId='system', windowDays=30, now=new Date(), query=defaultQuery })
→ { ran_at, inspected: 22, items: [{ key, group, param, current, health, verdict, suggested, evidence, sample, risk }], patches: [...] }
```
- `health`: `'healthy' | 'drift' | 'degraded' | 'unknown'`
- `verdict`: `'keep' | 'adjust' | 'review'`
- 采样 SQL：近窗 `crm.decision`（按 scenario 聚合）+ `crm.particles`（行为/周转）+ `crm.calibration_patch`（已应用历史，冷却护栏）。

**判据表（22 项，见 §3）**：每项 = `{ key, group, param, valueOf(cur), judge(items, sample), suggest(cur, sample), floor, ceiling, risk }`。判据只读配置当前值 + 采样指标，产出 `suggested` 目标值。**样本不足（n < 20）→ verdict='review' 不出建议**（对齐 R5/R6 守卫）。

**冷却护栏**：同键 `calibration_patch.status='APPLIED'` 且 `resolved_at` 距今 < `config_store['param-cooldown'].days`（默认 30）→ 跳过（不出新处方，防抖）。

**Fail-open 铁律**：单键判据异常 → `emit('trace')` + 该键 `health='unknown'`，不阻断其余键；巡检器整体失败 → emit + recordFailure，不阻断夜批主链。

### §2.2 夜批报告新增「参数体检」段落

`retro.js` 在「LLM 决策复盘」后追加独立 pass（**同 P2 路由实验模式：互不传染、各自 catch**）：

```js
export const runParamInspection = async ({ tenantId='system', dryRun=false } = {}) => {
  const items = await inspectAllParams({ tenantId });        // 确定性，无 LLM
  const patches = dryRun ? [] : await savePatchesFromItems(items); // 见 §2.3 去重落待办
  return { ran_at, items, patches, report_id: ... };
};
```
- 报告落库：追加 `decision_retro_report` 新列 `param_inspection`（JSONB），旧行兼容空。
- **绝不自动 apply**：本条只 `savePatches`（PENDING），生效走 §2.4 人工批准。
- 前端（sales-decision-monitor / 待办卡）可订阅 `emit('calibration','param-inspection',{...})`。

### §2.3 定量护栏接线（处方引擎「复活」）

1. **播种 `retro-knob-map`**：`db/schema.sql` 种子段 + 幂等 UPSERT；键结构 = `{ knob_map: [{ root_cause_class, metric, healthy_baseline, direction, sensitivity_k, sensitivity_slope, max_step, min_step }] }`。
2. **接线 `prescribe()`**：`paramInspector` 对每项建议先过 `findKnobSpec` → `prescribe({cur, measured, spec, floor, ceiling})`，拿到**护栏过的目标值**（单步 ≤ max_step、越界夹回 + risk 升级）。
3. 兜底：未命中 spec 的键出「review」类建议（LLM 可看，不直接进处方）。

### §2.4 my-todo 增「参数调优」视角（P0 断裂点 2 修复）

**数据面**：`workbenchRouter.js` VIEWS 增 `'tuning'`（别名「参数调优」）。`buildViewRows('tuning')` 聚合 `calibration_patch.status='PENDING' AND assignee ∈ {ADMIN,SYSADMIN,TAN_ADMIN}`（按当前 actor 角色匹配，tan_admin 限本租户）→ 行字段 `{ id, title, knob, target, from_value, to_value, risk }`。

**签批面**：`/api/my-todo` 增 `tune-approve` / `tune-reject`（复用既有 `approvalHandlers` 模式），内部调既有 `approvePatch / rejectPatch`（**零新增写通道**，第 0 闸天然保留）。前端 `my-todo.html` 增加视角 tab + 批准/驳回按钮（复用既有 crm-* 控件与铁律）。

**权限**:PENDING 处方 assignee 含 ADMIN → 该视角仅 ADMIN/SYSADMIN/tan_admin 可见；普通 sales 不可见。

### §2.5 `routing-explore` 注册（配置可见性补齐）

`configCenter.js` CONFIG_ITEMS 补 1 项（`context-routing` A/B 实验参数：window_days/max_running/blacklist/min_arm_sample/daily_review_enabled），level='system'、endpoint `/api/config/routing-explore`（只读 + 可调，写仍走第 0 闸）。

### §2.6 键名错配修复

`retro.js:24` `retroTimeoutMs()` 改读 `retro-config`（库中真实键），删除对 `decision-retro` 的引用（不迁移键，只改消费方；`decision-retro` 键如存在标记弃用）。

---

## §3 参数体检判据表（22 项全覆盖）

| # | 键 | 参数 | 采样来源 | 健康判据（示意） | 建议方向 |
|---|---|---|---|---|---|
| 1 | `autonomy-conf` | `threshold` | 决策覆写率/升级率 | 覆写率>25%或升级疲劳>30% → drift | 阈值 ±0.05（走廊 [0.5,0.95]） |
| 2 | `autonomy-conf` | `weights`（5 键） | 分项敏感度相关 | 某分项敏感度显著高 → 上调 0.05（和恒 1） | R4 规则 |
| 3 | `sales-thresholds` | BANTCC 达标线等 | 转阶段样本通过率 | 场景通过率远离目标 → drift | 按缺口调整（走廊见 config） |
| 4 | `precedent-conf` | 四分量权重 | 命中→覆写相关性 | 某分量命中率低 → 降权 | 归一化调整 |
| 5 | `precedent-conf` | `minSimilarity` | 命中率/误召回 | 命中率极低 → 下调（走廊 [0.3,0.6]） | prescribe 护栏 |
| 6 | `rubric-thresholds` | 九尺子及格线 | 场景通过率 | 通不过率陡升 → review | 走廊内调 |
| 7 | `rubric-weights` | 九尺子权重 | 各尺子区分度 | 区分度近 0 → 降权 | review |
| 8 | `rubric-llm` | 尺子 LLM 开关 | LLM 有效性 | LLM 长期不可用 → 建议保持 off | review |
| 9 | `approval-config` | 金额档/角色链 | 审批时长/驳回率 | 驳回率高 → 档位或角色链 review | review |
| 10 | `behavior-standard` | 量化目标 | 达标率 | 全员超标/全不达标 → drift | 量化目标 ± |
| 11 | `named-account-targets` | 频率/窗口 | 应访达成率 | 达成率远离目标 → drift | 频率/窗口 |
| 12 | `alert-rules` | 阈值 | 告警误报率/漏报率 | 误报率>X → 阈值上调 | 阈值 ± |
| 13 | `pool-config` | `pick` / `recycle` | 池周转 | 回收率过低/池积压 → drift | 天数 ± |
| 14 | `finance-receivables` | 逾期/差额/账龄 | 回款账龄分布 | 逾期集中 → 分级档 review | review |
| 15 | `event-retro` | 下限/冷却 | 复盘产出率 | 冷却过长致产出 0 → 缩短 | 小时 ± |
| 16 | `agent-event-trigger` | 冷却/白名单 | 派发命中率 | 命中率近 0 → review | review |
| 17 | `seven-dim` | 维度档位 | 决策卡因维度占比 | 长期卡某维 → 档位 review | review |
| 18 | `business-tier` | 分级矩阵 | 自主/升级分布 | 分级与结果错配 → review | review |
| 19 | `llm` | provider/model/temp | 调用成功率/耗时 | 成功率低或超时率高 → 建议切换 | review |
| 20 | `hindsight-deviation` | 偏差阈值 | 偏差告警数 | 恒高频告警 → 阈值上调 | 阈值 ± |
| 21 | `decision-context-guard` | 守卫阈值 | 上下文拦截率 | 拦截率失控 → review | review |
| 22 | `billing-plans` | 套餐闸门 | 租户用量/拦截 | 高频 402 → 权益或档位 review | review |

> 注：`context-routing` 已由 P1/P2 的 routingReview 独立覆盖（narrative A/B），巡检器对其实施 **A/B 结论补位**（未到期实验不重复出方，避免双处方打架）——统一在 `paramInspector` 白名单中跳过其运行中实验的轨道键。

---

## §4 交付清单与分期

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | ① `paramInspector.js`（判据表 22 项 + 冷却 + fail-open）② `retro.js` 挂 `runParamInspection`（独立 pass + 报告 `param_inspection` 列迁移）③ `retro-knob-map` 种子 + `prescribe` 接线 ④ 键名错配修复 | 巡检器单测绿 + 夜批 dryRun 报告含 22 项 |
| **P1** | ⑤ my-todo「参数调优」视角 + 签批 API + 前端 tab ⑥ `routing-explore` 注册配置中心 | PENDING 处方可在 my-todo 列出并批准生效 |
| **P2** | ⑦ 监控台「参数体检」浮卡/段落（订阅 param-inspection 事件）⑧ 文档/测试补齐 | 端到端：夜批 → 待办 → 批准 → config_store 变更留痕 |

**铁律**：每一期完成后跑对应测试 + ui-lint；写经第 0 闸；不 DELETE；`context-routing` 禁改红线保持（A/B 处方仍只出 PENDING）。

---

## §5 开放问题（待批准时一并裁决）

1. **巡检器判据初始参数集**：§3 表中「健康判据/目标走廊」给出示意值，实际数值放 `config_store['param-rules']`（可调），代码只存出厂兜底——是否同意？
2. **报告段落后缀**：`param_inspection` 段落是并入既有 `decision_retro_report`（新列）还是独立新表？我建议**新列**（同一 report_id 下多段落，查询链不动）。
3. **my-todo 视角顺序**：tab 排第几位？建议在「待我审批」之后（该视角与审批语义最接近）。
4. **巡检器执行时点**：与 LLM 复盘同夜批（02:00 串联）——LLM 复盘失败不拖垮体检（已设计为独立 pass）——是否同意？

---

## §6 落地状态（2026-09-05 P0/P1/P2 完成）

| 期 | 交付 | 状态 | 证据 |
|---|---|---|---|
| **P0** | `paramInspector.js`（22 项判据 + 冷却 + fail-open）+ `retro.js` 独立 pass + `param_inspection` 列迁移 + `retro-knob-map` 种子 + `retroTimeoutMs` 键名错配修复 | ✅ | 单测 `paramInspector.test.js` 8 例 + `paramInspectionPass.test.js` 4 例绿；dryRun 报告 22 项 |
| **P1** | my-todo「参数调优」第六视角 + `tune-approve/tune-reject`（零新增写通道，复用 `approvePatch/rejectPatch`）+ `routing-explore` id44 注册 + id43 既有遗漏补登 | ✅ | `workbench-routes.test.js` 22 例 / `workbench.schema.test.js` 6 例 / `configCenter.test.js` 20 例绿；ui-lint 0 违规 |
| **P2** | 监控台「参数体检」浮卡（订阅 `param-inspection`）+ my-todo `?view=tuning` 直达 + 端到端验收脚本 | ✅ | `e2e-param-inspection.mjs` dryRun+approve 全绿；浮卡 ui-lint 0 违规 |

### 端到端验收实录（`crm_native_test`，独立租户 `e2e-param-v3`）

```
Step 2 参数体检（真实落库）
  inspected=22 healthy=20 drift=2 degraded=0 cooling=0 unknown=0 patches=1 created=1
Step 3 待办落库：patch autonomy-conf.threshold  from 0.91 → 0.86  PENDING  assignee=ADMIN
Step 4 批准生效：APPLIED + decision_id 锚定 → config_store threshold=0.86（裸值，非嵌套对象）
Step 5 回退：ROLLED_BACK → config_store threshold=0.91
汇总：全绿
```

### 落地过程中揪出并修复的真 bug（单测全绿但真环境必炸）

1. **处方 value 裸值契约**：`paramInspector` 原 `to_value:{[param]:val}` 包裹，`ConfigStoreStrategy.apply` 对 `target='key.sub'` 直接赋 `next[sub]=toValue` → 批准后 `threshold` 变嵌套对象 `{threshold:0.86}`（引擎消费静默失效）。修：传**子键裸值**（回滚对称），补单测锁死。
2. **override_rate 恒 0（假绿）**：`buildSample` 原 `adopted.filter(OVERRIDDEN)`——adopted 已过滤掉 OVERRIDDEN 行 → 恒空 → `autonomy-conf.threshold` 永不 drift。修：基于**全量 list** 计数，补样本（7/24≈0.29）验证 drift 命中。
3. **P2-2 验收经验**：判据是严格 `>0.25`，样本 6/24=0.25 恰好不触发（边界）；巡检器采样 SQL 全库无租户过滤（系统级配置设计），验收需注入按租户 query 复现。

### 提交分组（按功能线）

| 组 | 文件 |
|---|---|
| P0a | `db/migration-param-inspection.sql` + `db/migrate.js` + `db/schema.sql` |
| P0b | `src/calibration/paramInspector.js` + `src/decision/retro.js` + `src/scheduler/timers.js` |
| P0c | `test/calibration/paramInspector.test.js` + `test/decision/paramInspectionPass.test.js` |
| P1a | `src/http/workbenchRouter.js` + `src/web/my-todo.html` + `test/http/workbench-routes.test.js` |
| P1b | `src/portal/configCenter.js` + `src/web/config.html` + `test/web/configCenter.test.js` |
| P2a | `src/web/sales-decision-monitor.html` + `scripts/e2e-param-inspection.mjs` + 本文档 |
| 生产验证 | `scripts/prod-param-nightly-verify.mjs`（只读 dryRun） | ✅ | 生产库 inspected=22/22 无异常；Bug B 暴露；见 §7 |

---

## §7 生产库夜批真实触发验证（2026-09-05，dryRun 只读）

### 验证脚本
- 新增 `scripts/prod-param-nightly-verify.mjs`：连接生产库 `crm_native`（localhost），调用**真实** `runParamInspectionPass({dryRun:true})`（含真实 `inspectAll`），验证夜批第三段在真实生产配置 + 真实 `decision` 样本上正确执行。**默认只读、不落 PENDING、不写 report 列、不碰 config_store**。
- 安全护栏：仅 `--prod` 指向 `crm_native`；禁 `127.0.0.1`；dryRun 全程零写。

### 实测证据（生产库 crm_native，2026-09-05 11:49）
```
Step 1 真实 runParamInspectionPass（dryRun）
  inspected=22 healthy=20 drift=2 degraded=0 cooling=0 unknown=0 patches(计算未落库)=0
Step 2 体检明细（2 项 drift）
  rubric-thresholds.good         health=drift  verdict=adjust  cur=0.75
  precedent-conf.minSimilarity   health=drift  verdict=adjust  cur=0.45
Step 3 report 列：param_inspection 列已存在；最近 retro report
  report_id=5000e61a run_at=2026-09-05 02:00:00 param_inspection已写=false
```

### 结论与裁决
1. **夜批第三段真实代码路径在生产库跑通**：inspected=22/22、无异常 —— 定时器 `timers.js` ④（02:00 经 `runRetroOnce`→`runParamInspectionPass`）接线正确，真实触发可产出 22 项体检结论。
2. **今日 02:00 批未含参数体检段**：最近 retro report（`run_at=2026-09-05 02:00:00`）的 `param_inspection` 列为空 → 今日 02:00 跑批发生在 P2 代码上线（前次会话重启 `npm run dev`）之前，跑的是旧 `runDecisionRetro` 单段。当前运行实例已含 P2 代码（`my-todo.html?view=tuning` 返回 200 已实证），**明晨 02:00 批为首个真正含参数体检段的夜批**。
3. **Bug B 在生产真实触发下暴露**：`rubric-thresholds.good` 判据正确判 `adjust`，但 `prescribe` 护栏以 `measured=sample['good']??0`（buildSample 无 `good` 键）恒为 0 作判定 → direction='up'/baseline=0.75 时 `sign(gap=0.75)!==-1` 永远 gate 返 null → good 处方被抑制（生产真实触发下 0 方）。**写通道放开前须先 design 修复 Bug B**，否则夜批只会偶发产生 `autonomy-conf.threshold` 处方（其 measured=0 偶然满足 direction='down' 放行，但 `to_value` 来自 `suggest()` 仍正确，属「假绿放行」）。
4. **timers-param.test.js（P0 计划提及未建）判定为冗余**：三段互不传染独立性已由 `test/decision/paramInspectionPass.test.js`（4 例：disabled 跳过 / !dryRun 落 PENDING+report 列 / dryRun 不落库 / 失败留痕不抛）完全覆盖，不再单建。

### 写通道放开的阻断项
- **Bug B（已于 2026-09-05 批准方向①）**：`prescribe` 护栏 `measured` 来源错位（`paramInspector.js:134` `sample[spec.param] ?? 0` vs `buildSample` 无对应键）。修复方案见 §8（本地护栏替代 prescribe 网关，prescribe 核心零改动）。
- 修复后可运行 `scripts/prod-param-nightly-verify.mjs --prod`（去 dryRun）做生产真实落库 + my-todo 批准闭环验证。

---

## §8 Bug B 修复设计（已批准方向①，2026-09-05 · 已实施并生产验证）

### 根因（代码级）
- `src/calibration/paramInspector.js:134`：`prescribe({ cur: Number(cur)||0, measured: sample[spec.param] ?? 0, spec: kn, floor, ceiling })`；`spec.param` ∈ {good, threshold, minSimilarity} 均不在 `buildSample`（190-223 行）返回键中 → `measured` 恒为 0。
- `src/decision/prescription.js:18-22`：`gap = baseline - measured`；`good` 旋钮 `direction='up' / baseline=0.75` → `sign(gap=0.75)=1`，`expectSign=-1` → 永远 `return null` → good 处方被静默抑制（生产 dryRun 实测 drift=2 但 patches=0）。

### 方案（方向①：本地护栏替代 prescribe 网关）
- 移除 `paramInspector.js:130-135` 的 `prescribe` 调用及 `measured=sample[spec.param]??0` 误判；**`prescribe` 核心与 retro 主链路零改动、零回归**。
- 在 `verdict==='adjust' && suggested != null` 分支内改用本地三步定量护栏（确定性、禁 LLM 自由定步长）：
  1. `suggested` 为有限数；
  2. `spec.floor <= suggested <= spec.ceiling`（越界跳过，防精度崩塌）；
  3. `Math.abs(suggested - Number(cur||0)) > 1e-9`（非 no-op，避免空处方）。
- 移除 `paramInspector.js` 顶部 `prescribe` 的 import（方向①下护栏不再依赖 retro-knob-map，`findKnobSpec`/`readKnobMap` 调用点一并移除）。
- 步长仍由配置化 `rule.target`（`suggest`）保守给出；处方 PENDING 由 my-todo 人工批准生效（铁律⑦：绝不自动 apply）。

### 设计契约（双轨）
```contract-yaml
- task: "修复 Bug B：paramInspector 处方护栏 measured 来源错位"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "inspectAll 对 rubric-thresholds.good(verdict=adjust) 产出 PENDING 处方；生产 dryRun patches>=1；test/decision/prescription.test.js 与 paramInspector 单测不回归"
```

### 成功标准（可验证）
- 单测：`test/calibration/paramInspector.test.js` 新增「good verdict=adjust 时产出 patch（不再被 prescribe measured=0 抑制）」用例；`prescription.test.js` 维持绿（prescribe 未改）。
- 生产 dryRun：实施后用 `node scripts/prod-param-nightly-verify.mjs --prod` 验证 patches>=1（good 出方）。
- 回归：calibration / decision / scheduler 批次单测全绿。

### 移交 writing-plans 后实施要点
- 改动文件：`src/calibration/paramInspector.js`（调用点 + import）、`test/calibration/paramInspector.test.js`（新增用例）。
- 不改动：`src/decision/prescription.js`、`src/decision/retro.js`、`config_store['retro-knob-map']`。
- 提交分组：Bug B 修复单独立 commit（与 P2 改动分离，禁 git add -A）。

### §8.1 实施落地证据（2026-09-05 本会话）
- **改动**：`src/calibration/paramInspector.js` 移除 `prescribe/findKnobSpec` 导入与 `measured=sample[spec.param]??0` 误判调用点，替换为本地三步定量护栏（有限数 + `[floor,ceiling]` + 非 no-op）；`prescribe` 核心 / `retro.js` / `retro-knob-map` 零改动。`readKnobMap`/`DEFAULT_KNOB_MAP` 导出保留（Bug A 测试依赖）。
- **单测**：`test/calibration/paramInspector.test.js` 新增「good verdict=adjust 必须出 PENDING 处方」用例 → 先红后绿；paramInspector(10) + prescription(6) 全绿。
- **回归**：calibration/decision/scheduler 批次 531 passed；4 失败均为 `stopLossMirror.test.js` 硬编码 `host:'127.0.0.1:5433'`（PG 仅监听 `[::1]` 环境坑，**非本次回归**）。
- **生产 dryRun（只读，`crm_native`）**：inspected=22/22 无异常；Bug B 验证 `[PASS]`——`rubric-thresholds.good` 判 adjust 并正确出方 `from=0.75 → to=0.6`（PENDING 待人工批准）；`precedent-conf.minSimilarity` 因 `rule.target=()=>null` 仍不出方（设计预期：仅记录下调建议，人工决策）。汇总全绿。

---

## §9 总落地状态（截至 2026-09-05）

| 分期 | 内容 | 状态 |
|---|---|---|
| P0/P1 | 22 项参数闭环监控 + 每夜智能体体检 + 报告覆盖 + my-todo 待办 + 批准生效 | ✅ 完成 |
| P2 | 监控台参数体检浮卡 + my-todo `?view=tuning` 直达 + 端到端验收脚本 + 文档 | ✅ 完成 |
| 夜批真实触发验证 | 生产库 dryRun 只读验证夜批第三段（timer④ 02:00 接线正确） | ✅ 完成（inspected=22/22）|
| Bug A | readKnobMap 空 knob_map 回退 DEFAULT | ✅ 已修 + 单测锁死 |
| Bug B | paramInspector 本地三步护栏替代 prescribe 误判 | ✅ 已修 + 单测 + 生产 dryRun 验证 |
| 写通道放开·落库 | 生产真实落库（自动巡检 `runParamInspectionPass({dryRun:false})` 写 PENDING） | ✅ 已完成（2026-09-05 实测：REJECT 陈旧手动 `33a2bb85` → 自动巡检 inspected=22/drift=2/patches_created=1 → 新 PENDING `10e4996f` good 0.75→0.6）|
| 写通道放开·my-todo 可见 | 自动处方上「参数调优」待办（`GET /api/my-todo?view=tuning` HTTP 200 命中） | ✅ 已完成（实测返回 `10e4996f` 行）|
| 写通道放开·批准生效 | 人工点批准 → `config_store.good` 0.75→0.6（第0闸 + 事务原子） | ⏳ 待用户（零信任 HITL：AI 不代批；前次手动插方已实证整条批准链路低风险）|

> 写通道放开进度：自动巡检真实落库 + my-todo 待办可见两段已实证闭环；仅剩「人工批准改 config」这半步，按零信任须由 ADMIN 在 `my-todo.html?view=tuning` 点批准（或 `POST /api/my-todo/tune-approve`）。批准后经第0闸 `produceDecision('CALIBRATION_CHANGE')` 锚定 `decision_id`，`config_store.good` 生效；如需回退 `rollbackPatch` 恢复 0.75。全程零 DELETE、零自动 apply。

---

## 附：与红线的一致性自检

- 写操作：仅 `approvePatch` 内 `ConfigStoreStrategy.apply`（事务 + 第 0 闸 + HITL）→ 合规
- `context-routing`：不直接写，`routingReview` 只出 PENDING（既有红线保持）
- 禁 DELETE：本设计零 DELETE（`param_inspection` 追加式；`retro-knob-map` UPSERT 幂等）
- 阈值配置化：判据/走廊全部进 `config_store['param-rules']`，代码仅出厂兜底
- 假绿防线：处方建议一律先过 `prescribe()` 护栏；样本不足不出方；单测绿 ≠ 接线（以端到端 dryRun 报告验收）
