# Bug B 修复：paramInspector 处方护栏 measured 来源错位

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复参数巡检器（paramInspector）在 `rubric-thresholds.good` 等键上「判 adjust 却不产处方」的 Bug B —— 根因是 `prescribe` 护栏以 `measured=sample[spec.param] ?? 0`（buildSample 无对应键）恒为 0 做方向判定，永远 gate 返 null。改用本地三步定量护栏替代 prescribe 网关，prescribe 核心与 retro 主链路零回归。

**Architecture:** `paramInspector.inspectAll` 的处方生成分支（`verdict==='adjust' && suggested!=null`）原本调用 `prescribe({ measured: sample[spec.param] ?? 0 })` 作布尔闸门。由于 `buildSample` 只产出 `override_rate/escalate_rate/hit_rate/scene_pass_rate…`，无 `good/threshold/minSimilarity` 键，`measured` 恒 0，导致 `good`（`direction='up'`）方向判定永远失败。修复：移除 prescribe 调用点与 `prescribe/findKnobSpec` 导入，改用「建议值有限数 + `[floor,ceiling]` 安全走廊 + 非 no-op（|Δ|>1e-9）」三步本地护栏决定出方；步长仍由配置化 `rule.target`（`suggest`）保守给出，最终处方 PENDING 由 my-todo 人工批准（铁律⑦：绝不自动 apply）。`prescribe` / `prescription.js` / `retro.js` / `retro-knob-map` 一律不动。

**Tech Stack:** Node 22 ESM + Vitest 3（单测）；PostgreSQL（仅生产 dryRun 只读验证，不落库）。

---

## 文件结构

- **Modify:** `src/calibration/paramInspector.js` —— 移除 `prescribe/findKnobSpec` 导入（line 17）；替换处方生成分支（line 129-151）为本地三步护栏。`readKnobMap`/`DEFAULT_KNOB_MAP` 导出保留（被 Bug A 回归测试 `test/calibration/paramInspector.test.js` 引用，不可删）。
- **Modify:** `test/calibration/paramInspector.test.js` —— 新增 Bug B 回归用例：good 判 adjust 时必须产出 patch。
- **ReadOnly 验证:** `scripts/prod-param-nightly-verify.mjs --prod`（连生产库 crm_native 跑真实 `runParamInspectionPass({dryRun:true})`，只算不落库）确认 `patches>=1`。

---

### Task 1: 写失败测试（Bug B 回归：good 必须出方）

**Files:**
- Modify: `test/calibration/paramInspector.test.js`（在 line 120 之后、闭合 `});` 之前追加 `it` 块）

- [ ] **Step 1: 在 `test/calibration/paramInspector.test.js` 末尾 `});` 之前追加 Bug B 回归用例**

```js
  it('Bug B 回归：rubric-thresholds.good verdict=adjust 时必须产出 PENDING 处方（不被 prescribe measured=0 抑制）', async () => {
    const out = await inspectAll({
      tenantId: 'system',
      query: async (sql) => {
        if (String(sql).includes('crm.decision')) {
          // 场景 A：10 行中 3 行 won → scene_pass_rate=0.3 → |0.3-0.75|=0.45>0.2 → adjust
          const rows = [];
          for (let i = 0; i < 3; i++) rows.push({ scenario_id: 'A', human_disposition: null, outcome_verified: 'won' });
          for (let i = 0; i < 7; i++) rows.push({ scenario_id: 'A', human_disposition: null, outcome_verified: 'lost' });
          return { rows };
        }
        return { rows: [] };
      },
    });
    const p = out.patches.find((x) => x.target === 'rubric-thresholds.good');
    expect(p).toBeTruthy();
    // 裸值契约：to_value 是数字（非 {good:0.6} 包裹对象）
    expect(typeof p.to_value).toBe('number');
    expect(p.from_value).toBe(0.75);
    // suggest 目标 = clamp(0.75 + (0.3-0.75)*0.5) = clamp(0.525) → max(0.6,..)=0.6
    expect(p.to_value).toBeCloseTo(0.6, 5);
    expect(p.risk).toBe('MEDIUM');
  });
```

- [ ] **Step 2: 运行测试确认它失败（当前 Bug B 未修，good 被 prescribe 抑制）**

Run:
```bash
cd D:/system/CRM-ai-native && npx vitest run test/calibration/paramInspector.test.js -t "Bug B 回归"
```
Expected: FAIL —— `expect(p).toBeTruthy()` 失败（`out.patches` 中无 `rubric-thresholds.good`，因 prescribe measured=0 方向判定返 null）。其余用例仍绿。

---

### Task 2: 移除 prescribe 导入与误判调用点

**Files:**
- Modify: `src/calibration/paramInspector.js:17`（删除整行 import）
- Modify: `src/calibration/paramInspector.js:129-151`（替换处方生成分支）

- [ ] **Step 1: 删除 `prescribe/findKnobSpec` 导入行**

将：
```js
import { prescribe, findKnobSpec } from '../decision/prescription.js';
```
整行删除（修复后 paramInspector 不再引用 `prescribe` 或 `findKnobSpec`；两者定义仍在 `src/decision/prescription.js` 且 retro 主链路未 import，零回归）。

- [ ] **Step 2: 替换处方生成分支为本地三步定量护栏**

将（line 126-151 区间）：
```js
      const { health, verdict } = judge(spec, cur, sample, cfg);
      let suggested = null;
      if (verdict === 'adjust') suggested = suggest(spec, cur, sample, cfg);
      // 处方：adjust → 过 prescribe 护栏（定量护栏接线，禁 LLM 自由定步长）
      if (verdict === 'adjust' && suggested != null && spec.floor != null) {
        const knobMap = await readKnobMap({ tenantId }).catch(() => DEFAULT_KNOB_MAP);
        const kn = findKnobSpec(knobMap, { rootCauseClass: 'PARAM_DRIFT', metric: spec.param });
        const pres = kn
          ? prescribe({ cur: Number(cur) || 0, measured: sample[spec.param] ?? 0, spec: kn, floor: spec.floor, ceiling: spec.ceiling })
          : null;
        if (pres) {
          patches.push({
            knob: 'config_store',
            target: `${key}.${spec.param === 'weights' ? 'weights' : spec.param}`,
            // ⚠ 处方 value 契约：to_value/from_value 传「子键裸值」（非 {param:val} 包裹）。
            //   ConfigStoreStrategy.apply 对 target='key.sub' 直接赋 next[sub]=toValue，
            //   包裹会把子键写成嵌套对象（end-to-end 实测：threshold 变 {threshold:0.65} → 引擎消费 object）。
            from_value: cur,
            to_value: suggested,
            evidence: { inspector: 'paramInspector', key, param: spec.param, rule: spec.param, sample },
            expected_impact: { note: `参数体检：${key}.${spec.param} 建议由 ${cur} → ${suggested}` },
            risk: spec.risk,
            assignee: 'ADMIN', tenant_id: tenantId,
          });
        }
      }
```
替换为：
```js
      const { health, verdict } = judge(spec, cur, sample, cfg);
      let suggested = null;
      if (verdict === 'adjust') suggested = suggest(spec, cur, sample, cfg);
      // 处方：adjust → 过本地定量护栏（确定性、禁 LLM 自由定步长）。
      // Bug B 修复：不再调用 prescribe 的 measured=sample[spec.param]??0 误判
      //   （buildSample 无 good/threshold/minSimilarity 键 → measured 恒 0 → 方向判定永远 gate 返 null → good 处方被抑制）。
      //   护栏只守三件确定的事：建议值有限 / 在 [floor,ceiling] 安全走廊 / 相对当前值有正向变更（非 no-op）。
      //   步长已由配置化 rule.target(suggest) 保守给出，最终处方 PENDING 由 my-todo 人工批准生效（铁律⑦）。
      if (verdict === 'adjust' && suggested != null && spec.floor != null) {
        const next = Number(suggested);
        const curNum = Number(cur) || 0;
        const inBounds = Number.isFinite(next) && next >= spec.floor && next <= spec.ceiling;
        const nonNoop = Math.abs(next - curNum) > 1e-9;
        if (inBounds && nonNoop) {
          patches.push({
            knob: 'config_store',
            target: `${key}.${spec.param === 'weights' ? 'weights' : spec.param}`,
            // ⚠ 处方 value 契约：to_value/from_value 传「子键裸值」（非 {param:val} 包裹）。ConfigStoreStrategy.apply 对 target='key.sub' 直接赋 next[sub]=toValue。
            from_value: cur,
            to_value: suggested,
            evidence: { inspector: 'paramInspector', key, param: spec.param, rule: spec.param, sample },
            expected_impact: { note: `参数体检：${key}.${spec.param} 建议由 ${cur} → ${suggested}` },
            risk: spec.risk,
            assignee: 'ADMIN', tenant_id: tenantId,
          });
        }
      }
```

> 注意：`readKnobMap` / `DEFAULT_KNOB_MAP` 的 `export` 定义（paramInspector.js:241-253）**保留不动**——它们被 `test/calibration/paramInspector.test.js` 的 Bug A 回归用例（readKnobMap 空数组回退）引用，且属出厂旋钮配置公共 API。

---

### Task 3: 运行单测验证通过

**Files:**
- Test: `test/calibration/paramInspector.test.js`

- [ ] **Step 1: 运行 paramInspector 单测全集**

Run:
```bash
cd D:/system/CRM-ai-native && npx vitest run test/calibration/paramInspector.test.js
```
Expected: 全部 PASS（含新增 Bug B 用例、已有 threshold 出方用例、readKnobMap 空数组回退用例、context-routing 红线等）。

- [ ] **Step 2: 运行 prescription 单测确认 prescribe 核心未动、仍全绿**

Run:
```bash
cd D:/system/CRM-ai-native && npx vitest run test/decision/prescription.test.js
```
Expected: 全部 PASS（prescription.js 未改，核心定量引擎行为不变）。

---

### Task 4: 回归批次（calibration / decision / scheduler）

**Files:**
- Test: `test/calibration/**`、`test/decision/**`、`test/scheduler/**`（如存在）

- [ ] **Step 1: 运行三批次回归**

Run:
```bash
cd D:/system/CRM-ai-native && npx vitest run test/calibration test/decision test/scheduler
```
Expected: 全部 PASS，无新增红（paramInspector 改动仅移除 prescribe 网关、不影响 judge/suggest/buildSample/retro 主链路）。

---

### Task 5: 生产库 dryRun 只读验证（修复后 patches>=1）

**Files:**
- ReadOnly: `scripts/prod-param-nightly-verify.mjs --prod`（连 crm_native，dryRun 只算不落库）

- [ ] **Step 1: 跑生产只读验证**

Run:
```bash
cd D:/system/CRM-ai-native && PGDATABASE=crm_native node scripts/prod-param-nightly-verify.mjs --prod
```
Expected: `inspected=22`；`patches(计算未落库)>=1`（至少 `rubric-thresholds.good` 出方）；无异常。**全程零写**（dryRun，不落 PENDING、不写 report 列、不碰 config_store）。

- [ ] **Step 2: 记录证据**

将输出中 `drift` 项与 `patches` 项数记入本次提交说明 / 今日工作记忆（Bug B 修复后生产真实触发证据）。

---

### Task 6: 独立 commit（与 P2 改动分离，禁 git add -A）

**Files:**
- `src/calibration/paramInspector.js`
- `test/calibration/paramInspector.test.js`

- [ ] **Step 1: 按功能线精确 add + commit**

Run:
```bash
cd D:/system/CRM-ai-native
git add src/calibration/paramInspector.js test/calibration/paramInspector.test.js
git commit -m "fix(calibration): Bug B — paramInspector 改用本地三步护栏替代 prescribe measured=0 误判，good 等键恢复出方；prescribe 核心零改动"
```

- [ ] **Step 2: 提交后体检**

Run:
```bash
cd D:/system/CRM-ai-native && git status --short
```
Expected: 仅上述 2 文件 staged/committed；无意外文件卷入（禁 git add -A）。

---

## 自检

1. **Spec 覆盖**：§8 要求「移除 prescribe 调用点 + measured 误判」「prescribe 核心/retro 主链路零改动」「good 出方」「单测不回归」「生产 dryRun patches>=1」—— 对应 Task 2 / Task 3 / Task 5。✓
2. **占位符扫描**：无 TBD/TODO；每步含完整代码与命令。✓
3. **类型一致性**：`inspectAll` 返回结构（`patches[].target/to_value/from_value`）与现有测试（threshold 用例）一致；新增 good 用例沿用同契约。✓
4. **不变量**：`readKnobMap`/`DEFAULT_KNOB_MAP` 导出保留（Bug A 测试依赖）；`prescribe`/`findKnobSpec` 仅在本文件删除引用，定义保留。✓
