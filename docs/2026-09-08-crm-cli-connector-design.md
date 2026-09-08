# crm-cli 连接器设计（最小验证链路）

- 日期：2026-09-08
- 状态：待批准（P8 用户评审）
- 关联：`docs/2026-09-08-buddy-skill-benchmark.md`（北森/腾讯电子签借鉴分析）、`docs/2026-09-05-crm-buddy-app-design.md`
- 输入决策（用户 2026-09-08）：范围=最小验证链路；凭据=`auth login` 交互录入+本地文件；命令=通用 `call` + 2 条语义化只读；分发=公共 npm；端点=生产 IP / 本机 / chiyuai.com 三档

---

## 0. 背景与根因

| 事实 | 说明 |
|---|---|
| 阻塞 | `connector/connector-meta.json` 为 `type: mcp` + `streamableHttp`，URL 需公网 HTTPS |
| 根因 | `chiyuai.com` 未 ICP 备案 → **SNI 级拦截** → 远程 MCP 不可达 → 连接器提交也过不了审 |
| 转机 | 北森（`~/.workbuddy/connectors-marketplace/connectors/beisen-cli/cli.json`）走 **CLI 连接器**：`npm install -g` + 本地 `auth login` + `auth status` 状态机 + 版本门禁，**平台侧不需要回调我方任何公网端点** |
| 可达性 | `http://81.70.184.198/mcp`（Nginx 反代 + Basic Auth）与 `http://localhost:3001/mcp` 现成可用 |

结论：做 `crm-native-cli`，以本地进程直连，绕开备案阻塞。

## 1. 目标与非目标

**目标**

1. 证明「本地 CLI 进程 + 本地鉴权」通道能拿到 CRM **真实数据**；
2. 产出可提交平台审核的 CLI 连接器包骨架（`cli.json` + 技能包）；
3. 三档端点可切换，覆盖 生产 / 本机 / 备案后域名。

**非目标（第一版明确不做）**

- 写操作命令（submit/approve/pay/payment-*/split 一律不实现，且主动拒绝）
- npm 正式发布（由用户执行，AI 无凭证）
- 语义化命令扩展到 16 个技能
- 租户/行业差异化

## 2. 方案选型

| 方案 | 机制 | 判断 |
|---|---|:---:|
| **A. CLI 直调远程 HTTP MCP** | 子命令 → 组装 JSON-RPC → POST `/mcp`（Basic Auth）→ 解析输出 | 🟢 **选定** |
| B. CLI 作 stdio MCP 隧道 | 本地 MCP server 转发远程，能力零重写 | 🟡 否决（首版） |
| C. CLI 本地直连 PG | 绕开服务层直查库 | ⛔ **红线，否决** |

- **选 A**：与北森 `cli.json` 同构，代码量约 300 行，1~2 天可验。
- **否 B**：北森样本中 CLI 连接器只做鉴权与状态，能力靠技能包调 CLI 命令；**平台是否支持 stdio MCP 透传无实证**，首版不押未知。
- **否 C**：绕开决策第 0 闸、RBAC、租户隔离、HITL，违反零信任铁律。

## 3. 架构

### 3.1 端点档位（三档，用户 2026-09-08 指定）

| 档位 | URL | 用途 | 当前状态 |
|---|---|---|---|
| `prod`（**默认**） | `http://81.70.184.198/mcp` | 生产库只读 | 🟢 可用 |
| `local` | `http://localhost:3001/mcp` | 本机联调 | 🟢 可用 |
| `www` | `https://www.chiyuai.com/mcp` | 备案解除后的目标形态 | 🔴 SNI 拦截，当前不可达 |

> ⚠ **生产档必须走 http 而非 https**：Nginx 侧 `/mcp` 为 http 直连，改用 https 会因证书不匹配丢失 `Authorization` 头（既有教训，见 `docs/2026-09-04-plugin-production-mcp-channel-design.md`）。
>
> ⚠ `www` 档不可达时，CLI **必须给出明确诊断**（提示「SNI 拦截 / 未 ICP 备案」），**禁止静默重试或降级**——静默降级会让用户误以为通道已通。

### 3.2 数据流

```
用户终端                     本机                                  目标
────────                    ────                                  ────
npm i -g crm-native-cli  → crm-cli use prod|local|www
                           crm-cli auth login  → 交互录入，写 ~/.crm-cli/credentials(0600)
                           crm-cli auth status → 探活，输出 {"status":"valid"}
                           crm-cli call <tool> '{}' ──→ POST <endpoint>/mcp  (JSON-RPC + Basic Auth)
                           crm-cli deal list                      ← JSON / 表格
                           crm-cli account show <名>
```

### 3.3 目录结构（新增，与既有 `connector/` MCP 通道并存，不删除）

```
connector/
├── connector-meta.json      # 既有 v1.5.0（MCP 通道，保留）
├── mcp.json                 # 既有（保留）
├── cli.json                 # 新增：CLI 连接器契约
└── skills/
    └── crm-cli/             # 新增：CLI 技能包
        ├── SKILL.md         # 声明 requires-cli、只读红线、端点切换
        └── references/
            └── endpoints.md # 三档端点与诊断口径
```

## 4. 命令契约（第一版 2+1）

| 命令 | 行为 | 输出 |
|---|---|---|
| `crm-cli use <prod\|local\|www>` | 切换当前端点档位，写入配置 | 当前档位与 URL |
| `crm-cli auth login` | 交互录入 user/pass（**不经聊天、不进仓库**），写 `~/.crm-cli/credentials`（0600） | 成功提示 |
| `crm-cli auth status` | 校验凭据 + 端点探活 | `{"status":"valid"}` / `{"status":"invalid"}` + 失败原因 |
| `crm-cli call <tool> [json]` | 透传任意 MCP 工具 | JSON 原文 |
| `crm-cli deal list [--stage S1]` | 语义化只读 ① | 表格 |
| `crm-cli account show <名称>` | 语义化只读 ② | 表格 + 关键联系人 |

### cli.json 关键字段（对齐北森）

```json
{
  "init":   { "win32": "npm install -g crm-native-cli", "darwin": "npm install -g crm-native-cli", "linux": "npm install -g crm-native-cli" },
  "auth":   { "win32": "crm-cli auth login"  },
  "unAuth": { "win32": "crm-cli logout"      },
  "status": { "win32": "crm-cli auth status" },
  "statusMatchJson": { "status": "valid" },
  "versionCheck": { "command": { "win32": "crm-cli version" }, "minVersion": "1.0.0", "versionPattern": "(\\d+\\.\\d+\\.\\d+)" },
  "runtime": { "type": "node", "version": ">=22.20.0" }
}
```

> 不设 `authUrlDomain`：我方无 OAuth 页面，凭据为终端交互录入。

## 5. 红线与安全

| # | 红线 | 落地 |
|---|---|---|
| 1 | **写操作零容忍** | `call` 传入写类工具名（`crm-deal-advance`/`submit`/`approve`/`pay`/`payment-*`/`split` 等）→ **在转发之前**直接拒绝并提示「需 HITL + `decision_id`，且须走 `CRM_APPROVAL_FLOW`」 |
| 2 | 判定顺序即安全边界 | 拒绝逻辑必须排在任何降级/转发逻辑之前，避免「信息不全」把已检出的写操作放行 |
| 3 | 凭据不落聊天、不进仓库 | 仅 `~/.crm-cli/credentials`（0600）；`.gitignore` 显式排除 |
| 4 | 绝对禁止 DELETE | CLI 不提供任何删除/清空子命令 |
| 5 | 生产档不改配置 | `authConfig`（context-routing 等平台核心配置）不在 CLI 能力内 |
| 6 | 失败不静默 | `www` 档不可达须明确报「SNI 拦截 / 未备案」，禁止静默重试或降级到其他档位 |

## 6. 任务分解（含生命契约）

```contract-yaml
- task: "T1 包骨架与 cli.json"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "crm-native-cli 包内 cli.json 的 init/auth/unAuth/status/versionCheck 五段齐备，且 statusMatchJson 为 {\"status\":\"valid\"}"
```
**契约说明：** 由 `followup-agent` 承接，调用 `data-particle-read`、读 `followup-agent` 记忆（L1，≤2 跳）；成功标准为 cli.json 五段完整、状态判定字段与北森同构。

```contract-yaml
- task: "T2 端点档位与 auth 子命令"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "use prod|local|www 三档可切换且默认 prod；auth login 写 ~/.crm-cli/credentials(0600)；auth status 对可达档输出 {\"status\":\"valid\"}、对 www 档给出 SNI/未备案诊断；仓库无凭据明文"
```
**契约说明：** 三档端点（生产 IP / 本机 / chiyuai.com）与凭据落盘均需可验证，含「仓库无明文」反向校验。

```contract-yaml
- task: "T3 call 通用转发与写操作拦截"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "call 对只读工具返回真实结果；传入写类工具名时被前置拒绝并提示 HITL + decision_id，且不产生任何网络请求"
```
**契约说明：** 覆盖通道可用性验证与写操作红线拦截两项判定，拒绝必须发生在发起请求之前。

```contract-yaml
- task: "T4 两条语义化只读命令"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read, method-followup-engine, method-funnel-classification]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "deal list 与 account show 在生产档返回非空表格，字段含商机号/阶段/金额 与 客户名/关键联系人"
```
**契约说明：** 语义化命令贴近北森「按业务域分命令」风格，成功标准以真实数据为准（不接受空集合通过）。

```contract-yaml
- task: "T5 连接器包与技能包接线"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "connector/cli.json 与 connector/skills/crm-cli/SKILL.md 就位，SKILL.md 声明 requires-cli 与只读红线；既有 MCP 通道文件未被删除"
```
**契约说明：** 与既有 `connector/`（connector-meta.json v1.5.0）并存，不删除原 MCP 通道。

## 7. 风险与处置

| 风险 | 处置 |
|---|---|
| 包名 `crm-native-cli` 被占用 | 备选 `@chiyu/crm-cli` / `crm-native-connector-cli` |
| 平台审核要求公网可装 | 走公共 npm；**发布由用户执行**（AI 无 npm 凭证） |
| `www` 档不可达被误判为代码缺陷 | `auth status` 输出明确原因；文档标注「环境/Provider 故障 vs 代码缺陷」区分口径 |
| 写类工具被误透传 | 工具名黑名单前置拒绝（§5 红线 1） |
| **注册表缺口** | `src/agent/agentSpec.js` 现有 6 个 agent 全为业务域（intake-router / quote-engine / followup-agent / review-gate / decision-retro / decision-agent），**无 infra/dev 类智能体**，T1–T5 只能挂 `followup-agent`（语义牵强）。建议后续增补 `platform-connector` agent——**属变更，需另开一轮并获批准** |

## 8. 验证方式

```powershell
# 1) 本地安装与鉴权
npm i -g crm-native-cli
crm-cli use prod
crm-cli auth login      # 终端交互录入，不落聊天
crm-cli auth status     # 期望 {"status":"valid"}

# 2) 通道验证
crm-cli call crm-deal-list '{"stage":"S1"}'
crm-cli deal list --stage S1
crm-cli account show "XX 制造"

# 3) 红线验证（必须被拒且不发请求）
crm-cli call crm-deal-advance '{}'    # 期望：拒绝 + HITL 提示
```

## 9. 闭环回写

| 任务 | agent | gap_type | observed | expected | severity |
|---|---|---|---|---|---|
| — | — | — | 初始化，尚无回写记录 | — | — |

> 回写规则：workbench 监控契约执行，遗漏/失败写入 `docs/2026-09-08-crm-cli-connector-design.feedback.json` 并镜像到本表；同一 `(task, gap_type)` 复现 ≥2 次时生成 SKILL 改进提案，**须经用户批准**方可落地。

## 10. 待决

1. 包名：`crm-native-cli`（被占用则回退 `@chiyu/crm-cli`）是否确认？
2. 默认档位 = `prod`（生产 IP 只读）+ `--local` 切换本机，是否确认？
3. 是否批准进入 writing-plans（实施计划）？
