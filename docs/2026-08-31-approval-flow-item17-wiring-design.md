# #17 审批流配置接通运行态引擎 — 详细设计（方案 A 直写粒子）

- 日期：2026-08-31
- 作者：WorkBuddy（设计先行，经 brainstorming 选型批准：方案 A 直写粒子）
- 关联：配置中心第 17 项（蓝图 S22）；`docs/superpowers/specs/2026-08-27-approval-flow-config-design.md` §0.3（已知脱节）；全量消费排查报告（2026-08-31）
- 范式：与已建 RBAC / business-tier / 预警规则配置页一致；粒子为运行态唯一事实源

---

## §0 背景与现状证据（file:line 级）

### §0.1 #17 是真正悬空项（#21 已接通，非悬空）
全量消费排查中，Explore agent 误判 #21 悬空（搜 `alert_rules` 字面量 0 匹配）。实证纠正：
- `src/portal/alertRuleConfig.js:81` 直接 import `listAlertRules` / `updateAlertRule`
- `:131` PUT 路由调 `updateCache(kind, patch)` 实时改 `alertRegistry.js` 内存缓存（引擎热路径 `evaluateForEvent`→`evaluateAlertRule` 读取）
- `:148` `hydrateAlertRules()` 启动时从 `crm.alert_rule` 水合

**→ #21 已消费，无需接线。唯一悬空为 #17。**

### §0.2 #17 脱节的三层证据
| 层 | 位置 | 存储 | flow_id 语义 |
|---|---|---|---|
| 配置页 | `src/portal/approvalFlow.js:80,84,88` | `crm.approval_flow` SQL 表 | **业务域字符串** `deal/quote/contract/invoice`（`DOMAIN_LABELS`） |
| 运行态引擎 | `src/approval/engine.js:76-88` `loadFlow()` | `CRM_APPROVAL_*` 粒子 | **粒子 id**（uuid） |
| 运行态调用方 | `src/action/seed-actions.js:419,506,521,536` | — | `startInstance(flow_id, business_type, ...)` 的 `flow_id` 由**调用方 action 入参传入**，无默认值 |

`engine.js:77` `getParticle(flow_id)` 按粒子 id 查；配置页 `flow_id` 是域字符串——**两套存储不仅平行，连 id 语义都不对齐**，配置页改了引擎毫无感知。

### §0.3 关键技术约束（决定方案形态）
`src/particles/particleRepo.js:54` `createParticle(type, payload, {tenantId, actor})` **不支持指定 id**，粒子 id 由 DB 自动生成 uuid。

→ 配置页域字符串 `deal/quote` **不能直接当粒子 id**。对齐机制必须走 `payload.domain` 业务键 + 运行态按 `business_type→domain` 解析。

---

## §1 方案 A 设计总览（直写粒子，单一事实源）

**核心思路**：配置页从「写 `crm.approval_flow` 表」改为「直写 `CRM_APPROVAL_*` 粒子」；线性 `stages` 翻译为节点拓扑；运行态调用方按业务实体类型自动解析 domain→粒子 id。配置即粒子事实源，零同步漂移。

### §1.1 闭环三环
1. **配置页直写粒子**：PUT 保存 `stages` 时，翻译并重建该 domain 的 `CRM_APPROVAL_FLOW` + `NODE` + `APPROVER` + `LINK` 粒子。
2. **粒子为事实源**：引擎 `loadFlow(flow_id)` 已读这些粒子，**无需改引擎**。
3. **运行态按 domain 自动解析**：`seed-actions.js` 的 submit 类 Action 不再要求调用方传 `flow_id`，改为按 `business_type → domain` 映射 + `getFlowByDomain(domain)` 解析粒子 id 后 `startInstance`。

### §1.2 `crm.approval_flow` 表处置
- **降级为只读兼容视图**（不删除，遵守禁删铁律）：页面不再读写该表；保留表结构向后兼容历史数据/审计。
- 种子数据迁移到 `CRM_APPROVAL_*` 粒子（`db/seed.sql:286`、`db/test-setup.sql:72` 的 `crm.approval_flow` INSERT 改为写入粒子，domain 对齐）。

---

## §2 配置页改写 — `src/portal/approvalFlow.js`

### §2.1 存储后端替换
将 `defaultDeps` 的 `listFlows/getFlow/upsertFlow`（:79-96，走 `query('crm.approval_flow')`）改为走 `src/approval/flow.js` 粒子 API：
- `listFlows` → `queryParticles({type:'CRM_APPROVAL_FLOW', tenantId})` 后 map 出 `{flow_id: payload.domain, name, description, stages, enabled}`
- `getFlow(id)` → `getFlowByDomain(id)` 反查后 map 同样结构
- `upsertFlow(flow)` → `writeFlowFromStages(flow)`（§2.2 翻译写入 + 软停旧版本）

`validateStages`（:22）、`renderStages`（:33）、`renderApprovalFlows`（:49）、`approvalFlowSummary`（:70）、前端 `collect()`（`approval-flow.html:63`）**保持不变**——业务键仍是域字符串 `flow_id`，仅存储后端换为粒子。

### §2.2 stages → 粒子拓扑翻译（`flow.js` 新增 `writeFlowFromStages`）
输入：`{flow_id: domain, name, description, stages:[{stage,role,action,auto_allowed}], enabled}`

```
FLOW  = createFlow({ name, enabled, domain })                                  // CRM_APPROVAL_FLOW，payload.domain=domain
START = addNode(flow.id, {node_type:'START', name:'开始', pos:0})
prev  = START
for i, s in stages (pos = i+1):
  N = addNode(flow.id, {node_type:'APPROVER', name: s.stage, pos: i+1})
  addApprover(N.id, {approver_type:'ROLE', role: s.role,
                     empty_approver_action: s.auto_allowed ? 'AUTO_PASS' : 'ASSIGN_ADMIN',
                     multi_approver_mode:'ANY'})
  addLink(prev.id, N.id, {condition_ref:null})
  prev = N
END = addNode(flow.id, {node_type:'END', name:'结束', pos: stages.length+1})
addLink(prev.id, END.id, {condition_ref:null})
```

**软停旧版本**（禁删铁律）：写新前先 `getFlowByDomain(domain)` 找到旧 FLOW 粒子，`updateParticle(old.id, {patch:{enabled:false}})` 并置 `retired_at`，旧 NODE/APPROVER/LINK 随 FLOW 失效（引擎 `loadFlow` 按 `enabled` 过滤 FLOW）。

### §2.3 新增 `src/approval/flow.js` 导出
- `getFlowByDomain(domain)`：`queryParticles({type:'CRM_APPROVAL_FLOW',tenantId}).find(r=>r.payload.domain===domain)` → 返回粒子（含 `id`）
- `writeFlowFromStages(flow)`：§2.2 实现
- `retireFlow(domain)`：软停（置 enabled=false）

---

## §3 运行态解析 — `src/action/seed-actions.js`

### §3.1 business_type → domain 映射
新增模块常量（置于 `seed-actions.js` 顶部或 `src/approval/flow.js`）：
```
const BIZ_DOMAIN = {
  CRM_QUOTATION: 'quote', CRM_CONTRACT: 'contract',
  CRM_INVOICE: 'invoice', CRM_ORDER: 'order', CRM_DEAL: 'deal',
};
```

### §3.2 submit Action 改默认 flow_id
`crm-quote-submit`（:411）、`crm-contract-submit`（:498）、`crm-invoice-submit`（:513）、`crm-order-submit`（:528）、`crm-deal-submit`（:716 附近）的 handler：
- 移除 `flow_id` 必填约束（schema `parameters.required` 去掉 `flow_id`）；保留 `flow_id` 可选覆盖参数
- handler 内：`const domain = BIZ_DOMAIN[business_type] || BIZ_DOMAIN[business_type.replace('CRM_','')]; const flow = await getFlowByDomain(domain); if(!flow) throw new Error('未配置审批流: '+domain); const inst = await startInstance(flow.id, business_type, biz_id, ctx, {submitter});`
- 调用方显式传 `flow_id` 时优先用其（向后兼容 demo 脚本 `scripts/seed-approval-demo.mjs`）

### §3.3 引擎无需改动
`engine.js:loadFlow(flow_id)` 按粒子 id 查，`startInstance` 现收到的是已解析的粒子 id（来自 `getFlowByDomain`）——闭环成立。

---

## §4 改动文件清单（file:line）

| 文件 | 改动 | 行 |
|---|---|---|
| `src/portal/approvalFlow.js` | `defaultDeps` 存储后端：`crm.approval_flow` SQL → 粒子 API；`upsertFlow`→`writeFlowFromStages` | 77-106 |
| `src/approval/flow.js` | 新增 `getFlowByDomain` / `writeFlowFromStages` / `retireFlow` | 末尾追加 |
| `src/action/seed-actions.js` | `BIZ_DOMAIN` 映射；5 个 submit Action 去 `flow_id` 必填 + 按 domain 解析 | 411/498/513/528/716 段 |
| `db/seed.sql` | `crm.approval_flow` INSERT（:286）→ `CRM_APPROVAL_*` 粒子 seed（domain 对齐） | 286+ |
| `db/test-setup.sql` | 同上（:72） | 72+ |
| `docs/superpowers/specs/2026-08-27-approval-flow-config-design.md` | §0.3 已知限制标记「已闭环（2026-08-31）」 | — |

---

## §5 迁移脚本

新建 `db/migrate-approval-flow-wiring.sql`（幂等，`ADD COLUMN IF NOT EXISTS` 安全）：
1. `ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS payload_retired_at TIMESTAMPTZ;` （软停留痕，如需）
2. 将 `crm.approval_flow` 现存行翻译为 `CRM_APPROVAL_*` 粒子（domain=flow_id；stages→节点链），语义同 §2.2
3. 不 DROP `crm.approval_flow` 表（只读兼容 + 审计）
4. 生产库执行需用户授权（属生产写操作）：`PGDATABASE=plm node db/migrate-approval-flow-wiring.js`（建议 .mjs 执行，避免 bash `-e` 吞引号）

---

## §6 测试同步（TDD）

新增 `test/approval-flow-wiring.test.js`（vitest）：
- **翻译正确性**：`writeFlowFromStages({flow_id:'quote', stages:[{stage:'销售经理',role:'manager',action:'approve',auto_allowed:false},{stage:'财务',role:'finance',action:'approve',auto_allowed:true}]})` → 断言生成 1 FLOW + 3 NODE(START/APPROVER/APPROVER/END) + 2 APPROVER（第二节点 `empty_approver_action='AUTO_PASS'`）+ 3 LINK
- **getFlowByDomain**：写后 `getFlowByDomain('quote')` 命中且 `payload.domain==='quote'`
- **软停**：二次写同 domain → 旧 FLOW `enabled=false`，新 FLOW 生效
- **运行态闭环**：`crm-quote-submit` 不传 `flow_id` → `startInstance` 收到解析后的粒子 id（断言 INSTANCE.flow_id 等于新 FLOW.id，非域字符串）
- **configCenter.test.js**：#17 的 id/group/page/endpoint 不变 → 无需改（仅断言配置项存在/分组）

基线：现有 approval 引擎测试 `test/approval-engine.test.js` / `test/approval-flow.test.js`（79+/22+ 行，粒子模型直测）保持全绿，本设计新增 wiring 测试不破坏。

---

## §7 验收口径

1. `npm test` 全绿（新增 wiring 测试 + 既有引擎测试）
2. `npm start` 后访问 `/approval-flow`：编辑 `quote` 流的 stages（如改「财务」为 `auto_allowed=true`）保存 → 运行态 `crm-quote-submit`（不传 flow_id）起单，第二关自动通过（`CRM_APPROVAL_INSTANCE` 经 AUTO_PASS 直过）
3. 运行态「待我审批」工作台（`workbenchRouter` 的 `queryApprovalTasks`）按配置的角色/关卡展示任务——**证明配置真实驱动引擎**
4. 写操作经决策第0闸（`produceDecision` 断言被调用，与现状一致）
5. 无 DELETE（软停仅置 enabled=false）

---

## §8 风险与缓解

| 风险 | 缓解 |
|---|---|
| 运行态调用方若仍传旧 demo uuid `flow_id` → 与 domain 粒子不匹配 | §3.2 保留 `flow_id` 显式覆盖优先；demo 脚本 `scripts/seed-approval-demo.mjs` 不受影响（它直建粒子传 id） |
| `getFlowByDomain` 未配置域（如 `order` 无种子）→ `startInstance` 抛错阻断提交 | 补 `order` 种子（4 域扩 5 域）或引擎既有 fallback（无节点→AUTO_PASS）兜底；验收 §7.2 覆盖 |
| 迁移脚本误改生产库 | 幂等 + 用户授权后执行；先 `information_schema` 核对再跑 |
| 双存储短期并存（`crm.approval_flow` 表残留） | 页面不读该表即无漂移；保留仅审计用途 |

---

## §9 自检结论（写后内审）

- 占位扫描：无 TBD/TODO；`order` 域种子补建已列入 §8 缓解
- 内部一致：§2.2 翻译 ↔ §3.2 解析 ↔ §4 文件清单 file:line 一致
- 约束遵循：禁删（软停）、决策第0闸（沿用）、粒子为事实源（方案 A 精神）均满足
- 范围：单设计可覆盖；运行态仅加 domain 解析（引擎零改），改动面可控
- 歧义：`flow_id` 语义（配置页=domain 字符串 / 引擎=粒子 id）已显式区分并给出解析桥
