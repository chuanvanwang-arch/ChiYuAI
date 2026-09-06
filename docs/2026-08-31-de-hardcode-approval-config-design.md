# 审批域业务参数去硬编码化改造设计

- **日期**：2026-08-31
- **铁律依据**：用户 2026-08-30/31 明确——**所有业务参数、业务控制必须后台设置，禁止硬编码**
- **方案方向**：混合（用户 2026-08-31 选定）——业务参数（R1–R4 规则 / 金额阈值 / 角色链 / 默认兜底）进 `config_store`，审批流拓扑由 `approval-flow.html` 管理粒子、节点引用配置规则
- **范围**：全平台复查后，唯一系统性违规域 = **审批域**（其余域已按铁律改造，见 §1）

---

## §1 全平台复查结论（差距分析）

### 已合规（硬编码出厂默认 + 配置覆盖，符合铁律）
| 域 | 配置键 | 证据 |
|---|---|---|
| 销售判定阈值 | `config_store['sales-thresholds']` | `salesThresholds.js` |
| 财务应收 | `config_store['finance-receivables']` | `alerts/financeAlertHook.js:25` |
| 指名客户目标 | `config_store['named-account-targets']` | `configCenter.js:30` |
| 销售行为标准 | `config_store['behavior-standard']` | `behaviorStandardRouter.js` |
| 校准/自主阈值 | `config_store['autonomy-conf']` | `calibration/store.js:25` |
| 决策置信度 | `DEFAULT_CONF` 兜底 + `autonomy-conf` 覆盖 | `autonomyEngine.js:8,14` |
| 预警规则 | `check_params` + `config_store` 覆盖 | `alertRegistry.js` |

### 违规（完全硬编码，无配置键）
1. **审批域 — `src/approval/ruleResolver.js`**
   - R1–R4 规则：`ruleResolver.js:17-22`
   - 金额档位 `¥100万 / ¥500万`：`ruleResolver.js:25-28`
   - 档位角色链 `TIER_CHAINS`：`ruleResolver.js:32-37`
   - 重大项目直接 T3：`ruleResolver.js:40-41`
   - **双源漂移**：`salesThresholds.js:54-57` 重复定义 `t2/t3`
2. **审批引擎兜底 — `src/approval/engine.js`**
   - 审批人为空/无规则 `auto_pass` 兜底：`engine.js:121 / :280 / :325`
3. **审批流配置页脱节**
   - `approval-flow.html:38-40` 自述：`crm.approval_flow` 表与 `CRM_APPROVAL_*` 粒子脱节，不驱动运行态

### 边界（保留，属枚举/语义契约）
- `businessTier.js:10-12` `VALID_DIMENSIONS/VALID_TIERS`（枚举契约）
- `confidence.js:5,10` `0.9/0.85` 业务语义映射

---

## §2 目标

1. 审批域所有业务参数（R1–R4 / 金额档位 / 角色链 / 默认兜底）从代码硬编码迁移到 `config_store['approval-config']`，单一事实源。
2. 审批流配置页（`approval-flow.html`）真正打通运行态——编辑 `CRM_APPROVAL_*` 粒子，消除 `crm.approval_flow` 表脱节。
3. 消除双源漂移：删除 `salesThresholds.js` 中重复的 `approval.t2/t3`，改为引用 `approval-config`。
4. 行为不变：配置缺省回退值须与现行 `ruleResolver.js` 逐字 parity（参照 `calibration/store.js:7` parity 锁定）。

---

## §3 方案：混合模式（配置分层）

### 3.1 层一 · 业务参数（单一事实源 `config_store['approval-config']`）
仿 `sales-thresholds` 范式，新增键 `approval-config`，结构：

```json
{
  "rules": {
    "R1": { "business": "deal",     "fromStage": "S2", "toStage": "S3" },
    "R2": { "business": "quote",     "fromStage": "S3", "toStage": "S4" },
    "R3": { "business": "contract",  "fromStage": "S4", "toStage": "S5" },
    "R4": { "business": "invoice",   "fromStage": "S5", "toStage": "S6" }
  },
  "tierThresholds": { "t2": 1000000, "t3": 5000000 },
  "tierChains": {
    "R1": { "T1": ["manager"],                "T2": ["manager"],                "T3": ["manager"] },
    "R2": { "T1": ["manager"],                "T2": ["manager","director"],     "T3": ["manager","director","president"] },
    "R3": { "T1": ["legal"],                  "T2": ["legal","vp"],             "T3": ["legal","vp","president"] },
    "R4": { "T1": ["finance_vp"],             "T2": ["finance_vp"],             "T3": ["finance_vp"] }
  },
  "majorProjectForceT3": true,
  "defaultEmptyApproverAction": "ASSIGN_ADMIN"
}
```

- `DEFAULT_APPROVAL_CONFIG`（代码内冻结兜底）与上述逐字一致，保证未铺底时行为不变。
- **删除** `ruleResolver.js:17-48` 全部硬编码常量，改为从 `config_store['approval-config']` 读取（带 `DEFAULT` 兜底）。

### 3.2 层二 · 审批流拓扑（粒子，前端可配并驱动运行态）
- `approval-flow.html` 改为读写 `CRM_APPROVAL_FLOW / _NODE / _LINK / _APPROVER / _CONDITION` 粒子（非 `crm.approval_flow` 表），打通 `flow.js` 写回路径（`getFlowByDomain` 已有；补 `createFlow/updateFlow/deleteFlow` 写回）。
- 每个 `APPROVER` 节点配置：
  - `role`（初始值由 `approval-config.tierChains[ruleId][tier][pos]` 铺底，页上可覆盖）
  - `auto_allowed`（开关 → 映射 `empty_approver_action: AUTO_PASS / ASSIGN_ADMIN`，消除 `flow.js:109` 硬编码映射）
  - `empty_approver_action`（节点级覆盖全局默认）
- 节点数 / 顺序 / 条件边由页配置，运行态 `engine.startInstance` 直接消费粒子拓扑。

### 3.3 层间关联与防漂移
- **角色链唯一事实源 = `approval-config.tierChains`**；审批流页不重复定义角色，仅引用 ruleId+tier+pos 从配置解析，或在页上显式覆盖（覆盖值存粒子，不回写配置）。
- **删除 `salesThresholds.js:54-57`** 的 `approval.t2/t3`；前端销售阈值页若需展示审批金额档位，改为从 `approval-config.tierThresholds` 读取（只读引用）。
- parity 测试锁定 `DEFAULT_APPROVAL_CONFIG` 与现行 `ruleResolver.js` 值一致（`test/approval/parity.test.js`，参照 `test/calibration/parity.test.js`）。

---

## §4 引擎改造点（file:line 级）

| 文件 | 行 | 改造 |
|---|---|---|
| `ruleResolver.js` | 16-48 | 删除 `RULES/DEFAULT_TIER_THRESHOLDS/TIER_CHAINS` 硬编码；`resolveTier` / `resolveApprovalChain` 改为读 `config_store['approval-config']`（带 `DEFAULT` 兜底） |
| `engine.js` | 73,121,280,325 | `auto_pass` 兜底默认改为读 `approval-config.defaultEmptyApproverAction`（默认 `ASSIGN_ADMIN`），消除硬编码 `ASSIGN_ADMIN` / `{auto_pass:true}` |
| `flow.js` | 106-112 | `empty_approver_action` 映射改为节点 `auto_allowed` 直配（不再硬编码三元） |
| `seed-actions.js` | 29-40 | `startGradedApproval` 不变签名；内部 `resolveApprovalChain` 已读配置 |
| `salesThresholds.js` | 54-57 | 删除 `approval.t2/t3` 双源 |

---

## §5 前端改造

1. **`approval-flow.html`**：经复查，其后端 `approvalFlow.js` 的 `writeFlowFromStages` **已接 `CRM_APPROVAL_*` 粒子、运行态已打通**；故 T-D 仅修正页面陈旧的"脱节"提示文案（指向 `/approval-config.html` 业务参数页），无需重写拓扑写入逻辑。
2. **审批业务参数配置页**：新增 `/approval-config.html`（**配置中心新增独立项 id34**，与 id17 审批流拓扑并列同组「业务对象与流程建模」，分层——id34 管业务参数、id17 管拓扑节点），编辑 `config_store['approval-config']`（R1–R4 / 金额档位 / 角色链 / 默认兜底），端点复用通用 `createConfigRouter({key:'approval-config',role:'sysadmin',decisionScene:'config-change'})`（自带决策第0闸 + sysadmin 闸 + 七维拦截），无需专用端点。
3. **`configCenter.js` + `config.html`**：新增 id34 项并加入 G3 `items` 数组（[17,18,19,20,22,29,30,34]）。

---

## §6 迁移脚本

`scripts/migrate-approval-config.mjs`（幂等，追加写入，固定 UUID + `ON CONFLICT DO NOTHING`，禁 DELETE）：
1. 把 `DEFAULT_APPROVAL_CONFIG` 铺底到 `config_store['approval-config']`（若键不存在）。
2. 重建 `CRM_APPROVAL_*` 粒子（`scripts/seed-approval-rules.mjs` 既有逻辑复用）：拓扑节点 `role` 由 `approval-config.tierChains` 铺底，`auto_allowed` 由 `defaultEmptyApproverAction` 推导，确保与配置一致。

---

## §7 验证

1. **parity 单测**：`test/approval/parity.test.js` 锁 `DEFAULT_APPROVAL_CONFIG` 与现行 `ruleResolver.js` 值逐字一致。
2. **配置读取单测**：`ruleResolver` 读取 `approval-config` 的 R1–R4 / 金额 / 角色链正确解析。
3. **端到端**：`approval-flow.html` 切换某关卡 `auto_allowed` → 运行态该关卡起单 `AUTO_PASS` 生效；改 `approval-config.tierThresholds.t3` → 大额交易档位升级链变化。
4. **回归**：既有一期审批用例（deal/quote/contract/invoice 起单）全绿，行为不变。

---

## §8 任务分解（每 Task 一 commit）

| Task | 内容 | 验证 |
|---|---|---|
| T-A | 新增 `approval-config` 键 + `DEFAULT_APPROVAL_CONFIG` 兜底 + 迁移脚本铺底 | parity 测试 |
| T-B | `ruleResolver.js` 去硬编码，改读配置 | 读取单测 |
| T-C | `engine.js` auto_pass 兜底读配置 | 单元 + 端到端 |
| T-D | `flow.js` 写回路径 + `approval-flow.html` 打通粒子（auto_allowed 开关） | 前端端到端 |
| T-E | 删除 `salesThresholds.js` 双源 + 新增 `/approval-config.html` 参数配置页 | 漂移消除 |
| T-F | 全量测试 + 回归 + 自查文档 | 全绿 |

---

## §9 风险与注意

- **运行态依赖铺底顺序**：`seed-actions.js:35` 在未配置审批流时返回 `null`（quote/contract/invoice 抛错）。迁移脚本须先于业务验证运行；`DEFAULT` 兜底保证未铺底不崩。
- **双源漂移已消除**：`salesThresholds.js` 与 `salesThresholdsRouter.js` 的 `approval.t2/t3` 已删除，`grep` 全仓确认无任何页面/测试再引用 `sales-thresholds.approval.*`，审批金额档位唯一事实源现为 `approval-config.tierThresholds`。
- **审批流页打通远低于预期**：复查确认 `approvalFlow.js` 的 `writeFlowFromStages` 已于前期接 `CRM_APPROVAL_*` 粒子、运行态早已打通；T-D 实际工作量仅为修正 `approval-flow.html` 陈旧"脱节"文案，无拓扑重写。
