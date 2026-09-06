# 新行业上线 Runbook（多行业配置化元模型）

> 适用：在 CRM-ai-native 平台新增一个行业租户（如培训中介、制造、医疗…），**零粒子类型字面量、零新增代码、零污染其它租户**。
> 设计依据：`docs/2026-09-03-multi-industry-config-profile-design.md` §1–§16；实施计划 `docs/superpowers/plans/2026-09-03-multi-industry-meta-model.md`。
> 核心范式：**universal core（代码基线 33 个 CRM 原型）+ per-tenant profile（配置画像）+ evolution engine（业务数据驱动自适应）**。平台没有「行业」维度，行业差异 = 租户画像演化的自然结果。

---

## 0. 红线（先读，全程不可破）

| 红线 | 说明 |
|---|---|
| 禁 DELETE | 去重走 `meta.merged_into` 软合并；任何删除操作不落地。 |
| 写必经决策第 0 闸 | 一切写操作强制带 `decision_id`（无决策不写）；对话式写还需 HITL 确认。 |
| 配置画像零代码 | 新行业 = 一份 `tenant-profile` 配置；**绝不**在 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 加任何行业字面量。 |
| 隔离天然成立 | 所有差异按 `tenant_id` 隔离；不配置的行业对其它租户不可见。 |

---

## 1. 跑隔离迁移（生产库首步）

新增 `tenant_id` 维度 + `edges.cardinality`，一次性幂等脚本：

```powershell
# 生产库（crm_native）先探活，再跑迁移
$env:PGDATABASE="crm_native"
node db/migrate.js            # 或单独执行：
# psql -h 127.0.0.1 -p 5433 -U agent2b -d crm_native -f db/migrations/2026-09-03-tenant-isolation.sql
```

脚本 `db/migrations/2026-09-03-tenant-isolation.sql` 幂等（`IF NOT EXISTS` / `ON CONFLICT`），可重复执行。
**校验**：`test/meta-model/isolation.test.js`（5/5）确认 `meta_attr` / `memory_log` / `memory_snapshot` / `memory_note` 有 `tenant_id`、`edges` 有 `cardinality`。

> 注：`db/schema.sql` 已是该列的单一事实源（含 `memory_log.tenant_id`），后续 DDL 改三处（schema + 迁移 + ensure）时勿漏。

---

## 2. 写 tenant-profile 配置画像

新行业 = 写一份后台配置（落 `config_store` 表 `key='tenant-profile'`，`tenant_id=<新租户>`）。声明该行业自有对象（prototypes）+ 各自阶段流水线 + 审批域 + 计算规则 + 关系谓词。

### 2.1 字段契约

```jsonc
{
  "tenantId": "acme-training",          // 本租户标识（= 隔离维度）
  "prototypes": {
    "<TYPE>": {
      "label": "企业客户",             // 中文展示名（替代代码类型标签）
      "flow": ["lead","diagnosed",...], // 业务阶段流水线（自有，不污染 CRM 的 S1–S6）
      "attributes": ["budget","goal"],  // 行业自有属性（存 payload JSONB，天然隔离）
      "identity": ["name"],            // 可选：标识字段（缺省回退 []，写不强制）
      "approvalDomains": ["quote","deal"], // 可选：审批域（走后台审批配置）
      "edgeTypes": ["supplies"]         // 可选：行业自有关系谓词（受控谓词并集）
    }
  },
  "approvalDomains": ["quote","contract","settlement"],
  "calculations": [                    // 可选：L2 公式（on_write 触发）
    { "id":"settlement_commission",
      "target":"TRAINING_SETTLEMENT.payload.commission",
      "expr":"(revenue - cost) * commission_rate",
      "inputs":["revenue","cost","commission_rate"],
      "trigger":"on_write" }
  ]
}
```

### 2.2 落地方式（二选一，均须过决策第 0 闸）

**方式 A — 配置中心 PUT（推荐，自带第 0 闸）**
```
PUT /api/config/tenant-profile
Authorization: Bearer <token>
Body: { "value": <上面的 JSON>, "tenantId": "acme-training" }
```
配置中心 PUT 自带决策第 0 闸，无需命令行绕行（设计铁律）。

**方式 B — 种子脚本（系统引导，须显式 decision_id）**
```powershell
$env:PGDATABASE="crm_native_test"
node db/seed/tenant-profile-training.js   # 参考实现：db/seed/tenant-profile-training.js
```
> 生产写须经决策第 0 闸；种子脚本 `bootstrap` 旁路仅用于测试/系统引导。

---

## 3. 验证双源类型解析（隔离自检）

```js
import { resolvePrototype } from 'src/particles/particleModel.js';
// 本租户 → 配置源
await resolvePrototype('TRAINING_PROJECT', 'acme-training'); // { source:'config', ... , type:'TRAINING_PROJECT' }
// 其它租户 → 不可见（隔离）
await resolvePrototype('TRAINING_PROJECT', 'crm');           // null
```
`resolvePrototype(type, tenantId)` = **代码基线（PARTICLE_TYPES）∪ 租户 tenant-profile.prototypes**；代码类型首分支即返回，**不碰 DB、CRM 行为零破坏**。新行业类型永不进 `PARTICLE_TYPES`。

---

## 4. 经真实写通道建粒子（MCP = actionExecutor.dispatch）

MCP 写工具即 `actionExecutor.dispatch(session.action, session.params, ctx)`（`src/mcp/gateway.js:150`）。最典型的写入口：

```js
// 等价于经 MCP 调用 crm-import-batch
await actionExecutor.dispatch('crm-import-batch', {
  particle_type: 'TRAINING_SETTLEMENT',
  rows: [{ slug:'s1', title:'结算1', revenue:100, cost:60, commission_rate:0.1 }],
  mode: 'upsert', required: ['slug'],
}, { tenantId:'acme-training', actor:'system', decision_id:'<第0闸 mint 的 decision_id>' });
```

链路：`crm-import-batch` → `importBatch` → `createParticle` → `resolvePrototype`（双源解析类型）→ 写库 → `runProfileCalculations`（on_write 公式回写 payload）。
**本步自动验证**：结算单 `commission` 被自动算为 `(100-60)*0.1 = 4`，无需任何代码。

端到端回归锁：`test/integration/training-tenant-e2e.test.js`（4/4）——真实 dispatch 写入 + 公式 + 隔离 + 受控谓词 + `listMetaAttr` 合并。

---

## 5. 关系与受控谓词

行业自有关系（如培训机构 `supplies` 培训项目）零代码声明于 `prototypes[*].edgeTypes`：

```js
import { createEdge } from 'src/particles/particleRepo.js';
import { isControlledPredicateConfig } from 'src/particles/particleModel.js'; // 注意：该函数导出在 particleModel.js
await createEdge('TRAINING_PROVIDER', srcId, 'supplies', 'TRAINING_PROJECT', tgtId, {}, 'acme-training');
// → edge_type='supplies', cardinality='many'
await isControlledPredicateConfig('supplies', 'acme-training'); // true（本租户可见）
await isControlledPredicateConfig('supplies', 'crm');           // false（隔离，crm 不认识 supplies）
// 乱写谓词被拒：throw /未受控谓词/
```

受控谓词 = **基线 `CONTROLLED_PREDICATES` ∪ 本租户 `profile.edgeTypes`**；其它租户天然不可见。

---

## 6. 字段可见性（universal core + per-tenant override）

```js
import { listMetaAttr } from 'src/metaAttr/metaAttrRepo.js';
// 非 system 租户查询 = 自身属性 ∪ system 基线（universal core 合并，租户覆盖优先）
const rows = await listMetaAttr({ particleType:'CRM_DEAL', tenantId:'acme-training', applyPermission:true });
```

- `applyPermission:true` 按 `permission.deny_tenants` 隐藏对当前租户不可见的字段。
- 配置租户自动继承 universal core（`system` 基线）属性，无需重复声明。

---

## 7. AI Fill（草稿引擎）

```js
import { proposeAiFill } from 'src/agent/aiFillEngine.js';
// 只产草稿：source='ai' / enabled=false，须经决策第 0 闸 + HITL 确认后才落库。
// 注意：参数名是 prototype（非 particleType），且需 rawContext 供 LLM/确定性兜底抽取字段（非 fields）。
const draft = await proposeAiFill({ prototype:'TRAINING_CLIENT', tenantId:'acme-training', rawContext:'客户年度预算 500 万，目标提升产能' });
```
AI Fill **只建议不直写**；落库须经决策第 0 闸 + HITL（零信任）。

---

## 8. 回归验证（提交前必跑）

```powershell
$env:PGDATABASE="crm_native_test"
node node_modules/vitest/vitest.mjs run test/meta-model test/calc test/agent test/integration
# 基线：meta-model/calc/agent 76/76 + account-insight/guard/360 集成 36/36；
# + 化工样例 integration 12/12（chemical-tenant-runbook-validation 8 + chemical-sales-user 4）
```
全绿即证明：隔离维度生效、双源解析正确、公式引擎安全、AI Fill 草稿化、零污染 CRM、初始销售员可登录且租户隔离。

---

## 9. 上线检查清单

- [ ] 生产库已跑 `2026-09-03-tenant-isolation.sql`
- [ ] `tenant-profile` 配置经配置中心 PUT 落入（带 decision_id，非命令行绕行）
- [ ] `resolvePrototype(type, tenantId)` 本租户返回 config 源、crm 租户返回 null
- [ ] 经 `crm-import-batch`（MCP）建粒子成功，on_write 公式自动回写
- [ ] `isControlledPredicateConfig` 本租户认得行业谓词、其它租户不认得
- [ ] `listMetaAttr(applyPermission)` 合并 system 基线
- [ ] 回归套件全绿，无 CRM 行为回退
- [ ] 未触碰 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 任何行业字面量（禁污染铁律）
- [ ] **初始销售员账号已建**（`tenant_id=本租户`、`role=sales`），凭据已交付（见 §10）

---

## 10. 产出初始销售员账号（最终交付物）

新行业上线的最终交付不是"系统跑通"，而是**该行业的第一个可登录销售员**。账号落在 `crm.crm_users`，`tenant_id` 锁定本租户，与平台引导账号（`admin`/`alice` 属 `system` 租户）按 `tenant_id` 天然隔离；登录经 `src/http/auth.js:login()`，token 自动携带 `tenantId`，后续所有写读按租户收敛。

**范式**：与 `db/seed-users.sql`（admin/alice）一致 —— `pgcrypto crypt($pw, gen_salt('bf'))` 哈希，明文永不出库/不写日志。

```js
// db/seed/tenant-users-chemical.js（化工样例，照抄改行业）
import { queryWrite } from '../../src/db.js';
import { CHEM_TENANT } from './tenant-profile-chemical.js';

export const CHEM_INITIAL_SALES_USERNAME = 'chem_sales01';
export const CHEM_INITIAL_SALES_PASSWORD = 'Chem@2026!';   // 初始密码，交付后须改密

export async function seedChemicalSalesUser(tenantId = CHEM_TENANT,
  { username = CHEM_INITIAL_SALES_USERNAME, password = CHEM_INITIAL_SALES_PASSWORD } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '化工行业初始销售员', tenantId, tenantId]);
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}
```

**交付物（化工行业实测值）**：

| 项 | 值 |
|---|---|
| 用户名 | `chem_sales01` |
| 初始密码 | `Chem@2026!` |
| 角色 | `sales` |
| 租户 | `acme-chem` |
| 登录态 token.tenantId | `acme-chem`（跨租户隔离） |

**校验**：

```powershell
$env:PGDATABASE="crm_native_test"
node node_modules/vitest/vitest.mjs run test/integration/chemical-sales-user.test.js
# 4/4：可登录 + role=sales + tenantId=acme-chem + 错误密码被拒 + 与 crm 账号零交叉
```

> 治理提示：用户管理写 `crm.crm_users` 经决策第 0 闸 + sysadmin 权限（routes.js:386）。本种子脚本为**引导/测试态**幂等直插，与 `seed-users.sql` 同范式；生产环境应通过配置中心用户管理通道落库并强制首登改密。

---

## 附：与「加行业维度」方案的对比（为何走配置画像）

| 维度 | 加行业字段/枚举 | 本 Runbook（tenant-profile） |
|---|---|---|
| 行业差异存放 | 散落代码常量 + 分支 | 一份后台配置 JSON |
| 新行业成本 | 改代码 + 发版 | 写一份配置 + 业务数据 |
| 其它租户影响 | 需 if 隔离，易漏 | 按 `tenant_id` 天然隔离 |
| 类型定义可配置 | 否（硬编码） | 是（prototype 声明即生效） |
| 治理闸 | 写操作各自补 | 统一决策第 0 闸 + HITL |

结论：**真·配置化 = 启用后台配置即差异化**，而非「复用 CRM 硬编码类型 + 配置皮肤」。
