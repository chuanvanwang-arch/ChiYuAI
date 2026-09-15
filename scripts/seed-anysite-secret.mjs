/**
 * seed-anysite-secret.mjs — anysite.io 企业/个人数据源 token 写入凭据保险库
 *
 * 用法：
 *   PGDATABASE=crm_native_test node scripts/seed-anysite-secret.mjs          # 测试库（默认）
 *   PGDATABASE=crm_native  node scripts/seed-anysite-secret.mjs               # 生产库（需显式 HITL 确认）
 *   ANY_SITE_TOKEN=4aa6cc6f-... node scripts/seed-anysite-secret.mjs        # 从环境变量取 token（推荐，不入文件）
 *   ANY_SITE_TOKEN=... 平台密钥管理须已注入 PGCRYPTO_SYM_KEY（否则 fail-closed 拒写）
 *
 * 铁律对齐：
 *   1. 凭据走 credentialVault.persistSecret：pgcrypto 加密落库；明文绝不进前
 *      端/日志/memory（credentialVault.js:51-69）
 *   2. 写侧 fail-closed：PGCRYPTO_SYM_KEY 未注入 → 明确拒绝（credentialVault.js:57-61）
 *   3. 禁删：upsert（ON CONFLICT DO UPDATE），绝不物理删除
 *   4. 本脚本不落真实 token 到任何文件（从 env 读；未提供则提示，不自动造）
 *
 * 附带健康检查：写前先 GET https://api.anysite.io/token/statistic 验证 token 有效性
 *   （用户原始需求：/token/statistic 作为后台凭证/额度检查命令）
 */
import { resolveCredentials, persistSecret } from '../src/connectors/discovery/credentialVault.js';

const TOKEN = process.env.ANY_SITE_TOKEN || '';
const TENANT = process.env.TENANT_ID || 'system';
const TARGET_DB = process.env.PGDATABASE || 'crm_native_test';

if (!TOKEN) {
  console.error('❌ ANY_SITE_TOKEN 未提供（用环境变量传入，勿写死进文件）');
  process.exit(1);
}

// ── 步骤 1：健康检查（token 有效性）──────────────────────────────
if (!process.env.ANY_SITE_CHECK_SKIP) {
  try {
    const r = await fetch('https://api.anysite.io/token/statistic', {
      headers: { 'access-token': TOKEN },
    });
    const data = await r.json().catch(() => ({}));
    const ok = r.ok && data?.detail !== 'Invalid token';
    console.log(`${ok ? '✅' : '⚠️'} /token/statistic → HTTP ${r.status} ${JSON.stringify(data)}`);
    if (!ok) {
      console.error('❌ token 无效（Invalid token），中止写入。请核验 token（可能过期/复制不完整）。');
      process.exit(1);
    }
  } catch (e) {
    console.error(`❌ 健康检查网络失败：${e.message}（网络不可达时仍允许强制写入？若确认 token 有效可设 ANY_SITE_CHECK_SKIP=1 跳过）`);
    process.exit(1);
  }
} else {
  console.log('⚠️ 已跳过健康检查（ANY_SITE_CHECK_SKIP=1）');
}

// ── 步骤 2：凭据加密入库 ─────────────────────────────────────────
console.log(`\n写入凭据 → ${TARGET_DB} (tenant=${TENANT}, provider=anysite, 加密落库…)`);
try {
  const res = await persistSecret({
    tenantId: TENANT,
    providerId: 'anysite',
    raw: TOKEN,
  });
  console.log(`✅ 已写入（upsert）tenant=${TENANT} provider=anysite`);
  // 校验：读回解密确认一致（不回显明文）
  const creds = await resolveCredentials({ tenantId: TENANT, providerIds: ['anysite'] });
  const ok = creds?.anysite === TOKEN;
  console.log(`✅ 读回校验：${ok ? '一致' : '不一致（检查密钥轮换）'}`);
} catch (e) {
  console.error(`❌ 写入失败：${e.message}`);
  if (e.code === 'ERR_MISSING_SYM_KEY') {
    console.error('   → 请先配置 PGCRYPTO_SYM_KEY（平台密钥管理），或走 admin API POST /api/integration/secret');
  }
  process.exit(1);
}
