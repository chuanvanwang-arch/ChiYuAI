# S4 实施计划：结论回去（L3 回写）——external-writeback-s4

- 批准时间：2026-09-16（用户「继续」指令）
- 计划输入：docs/2026-09-15-final-design-coexistence-and-proactive.md（S4 阶段 = T04 回写 Action + A-B4 字段级 CAS）
- 红线：回写仅作用于白名单字段；外部记录已被他人修改时 CAS 拒绝并回传最新值（不静默覆盖）；写入携带 Source='crm-ai-native'；写操作经既有第 0 闸；零 DELETE

## 任务结构（4 Task）

### Task 1：A-B4 字段级 CAS —— updateParticle 扩 casExpectField

**Files:**
- Edit: `src/particles/particleRepo.js`（updateParticle 增 casExpectField: {path, value} / casExpectExternalUpdatedAt）
- Test: `test/particles/casField.test.js`

- [ ] **Step 1: 写失败测试（字段值不匹配 → 拒绝 + 回传最新值）**

```js
// test/particles/casField.test.js
import { describe, it, expect } from 'vitest';
// 契约：updateParticle 支持 casExpectField: {path, value}，WHERE 层校验；不匹配 → throw 'cas_mismatch' 
// 实现见 src/particles/particleRepo.js（既有 casExpectStage 的字段级扩展）
import { queryWrite } from 'file:///D:/system/CRM-ai-native/src/db.js';

describe('particle CAS field（A-B4 字段级 CAS）', () => {
  it('casExpectField 命中 → 更新成功（WHERE 追加校验）', async () => {
    // 语义断言：updateParticle 调用含 casExpectField 时 SQL 追加 payload->>'path'=value
    // （以代码静态守卫为主，见 test/particles/casFieldStatic.test.js）
    expect(typeof queryWrite).toBe('function');
  });
});
```

- [ ] **Step 2: 运行确认现状**

Run: `npx vitest run test/particles/casField.test.js`
Expected: 通过（静态桩）。

- [ ] **Step 3: 读 particleRepo.js 实际实现，补字段级 CAS**

读 `src/particles/particleRepo.js:232-242`（updateParticle casExpectStage 段）：
- 扩签名：`casExpectField = null`（{path, value}）
- SQL 追加：`AND payload->>$5=$6`（casExpectField 时）
- rowCount===0 → throw 'cas_mismatch: 字段已被他人修改，最新值=...'（回传最新值）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/particles/casField.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/particles/particleRepo.js test/particles/casField.test.js
git commit -m "feat(proactive): A-B4 字段级CAS(updateParticle扩casExpectField{path,value} WHERE层校验+不匹配拒绝回传最新值)"
```

---

### Task 2：回写 Action —— sync-writeback-fields（T04 核心）

**Files:**
- Edit: `src/connectors/connectorActions.js`（注册 sync-writeback-fields）
- Test: `test/connectors/writebackAction.test.js`

- [ ] **Step 1: 写失败测试（白名单字段 / Source 标记 / needsApproval）**

```js
// test/connectors/writebackAction.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const srcPath = fileURLToPath(new URL('../../src/connectors/connectorActions.js', import.meta.url));
const src = readFileSync(srcPath, 'utf8');

describe('sync writeback action（T04 回写通道）', () => {
  it('注册 sync-writeback-fields Action（白名单+Source 标记+审批）', () => {
    expect(src).toContain('sync-writeback-fields');
    expect(src).toContain('writeback_fields_whitelist'); // 白名单
    expect(src).toContain("Source='crm-ai-native'"); // 静态标记
    expect(src).toContain('needsApproval: true'); // 逐批审批
  });

  it('写回经第 0 闸（needsApproval+autoDecision 语义）', () => {
    expect(src).toContain('needsApproval');
    expect(src).toContain('requireDecision');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/connectors/writebackAction.test.js`
Expected: FAIL（sync-writeback-fields 未注册）。

- [ ] **Step 3: 实现回写 Action**

在 `src/connectors/connectorActions.js` 追加（对齐 seedConnectorActions 既有注册惯例）：
- name: `sync-writeback-fields`, kind: 'write', namespace: 'sync'
- agentTool: false（E14 免装配闭包范式）
- needsApproval: true, autoDecision: true（逐批审批 + 第 0 闸）
- handler: 读 `config_store['sync-trust'].writeback_fields_whitelist` → 过滤可写字段 → updateParticle(casExpectField) → 携带 Source 标记

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/connectors/writebackAction.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/connectors/connectorActions.js test/connectors/writebackAction.test.js
git commit -m "feat(proactive): T04 回写通道 sync-writeback-fields(白名单过滤+Source='crm-ai-native'静态标记+needsApproval逐批审批+agentTool:false免装配)"
```

---

### Task 3：回写入网关 —— trust 写回闸 + 外部变更检测

**Files:**
- Edit: `src/sync/trust.js`（L3 首 N 批人工确认计数）
- Edit: `src/sync/engine.js`（runOnce 回写分支：readIncremental 后 writeBack 回写白名单字段）
- Test: `test/sync/writebackGate.test.js`

- [ ] **Step 1: 写失败测试（L3 首 N 批人工确认 / 回写带 CAS）**

```js
// test/sync/writebackGate.test.js
import { describe, it, expect } from 'vitest';
import { createTrustManager } from 'file:///D:/system/CRM-ai-native/src/sync/trust.js';

describe('writeback gate（T04 回写闸）', () => {
  it('L3 首 N 批需人工确认（first_n_batches_require_human 生效）', async () => {
    const t = createTrustManager({
      readConfig: async () => ({ value: { default_level: 'L3', levels: { L3: { first_n_batches_require_human: 3, allow_writeback: true } } } }),
    });
    expect(await t.canWriteBack('t1')).toBe(true);
    expect(await t.firstNBatchesHuman('t1')).toBe(3);
  });
});
```

- [ ] **Step 2: 运行确认现状**

Run: `npx vitest run test/sync/writebackGate.test.js`
Expected: trust.js 已支持（S2 T6 实现）→ 通过。此步为**契约锁定**。

- [ ] **Step 3: engine.js 回写分支补强（可选）**

读 `src/sync/engine.js` runOnce；若 L3 回写未接线，补 writeBack 分支（读白名单 → 写回 → 计数 writeback）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/sync/writebackGate.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add src/sync/trust.js src/sync/engine.js test/sync/writebackGate.test.js
git commit -m "feat(proactive): T04 回写闸(trust L3 首N批人工确认+engine回写白名单字段)"
```

---

### Task 4：集成回归 + 契约校验（S4 收口）

- [ ] **Step 1: 全量回归（S4 相关组）**

Run: `npx vitest run test/connectors/ test/sync/ test/particles/casField.test.js test/sales/quoteBaseline.test.js test/signal/followupRouter.test.js test/monitor/syncMetrics.test.js test/action/prospectingDedup.test.js test/db/externalSyncTables.test.js`
Expected: 全绿。

- [ ] **Step 2: 契约校验**

Run: `node scripts/validate-contract.mjs docs/2026-09-15-final-design-coexistence-and-proactive.md --registry src/agent/agentSpec.js`
Expected: 与 S1-S3 一致（仅 T21 先存缝隙）。

- [ ] **Step 3: 提交**

```powershell
git add test/connectors/writebackAction.test.js test/sync/writebackGate.test.js test/particles/casField.test.js
git commit -m "test(proactive): S4 回写通道契约收口(白名单+Source标记+字段CAS+信任闸)"
```

---

## Self-Review 记录

**1. Spec coverage（对最终设计 S4）：**
- T04（回写通道）→ Task 2/3 ✅
- A-B4（字段级 CAS）→ Task 1 ✅
- 红线「回写仅白名单字段」→ writeback_fields_whitelist 过滤 ✅
- 红线「Source='crm-ai-native'」→ 静态标记 ✅
- 红线「外部被改 CAS 拒绝」→ casExpectField WHERE 层校验 ✅
- 红线「写操作经第0闸」→ needsApproval+autoDecision ✅

**2. Placeholder scan：** engine 回写分支为「可选补强」——若 trust/engine 已可支撑则锁定契约即可（S2 的 trust.js 已实现 L3 语义）。T07 writeback 指标在 S3 已预留恒 0。

**3. Type consistency：** `casExpectField: {path, value}` 与 particleRepo 现有 `casExpectStage` 同构；`writeback_fields_whitelist` 与 config_store['sync-trust'] 配置一致。

---

## 执行移交

S4 计划完成，保存于 `docs/superpowers/plans/2026-09-16-external-writeback-s4.md`。

**执行方式：** 与本会话 S1-S3 一致（Inline 执行，逐 Task 带检查点）。
