# 设计文档：夜批三段全量日报自动生成 + 内嵌 my-todo 待办

- 状态：已批准（2026-09-05，用户「同意」）
- 关联需求：「每天晚上智能体自动生成运行报告（含运行总数/成功/失败/失败原因/建议调整），作为附件进 my-todo 待办」
- 关联契约 agent：`decision-retro`（contract_task_id `ct-retro-decision`）

---

## §0 结论先行
夜批 timer ④（02:00，`timers.js:149`）跑完三段后，**新增「生成夜批三段全量日报」**：汇总三段既有结果 → 落盘 `reports/nightly/YYYYMMDD.md` → upsert `nightly_report` 表 → **参数调优 tab 顶部内嵌报告卡**（日报摘要 + 「查看完整报告」链接）。

**关键澄清（用户纠偏后锁定）**：复盘段①（`runDecisionRetro`，`retro.js:289`）**照常使用 LLM**（L235 `getLlmJson`，DeepSeek-V4-Flash 推理模型做根因深度归因）；本报告设计**仅限制「报告渲染步骤不新增 LLM 调用」**——`renderNightlyMarkdown` 是纯字符串模板拼接，只聚合三段已产出结果（含①的 LLM 归因文字），不二次调模型。参数段③（`runParamInspectionPass`，L515）本就确定性、无 LLM（L509 注释）。

## §1 架构改动（4 处，均复用既有能力，零新增写通道）

### ① 新增 `src/report/nightlyReport.js`
- `collectSegments({ retro, routing, param })` — 归一化三段返回：
  - `retro`：来自 `runDecisionRetro` 返回（report_id / decisions_scanned / clusters / draft_patches / summary / llm_enabled / llm_effective）
  - `routing`：来自 `runRoutingReviewPass` 返回（实验收口结论）
  - `param`：来自 `runParamInspectionPass` 返回（inspected / healthy / drift / unknown / patches 数组）
- `renderNightlyMarkdown({ date, retro, routing, param })` — **纯模板**，三段结构：
  - ① 决策复盘：运行总数 / LLM 生效簇数 / 失败（降级）原因 / 方案草稿
  - ② 路由收口：到期实验数 / 收口结论 / 失败原因
  - ③ 参数体检（22 项）：inspected / healthy / drift / 失败项明细（当前值→建议值→失败原因→建议调整措施）
- `saveNightlyReport({ retro, routing, param })` — 写 `reports/nightly/YYYYMMDD.md` + upsert `nightly_report`（run_date 唯一键 ON CONFLICT DO UPDATE）

### ② 改 `src/scheduler/timers.js:runRetroOnce`（L31-46）
当前链式 `.then` 只保留①返回值，②③无返回。改为**三段各自独立 catch（保留互不传染护栏）+ 收集三段结果 + 调 `saveNightlyReport`**（第 4 个独立 catch）：
```js
export const runRetroOnce = async () => {
  const retro = await runDecisionRetro({ windowHours: 24 }).catch(e => { emit('trace','decision-retro-failed',{error:String(e?.message||e)}); recordFailure('decision-retro-failed',e); return null; });
  const retroReportId = retro?.report_id || null;
  const routing = await runRoutingReviewPass().catch(e => { emit('trace','routing-review-failed',{error:String(e?.message||e)}); recordFailure('routing-review-failed',e); return null; });
  const param = await runParamInspectionPass({ reportId: retroReportId }).catch(e => { emit('trace','param-inspection-failed',{error:String(e?.message||e)}); recordFailure('param-inspection-failed',e); return null; });
  await saveNightlyReport({ retro, routing, param }).catch(e => { emit('trace','nightly-report-failed',{error:String(e?.message||e)}); recordFailure('nightly-report-failed',e); });
  return { retro, routing, param };
};
```
> 注：原 `.then((report) => ...)` 链改为 `await` 串行，语义等价（三段捕获各自结果），且额外产出报告不拖慢主链路（独立 catch）。

### ③ 新增表 `crm.nightly_report`（幂等 migration）
```sql
CREATE TABLE IF NOT EXISTS crm.nightly_report (
  report_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date       DATE NOT NULL UNIQUE,
  title          TEXT,
  file_path      TEXT,
  seg_retro_json   JSONB,
  seg_routing_json JSONB,
  seg_param_json   JSONB,
  total_tasks    INT,
  healthy        INT,
  drift          INT,
  patches_count  INT,
  created_at     TIMESTAMPTZ DEFAULT now()
);
```
- `run_date` UNIQUE → upsert（`ON CONFLICT (run_date) DO UPDATE`）保证每日一份、重跑幂等
- migration 入 `db/migrate.js` INCREMENTAL 清单（对齐既有约定）

### ④ my-todo 接线（参数调优 tab 内嵌报告卡）
- `workbenchRouter.js` `case 'tuning'`（L155+）：在返回 `data` 之外附加 `reportCard`（最新 `nightly_report` 一行：run_date / total_tasks / healthy / drift / patches_count / file_path）
- `my-todo.html` tuning 视图：顶部渲染报告卡（日期 + 总数/成功/失败 + 建议调整条数 + 「查看完整报告」按钮）
- 新增 `GET /api/nightly-report/:date`（ADMIN 鉴权）→ 读 `reports/nightly/YYYYMMDD.md` 返 markdown，按钮拉取弹窗显示

## §2 生命契约（双轨 contract-yaml）
```contract-yaml
- task: "实现夜批三段全量日报生成 + 落盘（报告渲染不新增 LLM 调用）"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "runRetroOnce 跑完三段后 reports/nightly/YYYYMMDD.md 落盘且 nightly_report 表 upsert 成功；单测锁死 renderNightlyMarkdown 含三段标题与计数；报告生成路径 zero 额外 LLM 调用（仅聚合既有结果）"
- task: "my-todo 参数调优 tab 内嵌报告卡 + 查看路由"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "GET /api/my-todo?view=tuning 返回 reportCard（latest nightly_report）；GET /api/nightly-report/:date 返 markdown；my-todo.html 顶部渲染卡片且按钮弹窗显示报告"
```

## §3 铁律与风险
- **报告渲染不新增 LLM 调用**：仅聚合三段既有结果（①复盘段自身仍由 LLM 产出归因，属既有行为，不改）；纯模板拼接
- **不新增写通道**：报告仅落盘 `.md` + 读 `nightly_report`；批准/改 config 仍由既有 `tune-approve`（第0闸 + 事务原子）承载，**本报告功能不自动批准任何处方**
- **三段互不传染护栏保留**：①/②/③各自 catch，报告生成第 4 个独立 catch（复盘失败不拖垮报告落库）
- **全局报告**：`nightly_report` 无 tenant_id（平台级），admin 通配可见；非 admin 不暴露 `/api/nightly-report/:date`
- **范围纪律**：本设计只做「报告自动生成 + 内嵌卡片 + 查看路由」，**不做自动批准**（审批仍人工）

## §4 实施要点 / 下一步
- 移交 `writing-plans` 出实施计划（含完整代码），用户批准后再写实现
- 测试：①单测 `renderNightlyMarkdown` 三段标题+计数；②`runRetroOnce` 改造后三段独立 catch 互不传染（桩注入）；③`nightly_report` upsert 幂等；④`/api/nightly-report/:date` 鉴权 + my-todo 卡片渲染
- 提交：按功能线分组（nightlyReport.js + timers.js 改动 + migration + workbenchRouter.js + my-todo.html + 路由），独立 commit，禁 git add -A
