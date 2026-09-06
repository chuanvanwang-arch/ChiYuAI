# 企业级容量设计：读写分离双池 + 角色分级限流 + SSE 双维过滤

- 日期：2026-08-28
- 背景：用户问「支持企业级应用吗，一个企业 2000 名销售如何支撑，目前有哪些缺失」→ 代码级评估结论：架构有企业级骨架（组织模型/数据范围闸/决策主轴/MCP/SSE），但缺 **P0 容量**（连接池 10、单进程、无限流、SSE 全量广播）。
- 本设计范围：**P0 三项**（连接池容量 / HTTP 限流 / SSE 组织+域过滤），采用用户确认的 **方案 B 分层完整版**（读写分离双池 + 角色分级限流 + SSE 双维过滤）。
- 评审状态：brainstorming 已确认全部决策点（见 §决策确认）。

## §1 决策确认（brainstorming 已批准）

| 决策点 | 用户选择 |
|---|---|
| 连接池 | **可配置 + 默认写 10 / 读 50**（环境变量可调） |
| 限流 | **IP 级滑动窗口 + 全局兜底**（60s/120 次 每 IP；60s/3000 次全局） |
| SSE 兜底 | **安全优先：未带 org 客户端不推业务事件**（仅心跳/connected） |
| 整体方案 | **方案 B 分层完整版**（读写池分离 + 角色分级 + SSE 双维） |
| 读写判定 | **显式 `queryWrite` 标记**（不自动探测 SQL 文本） |
| 字段命名 | SSE 事件 org 归属用 **`msg.org_id`**（与 payload.org_id 对齐） |
| IP 来源 | **`req.ip` 直连**（不引 trust proxy，多实例阶段再升级） |

## §2 目标与非目标

### 目标
- 支撑 2000 名销售在线规模：连接池容量提升 5 倍（读 50），请求限流防击穿，SSE 组织级数据隔离。
- 改动集中在 3 个文件 + 少量调用点标记，不破坏现有 398/398 测试基线。
- 新增 2 个测试文件覆盖容量/限流/SSE 过滤。

### 非目标（YAGNI，留待后续阶段）
- 多实例/集群部署（当前单进程架构）；
- 跨进程 SSE 路由（单进程无需）；
- 按组织「订阅持久化」到 DB（内存客户端表足够，容量可控）；
- P1 组织级 HTTP 数据隔离、用户生命周期、MCP 身份绑定（后续设计文档单独推进）。

## §3 架构总览

```
HTTP 请求 → rateLimit（IP 滑动窗口 + 全局兜底 + 角色配额） → auth 认证 → 角色注入 req.role
         → 路由 handler → queryRead（只读）/ queryWrite+withTx（写入）
SSE 连接  → connect(res, { org, domains }) → 内存客户端表（含 org_id/domains）
         → on('*') 按 client.org_subtree + client.domains 过滤 → 推帧（含 msg.org_id）
```

三层各自独立：
- **容量层**（db.js）：读写池分离，`queryWrite` 显式标记；
- **限流层**（新增 src/http/rateLimit.js）：IP 窗口 + 全局兜底 + 角色配额；
- **隔离层**（sse.js）：org_subtree + domain 双维过滤，安全兜底。

## §4 组件设计

### 4.1 容量层：src/db.js 读写分离

当前：`src/db.js:10` 单一 `pool`，`max: 10`（写死）。

改造：
```js
export const pool = new pg.Pool({ ...配置, max: Number(process.env.PGPOOL_MAX_WRITE || 10) });
export const poolRead = new pg.Pool({ ...同配置, max: Number(process.env.PGPOOL_MAX_READ || 50) });

export async function queryWrite(text, params = []) { return pool.query(text, params); }
export async function queryRead(text, params = []) { return poolRead.query(text, params); }
export async function withTx(fn) { /* 走写池 pool.connect() */ }
```

- **读取规则**：现有 `query()` 保留为「写意图判定失败时的读兜底」？——**不**。按用户确认：显式标记。`query()` 保留=读池（兼容既有只读调用）；写入调用点全部显式改 `queryWrite`。
- **判定**：grep 现有 `INSERT INTO|UPDATE |DELETE FROM` 命中文件（约 30 文件各自 1-6 处）逐一改 `queryWrite`（不自动探测）。
- **测试影响**：现有测试多用 `query()` 读接口，写调用改 `queryWrite` 后行为不变；需全量回归 398/398。

### 4.2 限流层：src/http/rateLimit.js（新增）

```js
// 内存滑动窗口：key → [{ts}...]，窗口 60s
// IP 级：60s/120 次（每 req.ip）
// 全局兜底：60s/3000 次（所有请求合计）
// 角色分级：认证后 req.role → sales 120/60s、manager/exec 200/60s、admin 不限（可 env 调）
export function createRateLimit({ windowMs = 60000, ipLimit = 120, globalLimit = 3000, roleLimits = {...} }) {
  return function rateLimitMw(req, res, next) { ... 429: {error:'rate_limited', retry_after} };
}
```

挂载：`routes.js` 内 `app.use('/api', createRateLimit(...))` + 认证中间件解析角色注入 `req.role`（复用 `auth.js:resolveMe`）。

**测试环境豁免**：`NODE_ENV=test` 时限流阈值放大 100 倍（IP 12000/60s、全局 300000/60s），避免现有 398 测试被限流误伤；生产默认值不变。

### 4.3 隔离层：src/events/sse.js 双维过滤

当前：`sse.js:24-33` 全量 `on('*')` 广播给所有客户端，无过滤。

改造：
```js
function connect(res, { org = null, domains = [] } = {}) {
  // 客户端表改为 { res, org, orgSubtree, domains }
  // org 为空 → 安全兜底：orgSubtree=[]（不推任何业务事件，仅 connected/heartbeat）
}

// on('*') 广播时：
// - 事件带 msg.org_id → 仅推给 client.orgSubtree.includes(msg.org_id)
// - 事件域 → 仅推给 client.domains.includes(msg.domain)（domains 空=只收全局事件）
// 心跳：setInterval 15s 发 heartbeat
```

路由对接：`routes.js:1050` `/events` 改为 `hub.connect(res, req.query)`（支持 `?org=xxx&domains=task,trace`）。

### 4.4 事件域归属补全（msg.org_id）

事件源在 `emit()` 时补 `org_id`：**缺省 null**。null 事件（全局/系统事件）只推给「未订阅组织的客户端」或「显式订阅全局的客户端」；带 org 事件只推给订阅该 org 子树的客户端。

- 需要补 org_id 的事件源：业务粒子写入（`particleRepo.js:35`）、决策事件（`decisionRepo`）、审批事件（`approval/engine`）、告警（`alerts`）。
- 本次范围：**先补关键事件源**（particle 写 / decision / audit），其余事件源（若 org_id 缺省）按安全兜底处理（不推组织事件）——避免大范围全改。

## §5 数据流（含失败路径）

1. 请求进入 → 限流（IP 窗口 / 全局 / 角色配额）→ 429 直接返回（前端可提示重试）；
2. 认证 → 角色注入；未认证角色缺省走「最低权限降级」（现有 auth 逻辑）；
3. 读：`queryRead`（读池 max 50）；写：显式 `queryWrite` + `withTx`（写池 max 10，满则排队，超时 503）；
4. SSE：客户端以 `?org=` 订阅 → 服务端 orgSubtree 过滤 → 事件推送；心跳 15s 防断。

## §6 错误处理与边界

- **429**：`{error:'rate_limited', retry_after}`，限流窗口内重试仍 429（防绕过）；
- **写池满**：503 `{error:'write_pool_exhausted'}`（写不降级，宁可失败不丢数据）；获取写连接超时 5000ms 视为满；
- **SSE 未带 org**：只收 connected/heartbeat 全局事件，不推任何业务数据（安全优先，防泄漏）；
- **SSE 过期/断开**：现有 `close` 清理逻辑已存在（sse.js:19），保留；
- **心跳**：15s；客户端 3 个心跳未回（45s）视为断开，清理（可配置）。

## §7 测试计划（TDD）

### 新增
1. `test/rateLimit.test.js`
   - IP 滑动窗口：超过 120/60s → 429；
   - 全局兜底：全局 3000 超过 → 429；
   - 角色分级：sales/manager/admin 不同配额；
   - 429 响应格式 `{error,retry_after}`；
   - 窗口滚动后恢复（不永久封禁）。
2. `test/sse-filter.test.js`
   - 带 org 订阅：只收子树事件，跨组织事件被过滤；
   - 不带 org：只收 connected/heartbeat，不收业务事件；
   - domains 过滤：只收订阅域事件；
   - 心跳帧存在；
   - 断开清理。

### 回归
- 全量 398/398（读写分离后写调用点改 `queryWrite`）；
- `test/http.test.js`、`test/e2e.test.js` 兼容限流中间件（测试请求放开或中间件检测 test 环境跳过?——**检测 `NODE_ENV=test` 时限流阈值放大**，避免测试被限流误伤）。

## §8 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/db.js` | 双向池（写 10/读 50，env 可调）+ `queryWrite`/`queryRead`；`query()` 保留=读池 |
| `src/http/rateLimit.js`（新） | 限流中间件（IP+全局+角色） |
| `src/http/routes.js` | `app.use('/api', rateLimit)`；`/events` 改 `hub.connect(res, req.query)`；认证→角色注入 |
| `src/events/sse.js` | connect 参数化（org/domains）+ 过滤广播 + 心跳；未带 org 安全兜底 |
| `src/particles/particleRepo.js` 等写调用点 | `query()` → `queryWrite()`（约 30 文件，仅写入调用） |
| 事件源文件（决策/审批/告警/粒子） | `emit` 时补 `org_id`（关键源先补） |
| `test/rateLimit.test.js`、`test/sse-filter.test.js`（新） | 新增测试 |

## §9 验收标准

- `node node_modules/vitest/vitest.mjs run` 全量 >= 398 且全绿（新增 2 文件后约 420+）；
- 新测试覆盖：429 限流、SSE 组织过滤、SSE 安全兜底、心跳；
- 读写分离后写路径（withTx/queryWrite）行为与既有一致（回归 e2e）；
- 环境变量生效：`PGPOOL_MAX_READ=80` 启动后读池 80（冒烟验证）。

## §10 后续（本次不做）

- P1：HTTP 数据接口组织级隔离（认证中间件 + 动态 org 过滤 + 用户生命周期管理）；
- P2：健康探针/指标采集/审计导出/部署文档；
- 多实例：读写池 + 跨进程 SSE 路由（本设计预留接口，不实现）。

---
*本设计文档依据：代码级证据（db.js:16 / sse.js:24-33 / routes.js:1050 / scope.js:41-51 / schema.sql 索引与表）。*