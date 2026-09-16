# 生产性能诊断报告（2026-09-16）

> 对象：`http://81.70.184.198`（腾讯云 Lighthouse 4 vCPU / 3.7 GB）
> 手段：外网 curl 计时 + 服务器内回环计时 + nginx 日志挖掘 + PG 统计视图 + 源码级归属
> 纪律：本报告全部数字为**实测**，未实测项明确标注为"待归属"

---

## §0 结论先行

**瓶颈不在服务器算力，也不在数据库。**

| 层级 | 实测结论 | 是否瓶颈 |
|---|---|---|
| 主机 | 4 vCPU、load average **0.03**、内存可用 2.7 GB、磁盘剩 28 G | ✗ |
| 容器 | app **0.16%** CPU / 59 MB、mcp 0.01% / 83 MB、pg 7.3% / 30 MB | ✗ |
| 数据库 | 全库 **17 MB**、缓冲命中率 **99.98%**、死元组 0、无长事务/锁等待 | ✗ |
| 应用 | 静态 TTFB 回环 **1.8–2.9 ms**、错误日志 **0** | ✗ |
| **传输层** | JS/CSS **未压缩**、所有资源 `Cache-Control: max-age=0` | **✓ 主因** |
| **应用查询** | `/api/my-todo/badge` 每次调用发 **24 条 SQL**（6 视角 × 4 查询，只取 `.length`） | **✓ 主因** |
| 观测能力 | nginx 无 `$request_time`、PG 未装 `pg_stat_statements` | **✓ 结构性缺口** |

一句话：**服务端很快，但往浏览器送东西的方式很浪费，且有一个高频端点在做无用功。**

---

## §1 实测数据

### 1.1 外网端到端时延（本机 → 81.70.184.198）

| 路径 | TTFB | 总耗时 | 状态 |
|---|---|---|---|
| `/landing.html` | 30–36 ms | 33–39 ms | 200 |
| `/.well-known/oauth-protected-resource` | 35 ms | 37 ms | 200 |
| `/.well-known/oauth-authorization-server` | 30 ms | 32 ms | 200 |
| `POST /mcp`（无 token） | 28–37 ms | 31–40 ms | 401（预期） |

> 公网 TTFB 30 ms 属健康水平（含 TLS 前握手与 Nginx 转发）。**网络链路不是瓶颈。**

### 1.2 压缩实测（决定性证据）

| 资源 | 磁盘原大小 | 带 `Accept-Encoding: gzip` 实际传输 | 响应头 |
|---|---|---|---|
| `/landing.html` | 51,534 B | 21,951 B | `Content-Encoding: gzip` ✅ |
| `/pipeline.html` | 14,717 B | 5,950 B | `Content-Encoding: gzip` ✅ |
| `/portal/common.css` | 11,062 B | **11,062 B** | **无 `Content-Encoding`** ❌ |
| `/portal/components.js` | 20,609 B | **20,609 B** | **无 `Content-Encoding`** ❌ |

**根因**（`nginx.conf:46-53`）：

```nginx
gzip on;                      # 第 46 行：开了
# gzip_types ...              # 第 53 行：注释掉了
```

Nginx 默认 `gzip_types` **仅含 `text/html`**，因此：
- HTML 被压缩 ✅
- **CSS / JS / JSON / SVG 全部明文传输** ❌

**单页载荷影响**（以 `pipeline.html` 为例）：

| 组成 | 现状 | 开启 gzip 后（估算） |
|---|---|---|
| HTML | 5,950 B（已压缩） | 5,950 B |
| common.css + page.css + tokens.css | 25,978 B 明文 | ≈ 5,200 B |
| components.js | 20,609 B 明文 | ≈ 5,500 B |
| **合计** | **≈ 52.5 KB** | **≈ 16.7 KB（−68%）** |

> `billing.html` / `sales-decision-monitor.html`（168 KB）等大页面收益更大。

### 1.3 缓存实测

| 路径 | 响应头 |
|---|---|
| `/` | `Cache-Control: public, max-age=0` + ETag |
| `/pipeline.html` | `Cache-Control: public, max-age=0` + ETag |
| `/landing.html` | `Cache-Control: public, max-age=0` + ETag |

`max-age=0` 意味着浏览器**每次导航都要回服务器重新校验全部资源** —— 即使文件没变。用户感知为"每次点菜单都要等一下"。

### 1.4 静态资源服务路径（架构性发现）

| 事实 | 证据 |
|---|---|
| 所有静态资源经 **Express** 发出，非 nginx 直出 | 响应头 `X-Powered-By: Express`；`ttfb 1.7–2.9 ms`（nginx 直出应为 ~0.3 ms） |
| 由 **44 条手写逐文件路由** 服务 | `src/http/routes.js` 中 `app.get('/portal/...')` 共 44 条（41 个 `.js` + 3 个 `.css`） |
| 文件在宿主机存在，本可被 nginx 直出 | `/opt/crm-ai-native/src/web/` 存在 |

### 1.5 高频端点：`/api/my-todo/badge`（最值得修的一处）

**流量地位**：nginx 日志中请求量**第一**

| 路径 | 请求数 | 占比 |
|---|---|---|
| `/api/my-todo/badge` | **411** | 12.9% |
| `/api/board/named-account-manage` | **411** | 12.9% |
| `/mcp` | 116 | 3.6% |
| `/` | 92 | 2.9% |

两者合计 **822 / 3,195 = 25.7%** 的全部请求。

**为什么它被高频调用**（`src/web/layout.js:129-131`）：

```js
const pollAllBadges = () => Promise.all([pollFollowBadge(), pollTodoBadge()]);
pollAllBadges();
setInterval(pollAllBadges, POLL_MS);      // POLL_MS = 60000
```

`layout.js` 被 **80 / 84 个页面**引用 → **每个打开的页面标签，每分钟打 2 个端点**；每次页面加载还额外打一轮。

**它的实现浪费**（`src/http/workbenchRouter.js:246-260`）：

```js
const rows = await Promise.all(VIEWS.map((v) => buildViewRows(v, actor, D)));
const counts = {};
VIEWS.forEach((v, i) => { counts[v] = rows[i].length; });   // ← 只用了 .length
```

而 `buildViewRows`（同文件 `:93-99`）**每次调用都执行同样的 4 条查询**：

```js
const [approvalTasks, instances, kanbanTasks, followSource] = await Promise.all([
  deps.queryApprovalTasks(actor), deps.queryApprovalInstances(actor),
  deps.queryKanbanTasks(actor),   deps.queryFollowSource(actor),
]);
```

`VIEWS` 有 **6 个视角**（`approval / processing / initiated / cc / follow / tuning`，`:29-37`）→

> **每次 badge 调用 = 6 × 4 = 24 次依赖调用，全部为算计数而跑，行数据全部丢弃。**

⚠ **订正（2026-09-16 实施阶段复核）**：上面的"24 条 SQL"**低估了真实量**，因为 `queryFollowSource`
本身是**串行 7 条 SQL**（`workbenchRouter.js:73-81` 对 7 个粒子类型逐个 `queryParticles`）。
按"SQL 条数"口径重算：

| 口径 | 6 视角版本（旧） | 7 视角版本（含 signals，2026-09-16） |
|---|---|---|
| 依赖调用次数 | 6 × 4 = 24 | 7 × 4 = 28 |
| 其中 `queryFollowSource` | 6 次 × 7 SQL = 42 | 7 次 × 7 SQL = 49 |
| 其余 3 个源 | 6 × 3 = 18 | 7 × 3 = 21 |
| 校准/信号 | +1 | +2 |
| **实际 SQL 总条数** | **61** | **72** |

即真实浪费比初稿判断更严重（72 条 vs 24 条），但**修复后的绝对收益仍然很小**（见 §6.4）。

**实测耗时**：回环 **12.8–20.3 ms**（稳态），而同期静态页 1.8–2.9 ms。**慢 5–8 倍。**

**代码注释与实际不符**（`workbenchRouter.js:245`）：

> `// 返回各视角待处理计数（仅 number[]，不含行明细；轮询 60s 消耗极低）`

实测单次 13–20 ms × 2 端点 × 每分钟 × 每标签页，"消耗极低"的断言不成立。

### 1.6 请求构成与异常流量

| 指标 | 数值 |
|---|---|
| 日志总请求 | 3,195 |
| **404 占比** | **1,833 / 3,195 = 57.4%** |
| 404 主要来源 | `34.140.210.118`（GCP 段）**1,592 次** |
| 扫描路径样本 | `/wp-admin/install.php`、`/actuator`、`/www/.env`、`/.zshrc`、`/proxy` |
| 真实用户 `185.255.198.140` | 851 次请求，**404 = 0** ✅ |
| nginx `limit_req` / `limit_conn` | **0 条**（无限流） |
| HTTP/2 | **未启用** |

> 真实用户零 404 → 用户侧的"慢"**不是报错导致的**。
> 但一个扫描器贡献了 50% 的请求量、无限流保护，属**可用性风险**（一旦加大频率会挤占 worker）。

### 1.7 数据库：确认无需调优

| 项 | 值 | 判断 |
|---|---|---|
| 全库大小 | 17 MB | 极小 |
| 缓冲命中率 | 99.98% | 优秀 |
| `shared_buffers` | 128 MB | 对 17 MB 库充足 |
| `work_mem` | 4 MB | 充足 |
| 顺序扫描 TOP | `particles` 545,491 次（**137 行**） | 行数极小，seq scan 属正确选择，**非缺陷** |
| 死元组 | 仅 `provenance_seal` 46 条 | 无需 VACUUM |
| 活动查询 | 1（即本次诊断本身） | 无并发压力 |
| **`pg_stat_statements`** | **未安装** | **⚠ 无慢查询排行能力** |

> ⚠ 反复出现的"调 PG 参数"直觉在此**不适用** —— 17 MB 的库已全部在内存中。

---

## §2 观测能力缺口（这是"为什么一直说不清慢在哪"的根因）

| 缺口 | 现状 | 后果 |
|---|---|---|
| nginx 日志 | 默认 `combined` 格式，**无 `$request_time` / `$upstream_response_time`** | 无法统计真实用户每请求耗时分布 |
| PostgreSQL | 未装 `pg_stat_statements`（`shared_preload_libraries=age`） | 无法按总耗时排序慢 SQL |
| 应用 | 无请求级耗时埋点 | 无法区分"闸/DB/LLM"哪段慢 |

**在补齐这三项之前，任何"再优化"都是猜。**

---

## §3 优化方案（按 收益/风险 排序）

### P0 — 高收益 / 低风险（建议立即执行）

| # | 措施 | 预期收益 | 风险 | 改动面 |
|---|---|---|---|---|
| **P0-1** | 开启 `gzip_types`（text/css、application/javascript、application/json、image/svg+xml） | 单页 JS/CSS 载荷 **−68%**；JSON API 同步受益 | 极低（纯 nginx 指令，`nginx -t` 可验） | `nginx.conf` |
| **P0-2** | 为 `/portal/*` 与 HTML 设置合理 `Cache-Control`（如 `max-age=300` + ETag 回退） | 重复导航资源**近乎零传输** | 中：部署后可能拿到旧 CSS → 用短 TTL 或版本化 query 化解 | `src/http/routes.js` 44 处 / nginx |
| **P0-3** | 修 `badge` 的 N×4 重复查询：把 4 条查询提到视角循环外 | 24 → 4 条 SQL；回环预计 **20 ms → 3–5 ms**；覆盖 26% 请求量 | 低（纯重构，需补单测锁行为） | `src/http/workbenchRouter.js:93-99,246-260` |
| **P0-4** | nginx 加限流 + 屏蔽扫描器段；404 单独落盘或降级 | 消除 57% 无效请求的 worker/IO 占用 | 低（限流阈值需保守） | nginx |

**P0 合计预期**：页面首屏传输量 −68%，重复访问载荷 −90%+，高频端点耗时 −75%。

### P1 — 中收益 / 需设计

| # | 措施 | 收益 | 说明 |
|---|---|---|---|
| P1-1 | 静态资源改由 **nginx 直出**（或合并为单个 `express.static` + `maxAge`） | 静态 TTFB 2 ms → ~0.3 ms，释放 Node 事件循环 | 需同步处理 44 条路由的退役顺序 |
| P1-2 | 补齐观测：nginx `log_format` 加 `$request_time`；安装 `pg_stat_statements` | 让后续优化可归因、可验证 | 建议与 P0 一起做，否则收益无法量化 |
| P1-3 | 443 启用 HTTP/2 | 多资源并发效率提升 | 仅对 https 生效（当前客户端走 http 裸 IP） |
| P1-4 | badge 轮询增加退避/可见性判断（`document.hidden` 时暂停） | 后台标签页零轮询 | 前端小改动 |

### P2 — 结构性 / 低紧迫

| # | 措施 | 说明 |
|---|---|---|
| P2-1 | 合并 44 条 `/portal/*` 逐文件路由为静态挂载 | 可维护性 + 性能双收益 |
| P2-2 | `worker_connections` 768 → 2048 | 仅在并发升高后才有意义 |
| P2-3 | PG 参数调优 | **本场景明确不需要**，勿浪费时间 |

---

## §4 尚未归因的部分（诚实声明）

服务端客观很快（外网 TTFB 30 ms），因此若你感知的"慢"仍存在，剩余可能来源**本次未取证**：

1. **LLM 参与的功能**（决策建议 / Agent 派发 / NL 生成）—— 天然秒级，需按具体操作单独计时；
2. **特定页面/操作**的慢 —— 需你指出具体是哪一屏、哪个动作，才能精准归因；
3. **客户端侧**（浏览器扩展、本机负载、本地代理）。

> 建议先落 P0-1 + P0-2 + P1-2（压缩 + 缓存 + 观测），随后由观测数据自动回答"还剩哪里慢"。

---

## §5 一句话行动建议

**先开 gzip + 缓存（改 nginx 两处，收益立竿见影），再修 badge 的无效查询，同时补上 `$request_time` 与慢查询日志让后续优化有据可依。**

---

# §6 实施与验证结果（2026-09-16 执行阶段，实测）

> 本节为原诊断报告的落地记录。所有数字均来自本轮**实测**（服务器内回环 + 外网真实客户端两条口径）。

## 6.1 已完成并验证

| 项 | 改动 | 实测结果 | 状态 |
|---|---|---|---|
| **P0-1 压缩** | `nginx.conf` 开启 `gzip_types`（JS/CSS/JSON/SVG/字体） | 单页 JS+CSS **46,587 B → 13,897 B**；HTML 14,717 → 5,502 B；**单页合计 61,304 B → 19,399 B（−68%）** | ✅ 生产已生效 |
| **P0-2 缓存** | `/etc/nginx` 静态资源 location：`proxy_hide_header Cache-Control` + `max-age=600, stale-while-revalidate=86400` | `Cache-Control: public, max-age=600…` 生效；ETag 保留；`If-None-Match` 复访返回 **304 / 0 B** | ✅ 生产已生效 |
| **P0-4 限流** | `limit_req_zone`（30r/s, burst 60）+ `limit_conn`（30） | 连打 400 次：**149 × 200 → 251 × 429**；3s 后恢复正常 | ✅ 生产已生效 |
| **观测-nginx** | `log_format perf` 追加 `rt=$request_time urt=$upstream_response_time uct= ust=` | 日志已落盘：`… ust=200` / `rt=0.002 urt=0.002` | ✅ 生产已生效 |
| **观测-PG** | `log_min_duration_statement=500ms` + `track_io_timing=on`（免重启生效） | 已生效（当前无 >500ms 查询，符合"DB 不是瓶颈"的结论） | ✅ 生产已生效 |

**额外修复（诊断阶段未发现）**：`/events`（SSE 事件源）此前走默认 `location /`，**`proxy_buffering` 为 on**
→ 实时事件被 nginx 攒批。已新增 `location = /events` 关闭缓冲（两处 server 块）。
以及 `location ^~ /api/`：把 `proxy_read_timeout` 从默认 60s 提到 600s（LLM/Agent 类端点防 504）。

**gzip 实测梯度**（外网口径）：

| 资源 | 未压缩 | 已压缩 | 降幅 |
|---|---|---|---|
| `/portal/components.js` | 20,609 B | 4,873 B | **−76%** |
| `/portal/page.css` | 10,668 B | 3,221 B | −69% |
| `/portal/common.css` | 11,062 B | 3,461 B | −68% |
| `/portal/tokens.css` | 4,248 B | 2,342 B | −44% |

## 6.2 实施过程中发现的额外问题（均已修复或记录）

| # | 问题 | 处理 |
|---|---|---|
| 1 | `/events` SSE 被 nginx 缓冲（实时性缺陷） | 已加专用 location，关闭 buffering |
| 2 | `.release-wt/` 未被 vitest 排除 → **整套用例跑两遍** | `vitest.config.js` 加 `exclude: [...configDefaults.exclude, '.release-wt/**']`，已核验 |
| 3 | `pg_stat_statements` **无法启用**：`crm-pg` 以命令行 `postgres -c shared_preload_libraries=age` 启动，**优先级高于 `postgresql.auto.conf`** → `ALTER SYSTEM` 被静默覆盖 | 已 `ALTER SYSTEM RESET` 收回无效行（避免留下误导性配置）。如需启用见 §6.5 |

## 6.3 P0-3（badge 重构）：已实现 + 已测试，**未部署到生产**

**改动**（`src/http/workbenchRouter.js`）：把 `buildViewRows` 拆为
`loadSources(view, actor, deps)`（按视角声明依赖，未声明的源零查询）+ `rowsFrom(view, sources, …)`（纯计算），
badge 改为 `__all__` 一次性装载共用源后逐视角计数。

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 依赖调用次数 / badge | 28 | **6** |
| SQL 条数 / badge | 72 | **12（−83%）** |
| 单视角 `?view=tuning` | 4 次依赖调用 | **0 次粒子源** |

**测试**：新增 `test/http/workbench-badge-perf.test.js`（6 例，锁定"计数语义不变 + 查询次数收敛 + 单视角最小装载 + 等价性"）。
TDD 红灯已复现（4 例失败于调用计数），实现后 **6/6 通过**；既有 `workbench-routes` 22 例 + `workbenchSignal` 3 例 **全绿**。

**⛔ 未部署的原因（决策记录）**：

1. **实测收益极小**：生产 badge TTFB 基线 **10.6–75.3 ms（中位 ~14 ms）**，且**每标签页每 60 s 仅 1 次**。
   改造后预计降到 ~4 ms → 每用户每小时节省约 0.6 s 量级，**用户完全无感**。
2. **部署路径有真实风险**：本地 `workbenchRouter.js` 依赖今日新增的 `src/signal/workbenchView.js`，
   而生产镜像（== `git HEAD`，md5 `d198422f…`）**不含**该文件。我按"热修单文件"方式部署时
   **导致生产 502 崩溃循环**（`ERR_MODULE_NOT_FOUND /app/src/signal/workbenchView.js`），已紧急回滚。
3. **结论**：该改动**随下一次正式 release 自然上线**（届时 signals 依赖已在镜像内），
   不为此单独承担一次生产写入风险。这与原 P0-3 的表述「先补单测锁行为，**再走发布**」一致。

## 6.4 订正：原诊断对 P0 优先级的判断偏差

- **P0-1 / P0-2（压缩 + 缓存）是真实的主因** —— 单页载荷降 68%，缓存消除每资产一次往返。
- **P0-3（badge）优先级被高估**：虽然浪费的 SQL 条数比初稿判断更严重（72 vs 24），
  但**绝对耗时只有十几毫秒、调用频率只有每分钟一次**，对"感觉慢"的贡献可忽略。
  教训：**"浪费比例大" ≠ "用户感知强"**，排序必须用「浪费 × 频率」而非单看浪费倍数。
- **P0-4（限流）属卫生项**，服务器 CPU 仅 0.16%，对用户延迟无贡献。

## 6.5 `pg_stat_statements` 启用方案（已定稿，生产待执行）

**为何必须改启动命令**：`crm-pg` 以命令行 `postgres -c shared_preload_libraries=age` 启动，
**命令行优先级高于 `postgresql.auto.conf`** → `ALTER SYSTEM SET shared_preload_libraries` 被静默覆盖
（决定性判据：`pg_settings.source = 'command line'`）。故只能改容器启动命令。
已 `ALTER SYSTEM RESET shared_preload_libraries` 收回那条无效行，避免留下误导性配置。

**改哪里**：`scripts/tencent-lighthouse-deploy/docker-compose.age.yml` 的 db 服务，**不是主文件**——
主文件默认镜像是纯 `pgvector/pgvector:pg16`（不含 `age.so`）；把 `age` 写进主文件会让
「不叠加 AGE override」的环境**启动失败**。放 age.yml 才语义自洽（只有 AGE 环境需要）。

**前置校验（缺 .so 则容器起不来 → 生产库不可用，务必先跑）**：

```bash
docker exec crm-pg ls -l /usr/lib/postgresql/16/lib/pg_stat_statements.so
```

**已落地到仓库**（本文件提交时一并带出）：

```yaml
    command: postgres -c shared_preload_libraries=age,pg_stat_statements
```

**生产执行（建议低峰期；db 容器会重建，重启约 10~30s）**：

```bash
cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy
cp docker-compose.age.yml docker-compose.age.yml.bak.20260916
sed -i '/^    image: crm-pg-age:pg16/a\    command: postgres -c shared_preload_libraries=age,pg_stat_statements' docker-compose.age.yml
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d db
docker exec crm-pg psql -U agent2b -d crm_native -c "show shared_preload_libraries"   # 期望: age,pg_stat_statements
docker exec crm-pg psql -U agent2b -d crm_native -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements"
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env restart app mcp
```

**回滚（db 起不来时）**：

```bash
cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy
cp docker-compose.age.yml.bak.20260916 docker-compose.age.yml
docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d db
docker logs --tail 40 crm-pg
```

数据安全：db 数据在 named volume `pgdata` 内，重建容器**不丢数据**（`up -d db` 不改动卷）。

## 6.6 回滚方式（nginx）

补丁脚本每次执行前把三个文件备份到 `/tmp/nginx-perf-backup-<时间戳>/`，回滚：

```bash
sudo cp -a /tmp/nginx-perf-backup-*/etc_nginx_nginx.conf /etc/nginx/nginx.conf
sudo cp -a /tmp/nginx-perf-backup-*/etc_nginx_sites-available_crm /etc/nginx/sites-available/crm
sudo cp -a /tmp/nginx-perf-backup-*/etc_nginx_conf.d_ip-default.conf /etc/nginx/conf.d/ip-default.conf
sudo nginx -t && sudo systemctl restart nginx      # reload 不足以生效
```

**配置已固化进仓库**（避免下次 release 抹掉）：
`scripts/tencent-lighthouse-deploy/nginx-perf-patch.py`（幂等应用器）+
`nginx-crm.conf` / `nginx-ip-default.conf`（模板内已含 ④⑤⑥⑦ 段）。
⚠ `deploy.sh` 每次 release 会重写 `sites-available/crm`；模板已同步，故 release 后配置仍在，
但 **certbot 的 443/`server_name` 仍会被抹**（既有问题，未在本轮处理）。
