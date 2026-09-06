# LLM 多实例配置设计（列表 + 默认 + 轮询/故障转移）

> 状态：已批准（2026-09-02 P5 闸门，用户确认）
> 方法论：brainstorming → writing-plans → 实现
> 关联修复：src/llm/client.js 参数遮蔽 bug（已修，getLlmJson 恢复调用 LLM）

## §0 背景与动机

- **现状**：`config_store('llm')` 为单条 `jsonb`，`loadActiveCfg` 只产出一个 `cfg`；调用方仅 `src/decision/retro.js:179`（决策复盘）与 `src/llm/aiAttributes.js:79`（AI 属性评估），均调 `getLlmJson()` 拿单个函数。
- **已修前置 bug**：`readLlmConfig` 形参遮蔽模块导入的 `readConfig`，导致 `getLlmJson()` 无参调用恒降级、LLM 从不真调。已修复，`getLlmJson()` 现返回可调用函数。
- **实测痛点（DRAFTS=0 真凶）**：完整跑批 `runDecisionRetro` 时 6 个 cluster 串行连续调 SiliconFlow，在沙箱/限流下全部触发 20s 超时 → `getLlmJson` 的 catch 返回 null → 全部走降级分支 `EDGE_MISSING patches=0`（耗时 122s≈6×20s 超时）。对照实调：用真实 system prompt + 真实聚类数据单冷调用，6013ms 返回合法 `root_cause_class:"INFO_INCOMPLETE"` + 2 条 `draft_patches`。**结论：配置层、prompt、解析逻辑均正确；DRAFTS=0 是限流导致的连续超时降级，非代码缺陷。**
- **目标**：支持多条 LLM 配置（多 provider/model/key 任意组合），运行时按"默认标记"或"调用方指定 name"选取，并支持**调用时轮询/故障转移**以根治限流连续超时降级；同时为未来 agentLoop 多场景分流打基础。

## §1 存储设计（独立表 `crm.llm_config`）

```sql
CREATE TABLE crm.llm_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,          -- 配置名（如 'siliconflow-main' / 'openai-fallback'）
  provider text NOT NULL,             -- siliconflow / deepseek / openai
  model text NOT NULL,
  base_url text,                      -- 可空，缺省按 provider 补齐 /chat/completions
  api_key text,                       -- 加密列；secret.js 兼容非空明文（无 v1: 前缀原样返回）
  temp real DEFAULT 0.7,
  max_tokens int DEFAULT 1024,
  is_default boolean DEFAULT false,   -- 全局默认标记
  tenant_id text NOT NULL DEFAULT 'system',
  updated_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
-- 唯一默认：is_default=true 至多 1 条
CREATE UNIQUE INDEX uq_llm_config_default ON crm.llm_config (tenant_id) WHERE is_default;
```

- **迁移**：现有 `config_store('llm')` 单条（siliconflow / DeepSeek-V4-Flash / 明文 api_key）→ 迁入 `llm_config` 并标 `is_default=true`。
- **过渡兼容**：`client.js` 先读 `llm_config`，空时回退 `config_store('llm')`（双源，新表优先）；稳定后移除回退。

## §2 运行时选取 + 调用策略（改造 `src/llm/client.js`）

- `loadAllCfgs()`：读 `llm_config` 全表（缓存 15s，TTL 同现有）。
- `getLlmJson(opts)` / `getLlmThink(opts)` 扩展签名：
  - `opts.name`：指定某条配置名（`getLlmJson({name:'openai-fallback'})`）。
  - 不传 `name` → 取 `is_default=true` 那条（无则取首条）。
  - `opts.strategy`：`'default'`（单条）| `'round-robin'`（多配置间轮询，规避单 key 限流）| `'failover'`（主失败自动换下一个）。
- **轮询状态机**：模块级 cursor；`round-robin` 每次取一条 cfg 构建调用函数；`failover` 在某条 20s 超时/非 2xx 时跳到下一条。
- 保留 `getLlmJson()` 无参向后兼容（取 default + default 策略）。

## §3 配置中心 API（写操作经决策第 0 闸 + sysadmin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config/llm` | 列表（含 `is_default` 标记，`api_key` 脱敏显示 `***`） |
| POST | `/api/config/llm` | 新增（`name` 唯一约束） |
| PUT | `/api/config/llm/:id` | 改 |
| DELETE | `/api/config/llm/:id` | 删（**禁删 default**，否则 400） |
| POST | `/api/config/llm/:id/set-default` | 设默认（清旧默认） |
| POST | `/api/config/llm/:id/test` | 测试连通（单次实调返回 `{ok:true}` / `{ok:false,error}`） |

## §4 前端配置页

`src/web/` 下 LLM 配置从「单表单」改为「列表管理」：表格展示（name/provider/model/is_default/更新时间）+ 新增/编辑/删除/设默认/测试连通按钮。UI 一致性走 `src/web/tokens.css` 语义变量（遵守 `scripts/ui-lint.mjs`）。

## §5 调用方适配（直接根治 DRAFTS=0）

- `src/decision/retro.js:179`：`getLlmJson({ strategy: 'round-robin' })`（单跑批内多 key 间轮询，分散限流压力）。
- `src/llm/aiAttributes.js:79`：默认 `getLlmJson()`（取 default）；如需可传 `name` 指定。
- **单次调用重试**：`callChat` 超时/非 2xx 失败后，按 `round-robin`/`failover` 换下一条配置重试 1 次；超时阈值保持 20s。

## §6 Task 分解 + 生命契约（§A 双轨）

```contract-yaml
- task: "T1 建 crm.llm_config 表 + 迁移脚本（config_store('llm') 迁入标 default）"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  success: "crm.llm_config 存在且含 1 条 is_default=true（原 siliconflow 配置）；旧 config_store('llm') 仍可回退读"
- task: "T2 改造 client.js：loadAllCfgs + getLlmJson/Think 支持 name/strategy（round-robin/failover）"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  success: "getLlmJson({name:'x'}) 取指定条；getLlmJson({strategy:'round-robin'}) 在多条间轮询；无参仍取 default"
- task: "T3 配置中心 API：GET/POST/PUT/DELETE/set-default/test（写经第0闸）"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  success: "POST 新增→GET 列表出现；DELETE default 返回 400；set-default 切换唯一默认"
- task: "T4 前端 LLM 配置列表管理页（新增/编辑/删除/设默认/测试连通）"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  success: "页面渲染配置表格，点击测试连通显示 ok/err；ui-lint 通过"
- task: "T5 调用方适配：retro 跑批启用 round-robin + 单次重试；aiAttributes 取 default"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective]
  memory: [decision-retro]
  success: "runDecisionRetro 多配置轮询下 draft_patches>0（沙箱限流下仍出方案）；单配置降级语义不变"
```

**契约说明：** 五个任务均由 `decision-retro` 承接，调用 `decision-retrospective` SKILL、读取 `decision-retro` 记忆；T1 成功标准为新表存在且迁入默认配置并可回退，T2 成功标准为 `name`/`strategy` 选取生效且向后兼容，T3 成功标准为列表 CRUD 与默认唯一性守卫，T4 成功标准为列表管理 UI 与 ui-lint 通过，T5 成功标准为轮询下 `draft_patches>0`（直接验证 DRAFTS=0 已根治）。

## §7 风险与验证

- **风险**：SiliconFlow 限流无法根除，轮询/故障转移仅缓解；必要时叠加退避重试（已在 §5 含 1 次重试）。
- **验证**：
  1. `GET /api/config/llm` 返回多条且标明 `is_default`。
  2. `runDecisionRetro({dryRun:true})` 后 `draft_patches.length > 0`（沙箱限流下仍出方案）。
  3. `DELETE` 默认配置返回 400；`set-default` 切换后全局唯一默认。

## §8 闭环回写

| task | agent | gap_type | observed | expected | ts | severity |
|---|---|---|---|---|---|---|
| （待 workbench 监控回填） | | | | | | |

> 实施完成后由 agent-workbench 监控契约命中情况并回填上表；重复 gap ≥2 次触发 SKILL 改进提案（需用户批准）。
