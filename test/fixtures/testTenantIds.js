// test/fixtures/testTenantIds.js
// 测试专用租户 id 的**单一来源**。
//
// ⚠ 为什么不能从 `db/seed/tenant-profile-*.js` 导入 `X_TENANT`：
//   2026-09-09「数据漂移根因修复」(`scripts/_refactor_seed_tenantid.mjs`) **删除了**那些模块里写死的
//   `export const X_TENANT = 'acme-<行业>'` —— 因为真实 tenantId 必须来自 `crm.tenants`
//   （自助注册生成 `co-<hash>`），写死 `acme-*` 会造出**幽灵租户**（种子落到没人用的租户上）。
//   此后 7 个测试文件仍 `import { X_TENANT }`，ESM 下拿到 `undefined`
//   → `seedXxxProfile(undefined)` 抛 `tenantId is required` → 表现为「全 skipped + exit 1」。
//
// ⇒ 修法**必须走测试侧**：给测试一份自己声明的 id。补回 `export const X_TENANT` 等于回退 09-09 的修复，
//   属把「数据漂移根因」重新引入，禁止。
//
// 作用域与安全边界：
//   - 仅在 `crm_native_test` 生效（`vitest.config.js` 强制 `PGDATABASE=crm_native_test`）；
//   - 刻意**不复用 `acme-<行业>` 命名**（避免又一次幽灵租户），也不注册进 `crm.tenants`；
//   - 若误连主库，这些 id 也一眼可辨为测试产物（`test-tenant-*`），不与环境里任何真实租户同名。
export const TRAINING_TENANT = 'test-tenant-training';
export const CHEM_TENANT = 'test-tenant-chemical';
export const INSMEDI_TENANT = 'test-tenant-insmedi';
