# 新行业上线设计：新能源制造（通用画像）

- 日期：2026-09-04
- 依据：`docs/2026-09-03-multi-industry-config-profile-design.md` §1–§16、`docs/runbooks/2026-09-03-new-industry-onboarding.md`
- 技能：`crm-platform-admin/skills/industry-onboarding`
- 状态：**待批准**（未批准后零写入）

---

## 1. 结论先行

新增「新能源制造」= **写一份 tenant-profile 配置画像 + 播种主数据 + 建初始销售员账号**，
**不新增任何粒子类型字面量、不改 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions` 任何一行业务代码**。
行业差异全部收敛在 `tenant_id` 维度下，其它租户天然不可见。

---

## 2. 关键决策

| 决策项 | 取值 | 依据 |
|---|---|---|
| tenant_id | `acme-newenergy` | 沿用 `acme-chem` / `acme-insmedi` / `acme-training` 命名范式 |
| 行业中文名 | 新能源制造 | 用户指定 |
| 画像范围 | 通用（电池 / 储能 / 光伏 / 风电 并集） | 用户选定；首个租户立通用底座，后续按真实客户派生专精租户 |
| 粒子类型前缀 | `NE_`（New Energy） | 仅出现在**配置 JSON** 内，永不进代码常量 |
| 初始销售员 | `newenergy_sales01` | 范式同 `chem_sales01` |
| 主数据播种 | 四类全量（PRODUCT / PRICE_LIST / OFFER_POLICY / DICT_ENTRY） | 默认策略，复制后独立演进 |

---

## 3. Prototypes 设计（通用新能源制造）

| 类型 | label | 阶段流水线 | 自有属性 | 审批域 / 关系 |
|---|---|---|---|---|
| `NE_CLIENT` | 新能源客户 | lead → qualified → proposal → negotiation → signed → delivered → closed | `segment`（电池/储能/光伏/风电）、`annual_capacity`、`safety_cert` | — |
| `NE_SUPPLIER` | 新能源供应商 | candidate → qualified → partnered → active → suspended | `qualification`、`region` | edgeTypes: `supplies`、`distributes` |
| `NE_PRODUCT` | 新能源产品 | development → certified → listed → discontinued | `product_line`、`model_spec`、`rated_capacity`、`unit_price`、`cert_no` | — |
| `NE_PROJECT` | 新能源项目 | lead → need_diagnosed → matched → quoted → confirmed → delivering → closed | `subject`、`budget`、`target`、`delivery_window` | approvalDomains: `quote`、`deal` |
| `NE_CONTRACT` | 新能源合同 | draft → signed → active → fulfilled → terminated | `mode`、`party_a`、`party_b`、`amount` | approvalDomains: `contract` |
| `NE_SETTLEMENT` | 新能源结算 | pending → calculated → approved → paid | `unit_price`、`quantity`、`tax_rate`、`tax_amount` | approvalDomains: `settlement` |

**审批域（租户级）**：`quote` / `contract` / `settlement`

**计算规则（L2 公式，on_write 触发）**

```jsonc
{
  "id": "settlement_tax",
  "target": "NE_SETTLEMENT.payload.tax_amount",
  "expr": "unit_price * quantity * tax_rate",
  "inputs": ["unit_price", "quantity", "tax_rate"],
  "trigger": "on_write"
}
```

> 说明：`rated_capacity` / `cert_no` 等属性存 `payload` JSONB，天然按租户隔离，不产生任何 schema 迁移。

---

## 4. 落地清单（新增 / 修改文件）

| # | 文件 | 动作 | 说明 |
|---|---|---|---|
| 1 | `db/seed/tenant-profile-newenergy.js` | 新增 | 照 `tenant-profile-chemical.js` 范式，导出 `NEWENERGY_TENANT` 与 `seedNewEnergyProfile()` |
| 2 | `db/seed/tenant-users-newenergy.js` | 新增 | 初始销售员，pgcrypto `crypt(pw, gen_salt('bf'))`，`WHERE NOT EXISTS` 幂等 |
| 3 | `db/seed/seed-all-tenants.mjs` | 修改 | 三处追加：profile 播种、`seedTenantDefaults(tenant,{salesThresholds:true})`、主数据播种、销售员播种、结果日志 |
| 4 | `scripts/seed-tenant-master-data.mjs --tenant acme-newenergy` | 执行 | 四类主数据幂等复制（先 `--dry-run` 预演） |
| 5 | KNOWLEDGE 种子 | 执行 | 经 `crm-knowledge-upsert` 播 icp / competitors / objections / buyer_language 各 ≥1 条 |

**红线自查**

- [x] 零粒子类型字面量进代码常量 —— 所有 `NE_*` 仅存在于配置 JSON
- [x] 仅 INSERT / UPSERT 幂等，**禁 DELETE**
- [x] 密码走 pgcrypto 哈希，明文不落日志
- [x] 未触碰 `PARTICLE_TYPES` / `stageTaxonomy` / `seed-actions`

---

## 5. 关于「写必经决策第 0 闸」

`configStore.writeConfig` 支持 `decisionId` 入参。两条路径：

| 路径 | decision_id | 适用场景 | 取舍 |
|---|---|---|---|
| **A · 配置中心 PUT** `/api/config/tenant-profile` | 由第 0 闸 mint | 生产治理态写入 | 符合治理铁律；但**不可复现**——换环境重新部署需重放 |
| **B · 种子脚本** `db/seed/seed-all-tenants.mjs` | `null`（引导豁免） | 系统引导 / 环境重建 | 与既有 3 个行业完全同构，新环境一键重建；属 SKILL 明列的引导豁免路径 |

**建议：B 为主（与既有行业同构、可复现），A 作为生产环境后续调配置的常规通道。**
若要求生产首次写入也带 decision_id，则在 `seedNewEnergyProfile()` 中显式传入由第 0 闸 mint 的 decision_id，需你确认。

---

## 6. 验收清单

- [ ] `resolvePrototype('NE_PRODUCT', 'acme-newenergy')` → `{ source: 'config', ... }`
- [ ] `resolvePrototype('NE_PRODUCT', 'crm')` → `null`（隔离成立）
- [ ] `crm-import-batch` 建 `NE_SETTLEMENT` 一条，`tax_amount` 被 on_write 公式自动回写
- [ ] 带本租户 token 访问 `/api/particles?type=CRM_PRODUCT` 非空（主数据已播种）
- [ ] `/api/knowledge` 可见 icp / competitors / objections / buyer_language 各 ≥1
- [ ] `newenergy_sales01` 可登录，token 携带 `tenantId=acme-newenergy`
- [ ] 回归套件全绿，无 CRM 行为回退

---

## 7. 待办 / 风险

1. **硬阻塞**：MCP 登录闸未通过 —— 需 sysadmin 的 `api_token`（或连接器配置 Basic Auth）后方可执行任何写入。
2. 初始密码交付后**必须首登改密**（平台无强制改密流程，需口头/书面提示）。
3. 通用画像属性取并集，单赛道（如只看电池）会存在空字段 —— 属预期，后续按客户派生专精租户收敛。
