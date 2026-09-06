# MCP 凭证解析性能优化设计（O(n) 全表 crypt → O(1) 主键 + 单次 crypt）

- 日期：2026-09-01
- 状态：已批准（用户在分叉点选择「方案 A 结构化 token」+「存量策略 B 上线即强制重登录」）
- 范围：`src/mcp/auth.js`、`src/mcp/issueToken.js`、`db/`（无 DDL）、一次性迁移脚本
- 不在范围：HTTP session 鉴权、token 自动轮转、进程内缓存

---

## §1 问题与根因

### §1.1 现象

每次 MCP 工具调用（gateway phase1 / phase2）都要解析一次凭证，耗时随接入次数单调上升：

| 库 | `crm.mcp_identity` 行数 | 单次 `resolveIdentity` |
|---|---|---|
| 生产 `plm` | 110 | ≈ 500 ms |
| 测试 `plm_test` | 1301 | 4.6 s（命中）/ 5.9 s（未命中） |

已产生实际后果：`test/actions-sensitive-read.test.js` 中「crm-customer-360 → CONFIRM_REQUIRED」用例 **5023 ms 触发 5 s 超时**，同文件另一用例 4671 ms 险过。该失败是此根因的**症状**，不是独立问题。

### §1.2 根因（file:line）

`src/mcp/auth.js:22-26`：

```js
const r = await query(
  `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled
     FROM crm.mcp_identity WHERE token_hash = crypt($1, token_hash)`,
  [token]
);
```

`crypt($1, token_hash)` 以**每行的 token_hash 作为 salt**。PG 的 `token_hash` 上的 UNIQUE 索引对 `crypt($1, token_hash)` 这种「以列为参数」的表达式**不可用** → 退化为**全表顺序扫描**，并对每一行执行一次 blowfish crypt。

全库扫描确认：**该形态的查询仅此一处**（`grep -rn "crypt($1, token_hash)" src/` 唯一命中），改造面收敛。

实测（`tmp/_bench_mcp_auth.mjs`）：

```
db=plm_test  mcp_identity rows=1301
single crypt(bf,6)      = 6ms
single crypt(bf,8)      = 16ms
resolveIdentity(hit)    = 4637ms
resolveIdentity(miss)   = 5920ms
raw full-crypt-scan     = 6021ms
```

### §1.3 劣化机制

`issueToken` 每次 `crm_login` 插入一行；吊销走 `revoked_at` 软标记且**绝对禁删**（项目铁律）→ 行数只增不减 → 单次调用成本 ≈ `rows × 单行 crypt`，**线性劣化**。

---

## §2 目标与非目标

**目标**

1. 单次凭证解析由 O(n) 降为 O(1)（主键定位 + 单次 crypt）。
2. 消除「随登录次数线性劣化」的曲线。
3. 保持零信任语义：吊销 / 过期 / 禁用**即时生效**，不引入任何缓存延迟。

**非目标（YAGNI）**

- 不加进程内 token→identity 缓存：缓存期内已吊销 token 仍有效，触碰零信任红线；且首次调用仍要全表扫。
- 不改 token 熵强度（secret 维持 24 字节 = 192 bit）。
- 不做自动轮转、不动 HTTP session 鉴权路径。
- 不做任何 DDL / 生产 schema 变更。

---

## §3 方案权衡

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **A 结构化 token**（选定） | token 明文编入 identity_id：`crm_<id32>_<secret48>`；解析出 id → 主键查单行 → 单次 crypt | 明文 token 含 identity_id（AWS Access Key ID 同款实践；id 为随机 UUID 无业务语义，且整个串参与哈希防篡改） | ✅ 零 schema 变更、零 DDL |
| B prefix 列 + btree 索引 | 加 `token_prefix` 列 + 索引，按前缀查候选再校验 | 需 ALTER TABLE（生产写）；存量行只有哈希、**明文不可逆无法回填 prefix** → 同样必须全量重登录，却多付一次 DDL 与索引维护 | ❌ 代价更高、收益相同 |
| C 进程内 LRU 缓存 | token→identity 短期缓存 | 缓存期内已吊销 token 仍有效 → 安全红线；首次仍全表扫 | ❌ 否决 |

**存量凭证策略（三选一，用户选 B）**

| 策略 | 描述 | 结论 |
|---|---|---|
| A 双路径共存 | 旧 token 保留可用但走慢路径 | 需长期维护两套路径 |
| **B 上线即强制重登录**（选定） | 一次性软吊销全部存量行，格式闸直接拒旧格式 | ✅ 最干净；附带收益：旧格式 token **连库都不用查** |
| C 双路径 + 30 天观察期 | 兼顾平滑与终态 | 需额外过期策略配置与定时任务 |

---

## §4 设计

### §4.1 Token 格式

```
crm_<id32>_<secret48>
```

- `id32`：identity UUID 去横线（32 位 hex）
- `secret48`：`randomBytes(24).toString('hex')`（192 bit 熵，与改造前一致）
- 总长 85 字符；解析正则 `/^crm_([0-9a-f]{32})_([0-9a-f]{48})$/`
- **整个字符串参与 crypt**：若攻击者篡改 id 段，crypt 校验立即失败（id 段是哈希输入的一部分）
- 安全定位：类比 AWS Access Key ID（明文 key id 用于查表 + 秘密部分校验）；`identity_id` 是随机 UUID，不泄露业务语义；既有纪律「明文 token 永不出 node 进程到日志」已覆盖泄露面

### §4.2 格式单一事实源（`src/mcp/tokenFormat.js`，新增）

全库共有 **3 处**生成 token 明文（P1 探索确认，原设计只识别 2 处）：

| # | 位置 | 场景 |
|---|---|---|
| 1 | `src/mcp/auth.js:107` | `mcpLogin`（智能体用户名密码登录） |
| 2 | `src/mcp/issueToken.js:13` | `issueToken`（编程式颁发） |
| 3 | `src/portal/mcpIdentity.js:71` | 门户后台「MCP 身份」手动颁发 |

三处必须产出同一格式，否则解析侧要兼容多套 → 抽为单一事实源模块：

```js
// src/mcp/tokenFormat.js — token 明文格式单一事实源（颁发侧与解析侧共用）
import { randomUUID, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'crm';
export const TOKEN_RE = /^crm_([0-9a-f]{32})_([0-9a-f]{48})$/;

// 生成：显式返回 id，供 INSERT 时指定主键（避免先插后 UPDATE 回填）
export function newStructuredToken() {
  const id = randomUUID();
  const secret = randomBytes(24).toString('hex');
  return { id, tokenPlain: `${TOKEN_PREFIX}_${id.replace(/-/g, '')}_${secret}` };
}

// 解析：32 hex → 带横线 UUID；格式不符返回 null（调用方据此零 DB 查询直接降级）
export function parseTokenId(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
```

零循环依赖：`tokenFormat.js` 只依赖 `node:crypto`；颁发三处与解析一处（`auth.js`）均 import 它。

### §4.3 颁发路径（三处改造）

`db/schema.sql:381` 定义为 `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` —— `DEFAULT` 仅在**省略该列**时生效，因此可以显式指定 id。据此做到**单次 INSERT，无需 UPDATE 回填**：

```js
const { id, tokenPlain } = newStructuredToken();
// INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at)
//   SELECT $1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7
//   WHERE NOT EXISTS (SELECT 1 FROM crm.mcp_identity WHERE actor=$3 AND role_tag=$5 AND revoked_at IS NULL)
//   RETURNING id
// —— $2 传整个 tokenPlain（含前缀），使 id 段参与哈希，篡改即校验失败
```

三处改造要点：

| 位置 | 原形态 | 改造 |
|---|---|---|
| `issueToken.js:13` | `SELECT ... WHERE NOT EXISTS` 幂等插入 | 加 `id` 列 + `$1`，幂等分支逻辑不变 |
| `auth.js:111` | `VALUES (...)` 插入后软吊销同 actor 旧 token | 加 `id` 列；软吊销逻辑不变 |
| `portal/mcpIdentity.js:73` | `VALUES (...) RETURNING id, actor, ...` | 加 `id` 列；返回值增 `token_plaintext` 不变 |

> 注意：`token_hash` 上的 UNIQUE 约束保留（防重复颁发同一明文），新方案下它不再是查询路径。

### §4.4 解析路径（`src/mcp/auth.js:20 resolveIdentity`）— 三段式

```js
import { parseTokenId } from './tokenFormat.js';

// ① 格式闸：不匹配 → 直接 degraded，零 DB 查询（旧格式 token 在此被拒）
const id = parseTokenId(token);
if (!id) return mk(null, MCP_CONFIG.security.minPrivilegeFallback, true, '凭证格式无效：请重新 crm_login 领取新凭证', true);

// ②+③ 主键定位 + 单次 crypt 校验（一次往返）
const r = await query(
  `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at,
          (token_hash = crypt($2, token_hash)) AS tok_ok
     FROM crm.mcp_identity WHERE id = $1`,
  [id, token]
);
```

后续判定（顺序保持既有语义）：

| 条件 | 返回 |
|---|---|
| 无行 / `!tok_ok` | degraded：`未知 token：凭证未配置或已失效` |
| `revoked_at IS NOT NULL` | degraded：`token 已吊销` |
| `!enabled` | degraded：`token 已停用` |
| `expires_at < now()` | degraded：`token 已过期` |
| 通过 | 正常 ctx（含 `identity_id` / `person_id` / `scopes`） |

### §4.5 存量迁移（生产写，**执行前需显式授权**）

一次性脚本 `scripts/revoke-legacy-mcp-tokens.mjs`：

```sql
UPDATE crm.mcp_identity SET revoked_at = now() WHERE revoked_at IS NULL;
```

- 只打软标记，**绝对禁删**（项目铁律）
- 执行后全体接入方须重新 `crm_login` 领取新格式 token
- 回滚：`UPDATE crm.mcp_identity SET revoked_at = NULL WHERE revoked_at = <本次时间戳>`（数据无损失）
- 脚本须打印「迁移前行数 / 受影响行数 / 迁移后 revoked_at 非空行数」三元组供核对

### §4.6 兼容性

- 旧格式 token → 格式闸拒，返回 `gate:'auth_required'` + 文案「凭证格式已升级，请重新 crm_login」，**零 DB 开销**
- 新逻辑不读 `token_hash` 索引 → 存量行残留（禁删）不影响任何查询性能
- `resolveApiToken`（环境变量通道）与 `extractToken` 三源提取逻辑**不变**

---

## §5 任务分解（生命契约）

> 契约字段对齐 `src/agent/agentSpec.js`：`agent` 必须可在注册表解析；`skills ⊆ agent.skillCalls`；`memory ∈ agent.memory.read`；`knowledge_scope.layers ⊆ agent.knowledgeScope.layers`。
> 平台维护类任务借用 `followup-agent` 作为执行登记主体（注册表内最贴近「跟进/维护」语义的 agent）。

### T1 · 结构化 token 颁发

```contract-yaml
- task: "T1 结构化 token 颁发（issueToken）"
  contract_task_id: "ct-followup"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "issueToken 返回明文匹配 ^crm_[0-9a-f]{32}_[0-9a-f]{48}$，且库中该行 id 去横线后等于 token 中的 id32"
```

**契约说明：** 由 `followup-agent` 承接，调用 `data-particle-read` 读取凭证行核验；新增格式单一事实源模块，三处颁发点（mcpLogin / issueToken / 门户后台）统一产出结构化 token，改为显式指定 id 的单次 INSERT，明文格式可解析且库行可反查一致。

### T2 · 解析路径重构

```contract-yaml
- task: "T2 resolveIdentity 主键解析 + 单次 crypt"
  contract_task_id: "ct-followup"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "有效 token 解析 ≤50ms；格式不符 token 零 DB 查询；id 段被篡改的 token 返回 degraded"
```

**契约说明：** 三段式（格式闸 → 主键定位 → 单次校验）落地，旧全表扫描路径彻底移除，不再出现 `crypt($1, token_hash)` 形态的查询。

### T3 · 存量凭证一次性软吊销

```contract-yaml
- task: "T3 存量凭证一次性软吊销"
  contract_task_id: "ct-followup"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "count(revoked_at IS NULL) = 0，且 revoked_at 非空的行数等于迁移前行数（无物理删除）"
```

**契约说明：** 生产写操作，**执行前须显式授权**；只打软标记，不删任何行，脚本输出三元组供核对。

### T4 · 测试与基线同步

```contract-yaml
- task: "T4 凭证解析测试与基线同步"
  contract_task_id: "ct-followup"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "test/mcp 全绿；新增用例覆盖格式闸/命中/篡改 id/旧格式/性能门槛；actions-sensitive-read 5s 超时用例回归绿"
```

**契约说明：** 新增 `test/mcp/token-lookup.test.js`，并把此前被该根因拖超时的用例恢复为绿（不靠提超时，靠根因消除）。

### T5 · 回归与 before/after 性能实测

```contract-yaml
- task: "T5 全量回归与 before/after 性能对比"
  contract_task_id: "ct-followup"
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "test/mcp、test/http、test/assets、test/action 全绿；plm_test 1301 行下 resolveIdentity P95 ≤20ms（改造前 4.6s）"
```

**契约说明：** 复用 `tmp/_bench_mcp_auth.mjs` 做前后对比，并把实测数据回填本文档 §7。

---

## §6 风险与回滚

| 风险 | 等级 | 处置 |
|---|---|---|
| 明文 token 含 identity_id | 低 | AWS Access Key ID 同款实践；id 为随机 UUID 无业务语义；整个串参与哈希，篡改 id 立即校验失败；既有「明文不出进程」纪律覆盖日志面 |
| 全量重登录中断接入方 | 中（已接受） | 用户已选策略 B；格式闸返回明确重登录文案，接入方一次 `crm_login` 即恢复 |
| 迁移不可逆 | 低 | 只写 `revoked_at`，禁删；回滚即清空该列，数据零损失 |
| 并发颁发 id 冲突 | 极低 | `randomUUID()` 为 node 侧生成；主键约束兜底，冲突即报错不静默 |

---

## §7 验证与观测

| 指标 | 改造前（plm_test 1301–1319 行） | 目标 | **改造后实测** |
|---|---|---|---|
| `resolveIdentity` 命中 | 4637 ms | ≤ 20 ms | **5.66 ms**（提速 ~820×） |
| `resolveIdentity` 未命中 | 5920 ms | ≤ 20 ms | **0.00 ms**（格式闸直接拒绝，零 DB 查询） |
| 篡改 id 拒绝 | — | ≤ 20 ms | **0.00 ms**（主键查无行，单次往返） |
| SQL 形态 | `WHERE token_hash = crypt($1, token_hash)`（Seq Scan） | `WHERE id = $1`（Index Scan） | `Index Scan using mcp_identity_pkey`，无 Seq Scan |
| `test/actions-sensitive-read.test.js` | 1 例 5 s 超时 | 全绿 | **7/7 通过（115 ms）** |

验证手段与结果：

1. `tmp/_bench_token_after.mjs` 前后对比（200 次迭代均值，库 1319 行）：命中 5.66ms / 旧格式拒绝 0ms / 篡改 id 拒绝 0ms。
2. `EXPLAIN (ANALYZE)` 确认新查询走 `Index Scan using mcp_identity_pkey`，无 `Seq Scan on mcp_identity`（1319 行下 5.6 ms，其中约 5 ms 为唯一一次必需 crypt）。
3. 单元测试断言：格式不符 token 走零查询路径（`token-lookup.test.js` 7 例全绿，含「零 DB 查询」用例）。
4. 回归全绿：test/mcp 88/88、test/http 292/296（4 例为整套单进程跑的 seed 竞争伪失败，隔离重跑 9/9 绿）、test/action 66/66、test/agent+assets 43/43、particles+contract 51/51。

---

## 闭环回写

| 任务 | 缺口类型 | 观测 | 期望 | 严重度 | 时间 |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

> 由 `/agents` workbench 在运行时按任务写入；同一 `(task, gap_type)` 复现 ≥2 次时，下一轮 P0 产出 SKILL 改进提案（**需用户批准后方可改动任何 SKILL 文件**）。
