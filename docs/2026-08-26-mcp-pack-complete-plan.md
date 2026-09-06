# CRM-ai-native 对外分发完整计划：方法论包 → MCP Server → CRM 智能体包 → 技能市场

> 状态：**待用户批准**。批准后进入 writing-plans 拆 Task 实施。
> 设计输入（已批准，本计划是对齐其落地的执行清单）：
> - `docs/2026-08-25-ai-native-crm-overall-design.md` §6.13（对话式 CRM 智能体包）
> - `docs/2026-08-25-crm-conversational-agent-solution.md`（方案：借 CordysCRM 设计资产、换 transport）
> - `db/schema.sql` skill_registry / `src/skills/registry.js`（enabled + rbac 硬闸，已落地）
> - `skills/method-presales/`（现实范式：SKILL.md + registry.json + methodology.json + core|rules|references|profiles 四目录）
> - CordysCRM 源码（`/approval-action/back` 等六动作实证）

## 0. 总纲

**目标**（从内到外四层）：让 CRM-ai-native 的能力可以被"装进"WorkBuddy 技能市场、被任意办公智能体免登录调用——达到 CordysCRM 技能包同样的对外可用性，但不用其 Java/MySQL/REST 薄包装（我们是 AI 原生 CRM 本身）。

**判定**：**尚未全部实现**。平台内部能力（粒子底座/审批流/Action 注册表/六角色权限/预警）已开发；**对外分发层缺三块**：7 个方法论 SKILL 未落、MCP Server 未实现、CRM 智能体包未打包。

**范围**：只做"对外分发"，不碰已完成的内部能力（不重写 approval/action/context 等，只新增扩展）。每 Task 一 commit，pathspec 限定。

**铁律**：新增 SKILL 只进 `skills/` 目录（方法论）与 `src/skills/` 种子（registry 声明），不新增 10 大 ai-* 能力序号；领域专有内容（IPD/PDM/P2P）不写进方法论 SKILL。

---

## 1. 第一阶段：补齐 7 个方法论 SKILL（纯知识，零依赖，最易先做）

**现状**：只有 `method-presales` 一个。设计（§6.6 / §5quater）要 7 个：BANT / MEDDICC / 机会矩阵 / 角色地图 / 风险权衡 / 止损点 / 事实vs话术。

**每个 SKILL 目录结构**（对齐 method-presales 现实范式，一字不差）：

```
skills/method-<id>/
  SKILL.md                # YAML frontmatter：name/description/environment/security（requiresSecrets:false, externalNetworkAccess:false）
  registry.json           # { name, version, category:"methodology", methodology_id, dimensions[], rbac_roles[], enabled:true }
  methodology.json        # 机器可读维度（唯一事实源）
  core/evaluate.md        # 评估流程（评分门控）
  rules/scoring.md        # 评分规则（含 gate：FAIL 禁推进）
  references/dimensions.md# 维度释义
  profiles/<role>.md      # 角色自适应（sales/manager/exec/finance/presales/contract_admin 六角色视角）
```

**7 个方法论内容源**（已批准设计 §5quater，非新设计）：
| id | 方法 | 核心维度 | 角色 |
|---|---|---|---|
| method-bant | BANT | 预算/权限/需求/时间线 | sales |
| method-meddicc | MEDDICC | 指标/经济买家/决策标准/决策流程/识破痛苦/冠军 | sales |
| method-opportunity-matrix | 机会矩阵 | 价值×可行性/竞争定位 | sales/manager |
| method-role-map | 角色地图 | 决策链/影响者/使用者/利益相关方 | presales |
| method-risk-tradeoff | 风险权衡 | 风险×收益/红线/缓解 | sales/manager |
| method-stop-loss | 止损点 | 负净值/投入预算/退出门 | exec |
| method-fact-vs-script | 事实vs话术 | 事实/证据/话术/异议处理 | sales |

**接线**：每个 SKILL 写完后，在 `src/skills/seed.js` 注册（registerSkill，enabled:true + rbac_roles 对应角色），skill_registry 后台可停用。

**验收**：`skills/method-*` 7 目录齐全；`node --check` + 单测（registry 能 getSkill 到）；本地纯逻辑绿；真机 PG 验 skill_registry 行。

---

## 2. 第二阶段：MCP Server（核心工程，打通对外调用）

**现状**：`package.json` 无 MCP 依赖；`src/` 无 mcp 目录（grep 证实）。设计契约：对外经 **MCP Server + HTTP API 无头暴露**（总体设计 §6.13）。

**依赖**：`@modelcontextprotocol/sdk`（npm 安装进项目依赖；用项目级 `.npm-cache` 绕过沙箱 npm 缓存易损，禁 `npm install -g`）。

**实现**（新增，不改既有 src 内部模块）：
```
src/mcp/
  server.js              # MCP Server 入口（stdio + StreamableHTTP 双传输；复用 src/http/server.js 的 Express）
  tools.js               # 工具清单注册：把 Action Registry（listActions 30+）暴露为 MCP tools（只读优先、写走两阶段）
  gateway.js             # 请求闸：读→直接；写→两阶段（取表单→确认→执行→验证）+ action-confirm + 决策第 0 闸（requireDecision）
  auth.js                # 凭证：平台颁发 API token，映射 actor 角色（role-engine 自推断不索身份）
  config.js              # 端口/传输配置（3001 stdio + StreamableHTTP，对齐 P2P 3001 /mcp 惯例）
```

**安全红线**（对齐 §6.13 与 CordysCRM 教训）：零信任、凭证隔离、**绝对禁删**（无 delete 工具）、写前校验、最小权限降级 sales、HITL（写操作必须 action-confirm）。

**验收**：MCP 工具列表可列出 Action 注册表全部读工具；写工具两阶段（先 confirmation_token 后执行）可测；`node --check` + 纯逻辑单测；真机 PG。

---

## 3. 第三阶段：CRM 智能体包（4 个 SKILL，对齐 §6.13 目录树）

**设计目录树**（总体设计 §6.13 蓝图，落地为现实 SKILL 目录）：
```
agents/crm-native.md        # 智能助手面孔（角色自适应，5 角色）
skills/
  crm-native/               # 编排技能（入口：意图路由 → 技能分发；惰性编排九引擎）
  crm-query/                # 跨模块推理查询（粒子图 + AGE 多跳 + pgvector + 决策网络）
  crm-write/                # 对话式写入（两阶段 + 决策第 0 闸 + action-confirm）
  crm-risk/                 # 链断裂/异常检测（商机→技术方案>30天/赢单前无方案等，SSE 推送）
```

**每个包结构**：SKILL.md + registry.json（requiresPrivileges 等安全字段）+ core/ + profiles/ + rules/ + references/。

**核心**：
- `crm-query`：调 MCP 工具（第二阶段产物）+ 决策网络多跳 + pgvector 语义检索（已有底座）
- `crm-write`：两阶段写入协议（取表单→确认→执行→验证），写操作永远经 Action Registry 第 0 闸
- `crm-risk`：常驻主动探测（对齐 crm-risk 设计：商机→技术方案>30天、赢单前无方案、回款逾期）
- `crm-native`：惰性编排——用到哪引擎加载哪引擎（不单体、不按 ai-* 每能力一技能）

**接线**：4 个 SKILL 在 `src/skills/seed.js` 注册；`method-*` 7 个被 crm-native 作为子技能引用（技能分发）。

**验收**：4 SKILL 目录 + registry 可 getSkill；crm-query 纯逻辑检索单测；两阶段写流程纯逻辑测；真机 PG。

---

## 4. 第四阶段：打包与技能市场（收尾）

**实现**：
```
.workbuddy-plugin/
  plugin.json           # 插件清单（name/category/marketplace/appType 等，对齐 CordysCRM 打包范式）
  agents/crm-native.md
  skills/               # 全量打包：method-* 7 + crm-native/query/write/risk 4 + method-presales
```

**plugin.json 字段**（对齐 CordysCRM `CordysCRM-main/.workbuddy-plugin/plugin.json` 现实）：
`name` / `description` / `category:"crm"` / `version` / `marketplace` / `entries` 指向 agents 与 skills 清单。

**提交**：zip 打包提交到 WorkBuddy 技能市场（外部操作，需用户在 WorkBuddy 侧完成上传/发布；本计划只产出包）。

**验收**：`find . -name plugin.json` 命中；zip 可解压结构完整；技能市场安装说明文档（README 一段）。

---

## 5. 顺序与依赖

```
阶段1（7 方法论 SKILL）──┐
                        ├─→ 阶段3（crm-native 引用 7 method-* + method-presales）
阶段2（MCP Server）──────┤
                        └─→ 阶段3（crm-query/write/risk 调 MCP 工具）
阶段4（打包）← 阶段1+2+3 全部完成
```

依赖明确：阶段 3 依赖阶段 1（子技能）+ 阶段 2（MCP 工具）；阶段 4 依赖前三阶段。

---

## 6. 验收口径（对齐总体设计 §6.13 验收项）

| 验收项 | 判据 |
|---|---|
| 外部智能体免登录调用 | MCP 工具可列、可调（读直接、写两阶段） |
| 角色自适应 | crm-native 按对话内容自推断角色加载 profiles（不问你是谁） |
| 跨模块推理查询 | crm-query 对"商机/客户/回款"一句话查询返回结构化结果 |
| 对话式写入 | crm-write 两阶段收单（先表单后确认执行），写操作带 decision_id |
| 先于提问预警 | crm-risk 常驻探测链断裂，SSE 推送 |
| 技能市场分发 | plugin.json 打包可安装到 WorkBuddy |

---

## 7. 待办与风险

- **环境**：MCP SDK 安装需沙箱项目级缓存（`.npm-cache`）；真机 PG 验收需用户本机 PG@5433。
- **风险**：MCP SDK 与既有 Express 4 端口/中间件兼容（第二阶段的 server.js 挂到既有 server.js，避免端口冲突——3001 独立端口）。
- **范围**：不重写平台内部（approval/action/context 等已实现模块零改动）；只新增 skills/ + src/mcp/ + 打包。
- **铁律**：10 大 ai-* 能力序号不变；领域专有内容不进方法论 SKILL。