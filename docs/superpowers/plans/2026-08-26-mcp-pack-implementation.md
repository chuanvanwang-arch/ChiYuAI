# MCP/智能体包（对外分发）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CRM-ai-native 平台能力包装成 CordysCRM 同等对外可用形态——7 方法论 SKILL + MCP Server + 4 智能体 SKILL + plugin.json 打包，外部办公智能体（WorkBuddy 等）免登录安装调用。

**Architecture:** 复用已批准设计（总体设计 §6.13 / 对话式智能体包）+ 已落地基础设施（`src/skills/registry.js` registerSkill/getSkill/canExecuteSkill、`src/action/registry.js` 30 Action、`src/http/server.js` Express 进程内 fetch 适配器、`skills/method-presales/` 范式）。设计资产全借、transport 替换：不引 Java/MySQL/cordys.sh 外部 REST，MCP 直调粒子 API / Action Registry / 决策网络。

**Tech Stack:** Node 22 + ESM + Express 4 + `@modelcontextprotocol/sdk`（npm 安装入项目依赖，项目级 `.npm-cache`）+ PostgreSQL（crm schema）+ vitest 3（单 worker，fileParallelism:false）。

---

## 文件结构（本计划创建/修改的文件及职责）

| 文件 | 职责 | 操作 |
|---|---|---|
| `skills/method-bant/` 等 7 目录 | 7 方法论 SKILL（每个 SKILL.md + registry.json + methodology.json + core/rules/references/profiles） | 新建 |
| `src/skills/seed.js` | 注册 7 方法论 + 4 智能体 SKILL（registerSkill，enabled + rbac_roles） | 修改（追加） |
| `src/mcp/server.js` | MCP Server 入口（stdio + StreamableHTTP 双传输，独立端口 3001） | 新建 |
| `src/mcp/tools.js` | 工具注册：Action Registry 暴露为 MCP tools（读直接/写两阶段） | 新建 |
| `src/mcp/gateway.js` | 请求闸：读写分级 + two-phase（表单→确认→执行→验证）+ action-confirm + 决策第 0 闸 | 新建 |
| `src/mcp/auth.js` | 平台颁发 API token → actor 角色映射（role-engine 自推断） | 新建 |
| `src/mcp/config.js` | 端口/传输配置（3001 stdio + HTTP） | 新建 |
| `skills/crm-native/` 等 4 目录 | crm-native/query/write/risk 智能体 SKILL（SKILL.md + registry.json + core/profiles/rules/references） | 新建 |
| `agents/crm-native.md` | 智能助手面孔（5 角色自适应） | 新建 |
| `.workbuddy-plugin/plugin.json` | 插件清单（name/category/version/marketplace/entries） | 新建 |
| `test/mcp-gateway.test.js` | MCP 网关纯逻辑测试（读写分级/两阶段/禁删/凭证） | 新建 |
| `test/skills-seed.test.js` | SKILL 注册测试（7+4 可 getSkill，rbac/enabled 生效） | 修改（追加） |

**类型契约（跨 Task 一致，禁止改名）：**
- 方法论 SKILL slug：`method-bant` / `method-meddicc` / `method-opportunity-matrix` / `method-role-map` / `method-risk-tradeoff` / `method-stop-loss` / `method-fact-vs-script`
- 智能体 SKILL slug：`crm-native` / `crm-query` / `crm-write` / `crm-risk`
- MCP 传输：stdio + StreamableHTTP（streamableHttp），端口 3001
- MCP tools 命名：`crm_<action>`（把 Action Registry name 蛇形化，如 crm-deal-advance → `crm_deal_advance`）

---

## 前置检查（每个 Task 前跑一次）

```bash
cd /d/system/CRM-ai-native
node node_modules/vitest/vitest.mjs run --passWithNoTests
```

预期：现有纯逻辑测试通过（83/83 基线含本轮 6 文件），无回归。

---

### Task 1: 7 方法论 SKILL 落库（第一批：BANT/MEDDICC/机会矩阵）

- [ ] **Step 1: 写测试**（`test/skills-seed.test.js`：7 个 method-* 注册后 getSkill 可查；rbac_roles/enabled 生效）
- [ ] **Step 2: 跑失败**（seed.js 未注册 7 个 → FAIL）
- [ ] **Step 3: 实现**——3 个 SKILL 目录（每个 SKILL.md + registry.json + methodology.json + core/evaluate.md + rules/scoring.md + references/dimensions.md + profiles/<role>.md，对齐 method-presales 范式）+ `src/skills/seed.js` 注册 3 个
- [ ] **Step 4: 跑通过**（skills-seed 该批测试绿）
- [ ] **Step 5: Commit**（pathspec：3 目录文件 + seed.js + seed 测试）

> 内容源：已批准设计 §5quater，非新设计。

### Task 2: 7 方法论 SKILL 落库（第二批：角色地图/风险权衡/止损点/事实vs话术）

- [ ] **Step 1: 写测试**（第二批 4 个注册断言）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**——4 个 SKILL 目录 + seed.js 追加注册
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: Commit**

### Task 3: MCP SDK 依赖 + 服务器骨架

- [ ] **Step 1: 写测试**（`test/mcp-gateway.test.js`：config 读取 3001；空工具列表可启动）
- [ ] **Step 2: 跑失败**（src/mcp 不存在）
- [ ] **Step 3: 实现**——npm 安装 `@modelcontextprotocol/sdk`（项目级 `.npm-cache`）+ `src/mcp/config.js` + `src/mcp/server.js`（stdio + streamableHttp 双传输骨架，3001）
- [ ] **Step 4: 跑通过**（骨架启动/取 config 绿）
- [ ] **Step 5: Commit**

### Task 4: MCP 工具注册（读：只读 Action 直接暴露）

- [ ] **Step 1: 写测试**（`test/mcp-gateway.test.js`：tools.js 注册后工具列表含全部只读 Action 蛇形名）
- [ ] **Step 2: 跑失败**（tools.js 不存在）
- [ ] **Step 3: 实现**——`src/mcp/tools.js`：遍历 Action Registry kind==='read' → 注册为 MCP tool（name: `crm_<action>`，schema 映射 parameters）；不含任何 delete（禁删红线）
- [ ] **Step 4: 跑通过**（工具列表含全部只读；无 delete）
- [ ] **Step 5: Commit**

### Task 5: MCP 写操作两阶段闸（core）

- [ ] **Step 1: 写测试**（写 Action：先取表单→确认（confirmation_token）→执行→验证；缺 token 拒绝；决策第 0 闸 decision_id）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**——`src/mcp/gateway.js`：读写分级；写走两阶段（表单→确认→执行→验证）+ `requireDecision`（决策第 0 闸）+ action-confirm；无 delete 工具
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: Commit**

### Task 6: MCP 凭证 + 角色映射

- [ ] **Step 1: 写测试**（API token → actor 角色推断；无 token 拒写；最小权限降级 sales）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**——`src/mcp/auth.js`：平台颁发 token 映射 actor；role-engine 自推断（不问你是谁）；凭证隔离
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: Commit**

### Task 7: 4 智能体 SKILL（crm-native / crm-query / crm-write / crm-risk）

- [ ] **Step 1: 写测试**（4 SKILL 注册；crm-native 引用 method-* 子技能清单；crm-write 两阶段协议描述）
- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现**——4 SKILL 目录（各自 SKILL.md + registry.json + core/ + profiles/ + rules/ + references/）+ seed.js 注册 + `agents/crm-native.md`（5 角色面孔）
- [ ] **Step 4: 跑通过**
- [ ] **Step 5: Commit**

### Task 8: plugin.json 打包 + README 安装说明

- [ ] **Step 1: 写测试**（plugin.json 存在且字段齐：name/category/version/marketplace/entries；zip 可解压）
- [ ] **Step 2: 跑失败**（无 plugin.json）
- [ ] **Step 3: 实现**——`.workbuddy-plugin/plugin.json`（对齐 CordysCRM 范式）+ `agent`/`skills` 引用 + README 一段安装说明 + zip 打包脚本
- [ ] **Step 4: 跑通过**（JSON 校验 + zip 结构）
- [ ] **Step 5: Commit**

### Task 9: 全量验收 + 文档收尾

- [ ] **Step 1: 写测试**（全量：skills-seed 11 个 SKILL 断言 + mcp-gateway 全绿 + 既有 83 基线无回归）
- [ ] **Step 2: 跑失败/跑通过**
- [ ] **Step 3: 实现**——文档收尾：总体设计 §6.13 状态标记（7+4+MCP+plugin 落地）+ 本计划归档
- [ ] **Step 4: 验收**（本地纯逻辑全绿；真机 PG 验 skill_registry 行）
- [ ] **Step 5: Commit**

---

## 自检

- **占位符**：无未定义参数；7 个 method-* 内容源=已批准设计 §5quater（非新写）；MCP 依赖名`@modelcontextprotocol/sdk` 真实 npm 包。
- **矛盾**：MCP 端口 3001 与既有 server.js（Express 进程内 fetch，无监听端口）不冲突；智能体 SKILL 不新增 10 大 ai-* 能力序号。
- **范围**：不重写已实现模块（approval/action/context 零改动）；只新增 skills/ 目录、src/mcp/、plugin 打包。
- **铁律**：领域专有内容（IPD/PDM/P2P）不进方法论 SKILL（method-presales 已立范式）；对外禁删（MCP 无 delete 工具）。