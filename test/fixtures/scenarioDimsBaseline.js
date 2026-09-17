// test/fixtures/scenarioDimsBaseline.js — 场景字典 required_dims 的「基线快照 → 还原」助手
//
// 为什么需要（2026-09-17 定位到的真实抖动根因）：
//   `crm.decision_scenario` 自 2026-09-05 起 PK=(scenario_id, tenant_id)，但**写入侧普遍不带租户谓词**，
//   于是「改一个场景的 required_dims」实际会改到该场景的**全部租户行**。多个校准类测试文件都在改
//   `OPP_QUALIFY`：
//     · `test/calibration/router-p3.test.js` 写 `[{dim:'identity',on_missing:'block'}]` —— **原先没有 afterEach**
//       ⇒ 残留在共享库里，**按文件执行顺序**决定后续用例是否被拦；
//     · 另三个文件（knobs / store-p3 / replayDims）的还原值是硬编码 `'[]'::jsonb` —— 那**不是种子真值**
//       （真值见 main 库：4 个 warn 维），属「用另一种错误值去盖住上一种错误值」。
//   表现：`test/decision-gate.test.js`（经 `crm-deal-advance` 铸 `OPP_QUALIFY` 决策，`trigger_context`
//   不含 identity）偶发红 → `missing_context: 维度缺失 identity`；批内换个文件顺序就转绿
//   （与 2026-09-16 观测到的 base↔iso 翻转同源）。
//
// 本助手只做两件事，**不改任何被测语义**：
//   ① `snapshotRequiredDims(scenarioId)` —— 在文件开跑前记下该场景**各租户**的现值；
//   ② `restoreRequiredDims(scenarioId, snapshot)` —— 文件结束后按**租户逐个**写回。
//
// ⚠ 还原语句**必须带 tenant_id**（`... AND tenant_id=$3`）：否则就复现了它要修的那类缺陷
//   ——「按场景整体写」会连别的租户一起改。
// ⚠ 残留局限（诚实标注）：若**上一次运行崩溃**留下了脏值，本次 `beforeAll` 的快照会把脏值当成基线
//   继续传下去。彻底根治需要「从种子重建」而非「从现状快照」，但那要引入种子解析，本轮不做；
//   这里只保证「正常跑完一轮后，共享库回到开跑前状态」——这正是消除**顺序依赖**所需的那一条。
import { query, queryWrite } from '../../src/db.js';

export async function snapshotRequiredDims(scenarioId) {
  const r = await query(
    `SELECT tenant_id, required_dims FROM crm.decision_scenario WHERE scenario_id=$1 ORDER BY tenant_id`,
    [scenarioId]
  );
  return r.rows.map((x) => ({ tenant_id: x.tenant_id, required_dims: x.required_dims }));
}

export async function restoreRequiredDims(scenarioId, snapshot) {
  if (!Array.isArray(snapshot)) return 0;
  let n = 0;
  for (const s of snapshot) {
    const r = await queryWrite(
      `UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id=$2 AND tenant_id=$3`,
      [JSON.stringify(s.required_dims ?? []), scenarioId, s.tenant_id]
    );
    n += r.rowCount || 0;
  }
  return n;
}
