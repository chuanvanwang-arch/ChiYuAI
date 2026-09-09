---
name: industry-onboarding
description: 在 CRM-ai-native 平台新增一个行业租户（培训 / 制造 / 化工 / 医疗 / 保险 …）的标准上线 Runbook。触发词：新行业、启用行业、开行业租户、行业上线、tenant onboarding、加行业。核心范式：universal core（代码基线原型）+ per-tenant profile（配置画像）+ 业务数据驱动自适应。零粒子类型字面量、零新增代码、零污染其它租户。最终交付物 = 该行业第一个可登录销售员的用户名 + 密码。
type: domain
immutable_baseline: true
related_skills:
  - user-rbac-admin          # Step 9 初始销售员账号交付 = user-rbac-admin 的用户新增范式
  - system-bootstrap         # Step 1 隔离迁移属于系统初始化范畴
  - crm-config-center-settings   # tenant-profile 经配置中心 PUT 落地（自带决策第0闸）
---

# 新行业上线 Runbook（多行业配置化元模型）

> 设计依据：`docs/2026-09-03-multi-industry-config-profile-design.md` §1–§16。
> 平台**没有「行业」维度**——行业差异 = 租户画像（tenant-profile）演化的自然结果。新行业 = 写一份配置 + 业务数据，**不碰任何代码常量**。

## 0. 红线（先读，全程不可破）

| 红线 | 说明 |
|---|---|
| 禁 DELETE | 去重走 `meta.merged_into` 软合并；任何删除操作不落地。 |
| 写必经决策第 0 闸 | 一切写操作强制带 `decision_id`（无决策不写）；对话式写还需 HITL 确认。 |
| 配置画像零代码 | 新行业 = 一份 `tenant-profile` 配置；**绝不**在 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 加任何行业字面量。 |
| 隔离天然成立 | 所有差异按 `tenant_id` 隔离；不配置的行业对其它租户不可见。 |

## 1. 何时调用本 SKILL

用户说「启用 / 上线 / 新增一个行业（如化工、培训、制造）」「给 XX 行业开个租户」。按序执行 Step 1 → Step 4B → Step 5；Step 5 的**初始销售员账号（用户名+密码）即最终交付物**；Step 4B 确保租户开箱即得主数据（product-catalog 非空）。

## 2. Step 1 — 跑隔离迁移（生产库首步，若尚未就位）

新增 `tenant_id` 维度 + `edges.cardinality`，一次性幂等脚本：

```powershell
# 生产库（crm_native）先探活，再跑迁移
$env:PGDATABASE="crm_native"
node db/migrate.js            # 或单独执行：
# psql -h 127.0.0.1 -p 5433 -U agent2b -d crm_native -f db/migrations/2026-09-03-tenant-isolation.sql
```

脚本 `db/migrations/2026-09-03-tenant-isolation.sql` 幂等（`IF NOT EXISTS` / `ON CONFLICT`），可重复执行。
**校验**：`test/meta-model/isolation.test.js` 确认 `meta_attr` / `memory_log` / `memory_snapshot` / `memory_note` 有 `tenant_id`、`edges` 有 `cardinality`。

## 3. Step 2 — 写 tenant-profile 配置画像

新行业 = 写一份后台配置（落 `config_store` 表 `key='tenant-profile'`，`tenant_id=<新租户>`）。声明该行业自有对象（prototypes）+ 各自阶段流水线 + 审批域 + 计算规则 + 关系谓词。

### 3.1 字段契约

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

### 3.2 落地方式（二选一，均须过决策第 0 闸）

**方式 A — 配置中心 PUT（推荐，自带第 0 闸）**
```
PUT /api/config/tenant-profile
Authorization: Bearer <token>
Body: { "value": <上面的 JSON>, "tenantId": "acme-training" }
```
配置中心 PUT 自带决策第 0 闸，无需命令行绕行（设计铁律）。详见 `crm-config-center-settings` SKILL。

**方式 B — 种子脚本（系统引导，须显式 decision_id）**
```powershell
$env:PGDATABASE="crm_native_test"
# ⚠ 必须先拿到真实 tenantId（自助注册返回 co-<hash>，或建租户 API 指定 slug），再传给脚本：
node db/seed/tenant-profile-<industry>.js <真实tenantId>   # 例：node db/seed/tenant-profile-consult2.js co-036cq4k
```
> 生产写须经决策第 0 闸；种子脚本 `bootstrap` 旁路仅用于测试 / 系统引导。
> ⚠ **tenantId 必须传真实值**：脚本已改为必传参数（缺省即报错退出）。切勿套用 `acme-<行业>` 占位 slug —— 会与自助注册生成的 `co-<hash>` 真实租户 ID 分裂，导致种子数据写偏/写丢（本次 6-vs-8 漂移根因）。

> ⚠️ **Windows 直跑守卫坑（2026-09-09 实践实证）**：种子脚本内的直跑守卫若写成
> `if (import.meta.url === \`file://${process.argv[1]}\`)`（现状：`db/seed/tenant-profile-chemical.js:64`），
> 在 win32 下因**盘符大小写（d: vs D:）+ 路径分隔符（\ vs /）不一致**永不成立 →
> `node db/seed/xxx.js` 直跑**静默无操作**（守卫失效，main 永不执行）。
> 正解二选一：
> ① **归一化守卫**：`const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();`（范式：`scripts/seed-tenant-master-data.mjs:116-118`）；
> ② **显式调用**：守卫失效时直接 `import { seedXxx } from 'db/seed/xxx.js'` 后 `await seedXxx()`，不依赖直跑。

## 4. Step 3 — 验证双源类型解析（隔离自检）

```js
import { resolvePrototype } from 'src/particles/particleModel.js';
// 本租户 → 配置源
await resolvePrototype('TRAINING_PROJECT', 'acme-training'); // { source:'config', ... , type:'TRAINING_PROJECT' }
// 其它租户 → 不可见（隔离）
await resolvePrototype('TRAINING_PROJECT', 'crm');           // null
```
`resolvePrototype(type, tenantId)` = **代码基线（PARTICLE_TYPES）∪ 租户 tenant-profile.prototypes**；代码类型首分支即返回，**不碰 DB、CRM 行为零破坏**。新行业类型永不进 `PARTICLE_TYPES`。

## 5. Step 4 — 经真实写通道建粒子（MCP = actionExecutor.dispatch）

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

## 5. Step 4B — 播种本租户主数据（system 模板复制，Plan B 落地）

新租户开箱即拥有一份**本租户自有**的四类主数据副本（CRM_PRODUCT / CRM_PRICE_LIST / CRM_OFFER_POLICY / CRM_DICT_ENTRY），来源为 `system` 模板库。复制后**独立演进**，行业画像不裁剪。

```powershell
# 测试库预演（确认复制/跳过条数，不落库）
$env:PGDATABASE="crm_native_test"
node scripts/seed-tenant-master-data.mjs --tenant acme-chem --dry-run
# 正式播种（幂等 INSERT ... ON CONFLICT (stable_key) DO NOTHING）
node scripts/seed-tenant-master-data.mjs --tenant acme-chem
```

可选配置（落 `tenant-profile.masterData`，默认四类全复制）：

```jsonc
{ "masterData": {
    "enabled": true,
    "types": ["CRM_PRODUCT","CRM_PRICE_LIST","CRM_OFFER_POLICY","CRM_DICT_ENTRY"],
    "filter": { "CRM_PRODUCT": { "category": ["软件","印制服务","服务"] } }
} }
```

- `enabled=false` → 不复制任何主数据（极端空目录场景）。
- `filter` 仅作用于 `CRM_PRODUCT.payload.category`；其余类型默认全复制。
- 铁律：仅 INSERT 幂等、禁 DELETE；系统写 `decision_id=NULL`；复制后 `embedding/content_hash/fts=NULL`（首次编辑触发写时索引）。

## 4.5 Step 4.5 — 播种租户 KNOWLEDGE 种子（P0-② 领域 Know-How）

新行业上线即拥有本租户自有的领域 Know-How（设计：`docs/2026-09-03-tenant-knowledge-design.md` §8）。批量建四类初始条目，落 `tenant_id=本租户`（方案 B：全部数据按租户自有）。

> ⚠️ **通道选择（2026-09-09 实践实证）**：`crm-knowledge-upsert` 的 `rbac_roles` 白名单为
> `['manager','presales','exec','sysadmin']`（`src/action/seed-actions.js:224`；`POST /api/knowledge` 角色闸 `routes.js:3156` 同白名单），
> **不含 `sales`**——上线刚产出的初始销售员（role=sales）经 MCP / API 通道播种知识必被
> 第 1.5 闸拒（`gate='permission_denied'`，`src/action/executor.js:92-96`）。
> **上线引导正解 = bootstrap 通道**：dispatch 时 ctx 带 `bootstrap:true` + `actor:'system'`，
> 依 `executor.js:50/92/105` 同时豁免第 0 闸 / 第 1.5 角色闸 / 套餐闸。
> bootstrap 旁路**仅限系统引导 / 种子态**；上线后的日常知识录入仍走角色闸（manager 及以上 + 第 0 闸 decision_id）。

```js
// 上线引导播种：bootstrap 通道（sales 角色不可经 MCP/API 通道录入，见上注）
await actionExecutor.dispatch('crm-knowledge-upsert', {
  term: '化工买手-决策链', kind: 'icp',
  content: '主要对接采购/技术双线，预算单在 Q3 集中释放',
  source: 'industry-bootstrap',
}, { tenantId: 'acme-chem', actor: 'system', bootstrap: true });
// 同法播种 competitors / objections / buyer_language 各 ≥1 条
```

链路：bootstrap dispatch → `crm-knowledge-upsert` → 闸门豁免（bootstrap:true）→ `createParticle('CRM_KNOWLEDGE')` → 写时 embedding + meta_attr 自适应登记。

**验收**：`resolvePrototype` 隔离依旧成立；本租户 `GET /api/knowledge` 可见 icp/competitors/objections/buyer_language 各 ≥1；`assembleContext` 装配输出含 `layers.LK`（对应 scenario 的 kind）。

## 6. Step 5 — 产出初始销售员账号（最终交付物）

新行业上线的最终交付不是「系统跑通」，而是**该行业的第一个可登录销售员**。账号落在 `crm.crm_users`，`tenant_id` 锁定本租户，与平台引导账号（`admin`/`alice` 属 `system` 租户）按 `tenant_id` 天然隔离；登录经 `src/http/auth.js:login()`，token 自动携带 `tenantId`，后续所有写读按租户收敛。

**范式**（与 `db/seed-users.sql` 一致）：`pgcrypto crypt($pw, gen_salt('bf'))` 哈希，明文永不出库 / 不写日志。

```js
// db/seed/tenant-users-<industry>.js（照抄改行业，参考 tenant-users-chemical.js）
import { queryWrite } from '../../src/db.js';
import { IND_TENANT } from './tenant-profile-<industry>.js';

export const IND_INITIAL_SALES_USERNAME = '<ind>_sales01';
export const IND_INITIAL_SALES_PASSWORD = '<Ind>@2026!';   // 初始密码，交付后须改密

export async function seed<Ind>SalesUser(tenantId = IND_TENANT,
  { username = IND_INITIAL_SALES_USERNAME, password = IND_INITIAL_SALES_PASSWORD } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name, org_id, tenant_id)
     SELECT $1, crypt($2, gen_salt('bf')), 'sales', $3, $4, $5
     WHERE NOT EXISTS (SELECT 1 FROM crm.crm_users WHERE username=$1)`,
    [username, password, '<行业>初始销售员', tenantId, tenantId]);
  return r.rowCount; // 1=新建, 0=已存在（幂等）
}
```

> 治理提示：用户管理写 `crm.crm_users` 经决策第 0 闸 + `sysadmin` 角色（routes.js:386）。本种子脚本为**引导 / 测试态**幂等直插，与 `seed-users.sql` 同范式；生产环境应通过 `user-rbac-admin` 的用户新增通道（须 `crm_login` 登录验证 + `sysadmin` 角色）落库并强制首登改密。

## 7. 上线检查清单

- [ ] 生产库已跑 `2026-09-03-tenant-isolation.sql`（若启用多租户）
- [ ] `tenant-profile` 配置经配置中心 PUT 落入（带 decision_id，非命令行绕行）
- [ ] `resolvePrototype(type, tenantId)` 本租户返回 config 源、crm 租户返回 null
- [ ] 经 `crm-import-batch`（MCP）建粒子成功，on_write 公式自动回写
- [ ] 经 `scripts/seed-tenant-master-data.mjs --tenant <id>` 播种本租户主数据成功（验收：带本租户 token 访问 `/api/particles?type=CRM_PRODUCT` 非空）
- [ ] **本租户 KNOWLEDGE 种子已播种**（`GET /api/knowledge` 可见 icp/competitors/objections/buyer_language 各 ≥1）
- [ ] 回归套件全绿，无 CRM 行为回退
- [ ] 未触碰 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 任何行业字面量（禁污染铁律）
- [ ] **初始销售员账号已建**（`tenant_id=本租户`、`role=sales`），凭据已交付（见 Step 5）

## 8. 调用示范（化工行业）

**用户指令**：「给『化工』行业开个租户」 → 调本 SKILL，按 Step 1–6 执行：

1. 生产库跑 `db/migrations/2026-09-03-tenant-isolation.sql`（幂等，已就位则跳过）。
2. `PUT /api/config/tenant-profile`，Body：
   ```json
   { "tenantId":"acme-chem",
     "value": {
       "tenantId":"acme-chem",
       "prototypes": { "CHEM_PRODUCT": { "label":"化工品", "flow":["quote","ordered"], "attributes":["cas","grade"], "edgeTypes":["produces"] } },
       "approvalDomains":["quote","contract"],
       "calculations":[{ "id":"commission", "target":"CHEM_SETTLEMENT.payload.commission", "expr":"revenue*commission_rate", "inputs":["revenue","commission_rate"], "trigger":"on_write" }]
     } }
   ```
   （PUT 自带决策第 0 闸，无需命令行绕行 —— 详见 `crm-config-center-settings`）
3. `resolvePrototype('CHEM_PRODUCT','acme-chem')` → `{source:'config',...}`；`resolvePrototype('CHEM_PRODUCT','crm')` → `null`（隔离验证）。
4. `actionExecutor.dispatch('crm-import-batch',{particle_type:'CHEM_SETTLEMENT',rows:[{slug:'s1',title:'结算1',revenue:10000,commission_rate:0.1}],mode:'upsert',required:['slug']},{tenantId:'acme-chem',actor:'system',decision_id:'<第0闸>'})` → on_write 公式自动算 `commission=1000`。
5. `actionExecutor.dispatch('crm-knowledge-upsert',{term:'化工买手-决策链',kind:'icp',content:'主要对接采购/技术双线，预算单在 Q3 集中释放',source:'industry-bootstrap'},{tenantId:'acme-chem',actor:'system',bootstrap:true})` → 本租户 KNOWLEDGE 种子（bootstrap 通道豁免角色闸——sales 不在 `crm-knowledge-upsert` 白名单；同法建 competitors/objections/buyer_language 各 ≥1）。
6. `db/seed/tenant-users-chem.js acme-chem` 建初始销售员 → **最终交付：用户名 `chem_sales01` / 密码 `Chem@2026!`**（角色 `sales`，租户 `acme-chem`，token.tenantId 隔离；脚本 tenantId 必传，须传真实租户 ID）。

## 9. 铁律声明

本 SKILL 是**领域专属**上线操作手册，与 10 大 ai-* 方法论能力 SKILL **无关、不交叉写入**。通用方法论以交叉引用复用，绝不向 ai-* 基线增删改任何内容。
