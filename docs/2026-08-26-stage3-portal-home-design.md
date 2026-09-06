# Stage 3 门户（index.html 替换 + Home.html 登录）设计文档 — 重新设计版 v2

> 状态：待批准（brainstorming → 设计 → writing-plans → 实现）
> 日期：2026-08-26（v2：① index.html 直接替换为 AI 作战室；② Home.html = 真实登录认证 + 旧卡片状态墙）
> 关联：docs/specs/2026-08-25-ai-native-crm-overall-design.md §8.7；docs/superpowers/plans/2026-08-25-stage3-l2c-business-closure.md（T3-9 / T3-12）

---

## §0 结论

门户文件结构两项变更（已与用户确认）：

1. **`index.html` 直接替换为 AI 作战室新门户**（Lightfield 主轴），旧 Stage1 观测看板不再保留为独立入口。
2. **`Home.html` = 不同用户/角色的真实登录页**，复用旧 `index.html` 的卡片（装配校验 / kanban 计数 / 最新粒子 / 审批情况）作为进入前的「系统状态墙」+ 角色选择/登录。

- 主导方向：**AI 作战室（Lightfield 式）** —— 顶部 copilot 命令栏为首要交互，今日优先英雄区，agent 驱动动作优先；Attio 仅作副骨架。
- **范围变化（v2 新增）**：真实登录认证需新增后端认证范围（§5），作为独立 Task E，略超原 T3-12，但由登录决策触发，必须落地。

---

## §1 信息架构（双页）

```
Home.html（登录/进入页，不同用户）
  ├─ 真实登录：用户名 + 密码 → POST /api/auth/login → token
  ├─ 系统状态墙（复用旧 index.html 卡片）：装配校验 / kanban 计数 / 最新粒子 / 审批情况
  └─ 登录成功 → 写入 token → 跳转 index.html（按角色自适应）

index.html（AI 作战室，受 token 保护）
  ├─ 顶部 copilot 命令栏（⌘K，NL→动作）
  ├─ 今日优先（英雄区，FIT/TIMING/CONN 打分 + 怎么切入）
  ├─ L2C 六段主线（紧凑副区）
  ├─ 审批收件箱（HITL 四域）
  └─ SSE 实时流（折叠）
```

**设计原则（宪法级，来自 Lightfield）**：
1. 门户是「智能层」不是「数据浏览器」——英雄区是 AI 推送的「该做什么」。
2. 从洞察到行动**同面跳转**——优先级卡 CTA 注入 copilot。
3. **零手工录入、自动捕获**——门户只读 + agent 驱动；唯一写 = 池规则 `PUT`。
4. copilot 命令栏是首要入口，NL 一句生成动作/页面（对接 `POST /api/page/from-nl`）。

---

## §2 Lightfield 四范式 → 落地映射

| # | Lightfield 范式 | 本门户落地 | 端点/证据 |
|---|----------------|-----------|----------|
| ① | 今日优先：fit/timing/connection 打分 + 怎么切入 | 英雄区 3 卡，三维度分（纯函数）+ CTA | `/api/business/board`(routes.js:137) + `/api/monitor/decisions`(routes.js:220) + §6 算法 |
| ② | 自然语言命令栏 copilot | 顶部 ⌘K，NL→`POST /api/page/from-nl` | routes.js:157 `createPageFromNl` |
| ③ | 洞察→行动同面跳转 | 优先级卡 CTA 注入命令栏 | 同 ② |
| ④ | 零手工录入 / 自动捕获 | 门户只读 + agent 驱动；唯一写 = 池规则 PUT | `PUT /api/pool-config`(routes.js:124) + `/events` SSE(routes.js:203) |

---

## §3 数据契约（真实端点，file:line 取证）

| 用途 | 端点 | 证据 | 形态 |
|------|------|------|------|
| 业务看板 | `GET /api/business/board` | routes.js:137 | `{grouped,total}` |
| 池配置读写 | `GET/PUT /api/pool-config` | routes.js:116/124 | `{pick_rule,recycle_rule,...}` |
| 实时健康 | `GET /api/realtime/health` | routes.js:111 | `{ok,checks}` |
| SSE | `GET /events` | routes.js:203 | 5 域 |
| copilot | `POST /api/page/from-nl` | routes.js:157 | `{nl}`→`{page_id,schema,confidence,previewHtml}` |
| 决策列表 | `GET /api/monitor/decisions` | routes.js:220 | `{items}` |
| 销售闸门 | `GET /api/monitor/gates` | routes.js:206 | `{gates}` |
| **登录（新增）** | `POST /api/auth/login` | §5 新增 | `{username,password}`→`{token,role,display_name}` |
| **当前用户（新增）** | `GET /api/auth/me` | §5 新增 | `Authorization: Bearer`→`{role,display_name}` |
| 记录详情 | `src/web/particle-detail.html` | 既有 | 点击跳转 |

---

## §4 组件规格

### 4.0 Home.html — 登录 + 状态墙（v2 新增）
- **真实登录**：用户名 + 密码表单 → `POST /api/auth/login` → 存 token 到 localStorage → 跳 `index.html`。
- **系统状态墙**（复用旧 `index.html` 卡片，只读展示）：
  - 装配校验（调用既有装配断言，原 Stage1 卡片逻辑迁移）
  - kanban 计数（任务/worker 状态）
  - 最新 10 粒子（来自 `/api/business/board` 或既有粒子查询）
  - 审批情况概览（四域待审数，降级自 board）
- 角色提示：登录账号绑定角色（sales/manager/exec/finance/contract_admin/presales），供 index.html 自适应。

### 4.1 copilot 命令栏（主轴交互）
- `POST /api/page/from-nl` → `previewHtml` + `confidence`；命令栏下方展开生成预览卡。
- `⌘K`/`Ctrl+K` 聚焦；空输入展示示例 chip。
- 降级：fetch 失败提示离线。

### 4.2 今日优先（英雄区）
- 数据源 `/api/business/board` 的 `CRM_DEAL` + `/api/monitor/decisions` 关联计数。
- 每卡：名、`l2c_stage` 徽标、FIT/TIMING/CONN 微型条、怎么切入、CTA（注入命令栏）。
- 排序：综合 = 0.3·FIT + 0.4·TIMING + 0.3·CONN。

### 4.3 L2C 六段主线（紧凑）
- 线索→报价→合同→回款→发票→订单，计数来自 board grouped。

### 4.4 审批收件箱（HITL 四域）
- 数据源：`GET /api/approvals/pending`（§7 新增）或降级自 board 筛 `status='submitted'`。

### 4.5 SSE 实时流（折叠）
- `EventSource('/events')`，最新 10 条，新事件脉冲 3s。

### 4.6 角色自适应（index.html）
- 读取 `/api/auth/me` 的 `role` → 调整今日优先默认权重 / 可见区块（exec 看经营、finance 看回款/发票、sales 看商机）。复用 `src/agent/roleProfiles.js` 角色定义。

---

## §5 认证后端设计（v2 新增，Task E）

**范围**：真实用户名/密码登录，最小可行、不引入重依赖。

- **表 `crm.crm_users`**：`user_id uuid PK, username text UNIQUE, password_hash text (pgcrypto crypt), role text, display_name text, org_id text, created_at`。
- **种子**：5–6 角色各 1 演示账号（如 `sales/manager/exec/finance/contract_admin/presales`，初始密码统一 `crm123!`，首次登录可改 —— 首版可不做改密）。
- **`POST /api/auth/login`**：`SELECT ... WHERE username=$1` → `crypt($2, password_hash)=password_hash` 校验 → 成功返回 `token`（`base64url(header.payload)` + HMAC-SHA256 签名，密钥取 `process.env.PORTAL_JWT_SECRET` 或固定 salt，纯 `crypto` 无需 jwt 库）。
- **`GET /api/auth/me`**：校验 `Authorization: Bearer`，返回 `{role, display_name}`；失败 401。
- **保护**：`index.html` 启动读 localStorage token，无则跳 `Home.html`；fetch 携带 `Authorization` 头。
- **登出**：清 token，回 `Home.html`。
- **安全阀**：密码用 `pgcrypto.crypt` 哈希，明文不入日志。

---

## §6 「今日优先」打分启发式（纯函数，前端）

```js
function scoreDeal(d, decisions){
  const idleDays=(Date.now()-new Date(d.updated_at||Date.now()))/86400000;
  const FIT=clamp((d.budget_fit??0.5)*100);
  const TIMING=clamp(100-idleDays*4);
  const CONN=clamp((decisions.length/5)*100);
  const total=0.3*FIT+0.4*TIMING+0.3*CONN;
  return {FIT,TIMING,CONN,total,idleDays};
}
```
`suggestAction`：idle>30→唤醒邮件；stage=报价且 idle>3→推进合同；CONN<40→高层拜访。

---

## §7 需新增端点（3 个，均有降级）

| 端点 | 用途 | 降级 |
|------|------|------|
| `POST /api/auth/login` | 真实登录 | 无（必做，Task E） |
| `GET /api/auth/me` | 角色自适应 | 无（必做，Task E） |
| `GET /api/alerts/active` | TIMING 活跃告警 | 首版 TIMING 用 idle 天数 |
| `GET /api/approvals/pending` | 审批收件箱 | 首版 board 筛 `submitted` |

---

## §8 风险与对策

| 风险 | 对策 |
|------|------|
| 认证超出 T3 范围 | 最小可行（pgcrypto + HMAC），独立 Task E，不拖业务闭环 |
| alertRegistry 未持久化活跃告警 | TIMING 用 idle 天数，端点后置 |
| `createPageFromNl` 可能 `needsClarification` | 命令栏展示澄清提示 |
| SSE 跨页连接 | 离页 `es.close()` |
| token 密钥 | 取 env，缺省固定 salt 仅本地 |

---

## §9 实施拆分（待批准后在 writing-plans 展开）

- **Task A**：`Home.html` 登录页 + 系统状态墙（复用旧卡片：装配/kanban/最新粒子/审批概览）+ 跳 index.html
- **Task B**：认证后端 — `crm_users` 表 + 种子 + `POST /api/auth/login` + `GET /api/auth/me` + token 校验（`src/http/auth.js` + routes 挂载）
- **Task C**：`index.html` 替换为 AI 作战室骨架 + copilot 命令栏（接 `/api/page/from-nl`）+ token 保护/角色自适应
- **Task D**：今日优先英雄区 + §6 打分（接 board + decisions）
- **Task E**：L2C 主线 + 审批收件箱（降级）+ SSE 流
- **Task F**：池配置读写面板（接 pool-config）+ 双页互链（登录/登出）+ 提交

---

## §10 自查
- 无占位符、无矛盾、范围明确（v2 新增认证 Task B，双页结构已确认）。
- 主数据通道对接真实端点（§3 file:line），非文档臆测。
- 与 T3-9/T3-12 一致：门户层容器，业务功能不新开页。
