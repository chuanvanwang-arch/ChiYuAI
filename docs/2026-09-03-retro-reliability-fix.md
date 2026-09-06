# 决策复盘可靠性修复设计（2026-09-03）

> 起因：用户 09-03 08:47 反馈「没有看到复盘昨晚的运行」。
> 结论：**昨晚复盘根本没跑；且即使跑了也必然没有推荐方案**——两层独立故障叠加。
> 本文记录取证结论、修复内容、验收证据与遗留项。

---

## §0 结论先行

| # | 故障 | 性质 | 状态 |
|---|---|---|---|
| F1 | 复盘**从未落库**（`decision_retro_report` 0 行） | 调度可靠性 | 已修（catch-up）+ 已补跑 |
| F2 | LLM **必然超时降级**（`drafts` 恒 0） | 参数硬编码错误 | 已修（超时配置化） |
| F3 | 静默吞错，故障不可自证 | 可观测性 | 已修（trace） |
| F4 | 5 个 server 实例抢 3000 端口 | 运维 | 已清理至 1 个 |
| F5 | `upsertConfig` 名不副实（撞唯一键即报错） | 代码缺陷 | 已修（真 upsert） |

---

## §1 取证

### F1 · 落库层
```
crm.decision_retro_report → count = 0（表存在，从未产出报告）
```

### F1 · 进程层
- `server.run.log`（2189 行）：**143 次 `EADDRINUSE` / 76 次 `Waiting for file changes` / 12 次 `ECONNREFUSED`**。
- 进程表：**5 个 `node --watch src/http/server.js`** 并存（PID 42548 / 7836 / 33680 / 43616 / 30308），仅 1 个真正 listen 3000，其余因端口冲突挂起等待文件变化。
- 机理：`alignRetroToHour()` 只在**进程启动那一刻**注册定时器；挂起实例不执行任何调度；DB 不可达时即便触发也在第一步 `loadWindowDecisions` 失败。**夜间窗口错过即永久丢失**。

### F2 · LLM 层（决定性）
拦截 `fetch` 抓取真实 HTTP：

| 调用 | 结果 | 耗时 |
|---|---|---|
| #1 | `AbortError` | 20017 ms |
| #2 | `AbortError` | 20014 ms |
| #3 | `AbortError` | 20008 ms |
| #4 | `AbortError` | 20005 ms |

放开 `signal` 后实测：

| 指标 | 实测值 |
|---|---|
| 单次真实耗时 | **106.9 s / 124.9 s** |
| `reasoning_tokens` | **12798 / 15044** |
| `prompt_tokens` | 750 / 752 |
| `finish_reason` | stop |

**根因**：`DeepSeek-V4-Flash` 是**推理模型**，复盘的长 prompt 触发 reasoning 长链。原硬编码 `timeoutMs: 20000` 对其必然超时。
补充：`max_tokens: 1200` **管不住 reasoning**（实测返回 12798 reasoning tokens，SiliconFlow 单独计），因此 `max_tokens` 不是瓶颈，**超时才是**。

对照实验：裸调小 prompt（几十 token 输出）3/3 成功、约 1 s —— 说明 Provider 与凭据均正常。

### F3 · 静默吞错
原 `analyzeCluster` 的 `llmJson` 调用无 try/catch 之外的落痕，`client.js` 的 `catch (e) { lastErr = e; }` 也仅吞掉异常。
结果：表现为 `llm_enabled=true` 但 `llm_effective=0`——信号存在但无人报警，故障不可自证。

---

## §2 修复

### 2.1 超时配置化（`src/decision/retro.js`）
```js
const RETRO_LLM_TIMEOUT_MS_FALLBACK = 180000;
async function retroTimeoutMs() {
  const cfg = await readConfig('decision-retro', { tenantId: 'system' }).catch(() => null);
  const n = Number(cfg?.value?.llm_timeout_ms);
  return Number.isFinite(n) && n > 0 ? n : RETRO_LLM_TIMEOUT_MS_FALLBACK;
}
```
- 在 `runDecisionRetro` 开头与窗口加载 `Promise.all` **并行读一次**，全程复用（避免每 cluster 重复查）。
- `max_tokens` 1200 → 4000（给 content 留余量）。
- 兜底值选取依据：实测 107–125 s，取 180 s 留 ~44% 余量；夜间批处理对时延不敏感。

### 2.2 失败留痕（同文件）
```js
} catch (e) {
  emit('trace', 'decision-retro-llm-call-failed', {
    scenario_id: cluster.scenario_id, timeout_ms: timeoutMs,
    error: String(e?.name || '') + ': ' + String(e?.message || e),
  });
}
```

### 2.3 启动补跑 catch-up（`src/scheduler/timers.js`）
用户选定方案：**启动补跑 + 02:00 定时**。

判据（短路顺序）：
1. 查 `crm.decision_retro_report` 最新 `run_at`；
2. `age < 24h` → **跳过**（`fresh`）——天然限流，重启再频繁也不重跑；
3. 距下次 02:00 `< 30min` → **跳过**（`near_schedule`）——交给定时，避免双跑；
4. 否则补跑（`stale`），并 `emit('trace','decision-retro-catchup-start')`。

护栏：
- `process.env.VITEST` 下**不触发**（避免单测打到真实 LLM/DB）；
- fire-and-forget，不阻塞 `ensureTimers` 返回；
- 探测失败 `emit trace + recordFailure`，**不外抛**（禁裸 catch）。

为可测性，相关函数提到模块级并支持依赖注入：
`runRetroOnce` / `nextRetroAt(t0)` / `catchUpRetro({ run, nowMs })`。

### 2.4 真 upsert（`src/llm/llmConfigStore.js`）
`name` 为全局 UNIQUE，原无 `id` 分支是纯 INSERT → 同名（含**软删残留行**）永久报 duplicate key。
改为 `ON CONFLICT (name) DO UPDATE ... is_deleted=false`（撞键时复用历史行）。

### 2.5 补跑工具（`scripts/retro-once.mjs`，新增）
```
node scripts/retro-once.mjs              # 落库跑批（windowHours=24）
node scripts/retro-once.mjs --dry-run    # 只跑不落库
node scripts/retro-once.mjs --hours=48   # 自定义窗口
```

---

## §3 验收

### L1 元数据
`crm.llm_config` 表存在（`to_regclass` 非空）；`config_store['llm']` 180 字节（siliconflow / DeepSeek-V4-Flash）。

### L2 单测
- `test/decision/retro.test.js` **7/7**（含新增「出厂兜底 180000 ms」锁；dryRun 查询守卫 1→2 次，config key 断言落在 `params`）。
- `test/scheduler/retro-catchup.test.js` **7/7**（新增：时点计算 2 + 触发判据 4 + 失败留痕 1）。
- `test/llm/llmConfigStore.test.js` **5/5**（此前因 DB 不可达被阻塞，现由真 upsert 修好）。

### L3 真实 DB 路径（`_verify_catchup.mjs`，注入 run 替身不真跑）
```
① 真实时点         → fresh          ran=false age=0.3h
② 模拟 09-05 10:00 → stale          ran=true
③ 模拟临 02:00     → near_schedule  ran=false 距下次02:00=10min
```

### L4 生产有数据
补跑落库 `report_id 0b908b5b-0d6c-4473-97f1-341086bfac15`：
`clusters=6`、`drafts=8`、`llm_effective=2`、`decisions_scanned=115`、elapsed 119.9 s。
（另两次运行分别 6 / 9 drafts——LLM 输出非确定性，属预期。）
查看入口：`/sales-decision-monitor` ← `GET /api/calibration/retro/latest`（sysadmin）。

### 回归
- 功能线 313 测试通过（首次全量）。
- `ui-lint` EXIT=0。
- ⚠ 中途一次回归出现 5 failed（`ruleKnowledge` / `methodologyExtractor`），经排除法确认**与本次改动无关**：
  `ruleKnowledge.test.js` 断言 `getRuleKnowledge(pool).length === 3`（全表长度），被 `test/http/preContext.contract.test.js` 的 `TEST_RULE_NO_SIDE_DEAL` 残留行击穿。该文件单独/组合重跑 **20/20 全绿**。根因是**跨会话并发共用 `crm_native_test`**（既有隔离债，见 MEMORY「禁并发两 vitest」）。

---

## §4 遗留

1. **`ruleKnowledge.test.js` 隔离脆弱**：断言全表长度，任一外来 `decision_rule` 行都会击穿。建议改为按自身 `CODES` 过滤断言（独立 Task）。
2. **`crm.llm_config` 表已建但 0 行**：仍靠 `config_store('llm')` 单条双源回退，round-robin 无第二条可换 → 跑 `node scripts/migrate-llm-config.mjs`。
3. **多实例竞争的根因未除**：清理了现存实例，但未提供单实例护栏（本次用户未选该方案）。
4. **PG 不稳定**：本轮再遇一次瞬时 `ECONNREFUSED` 后自愈；DB 依赖型任务建议加重试护栏。
5. **处方覆盖面受数据量约束**：6 个聚类中 4 个因 `MIN_SAMPLE=20` 样本不足走 R6 守卫不出处方。
6. **未 commit**（沙箱无凭证）：`src/decision/retro.js`、`src/llm/llmConfigStore.js`、`src/scheduler/timers.js`、`scripts/retro-once.mjs`（新增）、`test/decision/retro.test.js`、`test/scheduler/retro-catchup.test.js`（新增）、本文。
