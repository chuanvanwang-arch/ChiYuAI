-- 信号投递 / 泵窗口 系统模板两键（2026-09-16 全链集成 Q1「出口接电」）
-- (system,'signal-delivery') = 渠道开关 + 逐级路由 + 收件人 + 静默时段/限速/重试（src/signal/route.js 消费）
-- (system,'signal-dispatch') = 泵候选集时间窗（src/signal/dispatcher.js 消费，D2）
--
-- 用户裁决（2026-09-16）：**对当前所有租户统一采用**——不逐租户挑选取舍、无租户豁免、无特殊分支。
--   落地方式 = 播 `system` 平台模板两键，由 configStore.readConfig 的 autoSeed 克隆到**每一个**租户
--   （含 `system` 自身）——这是本仓「全租户配置」的唯一标准范式（同 migration-lead-pool-config.sql /
--   migration-sync-config.sql），且自动覆盖**后续新建**租户，无需枚举租户名（枚举必然漏掉未来租户）。
--
-- ⚠ 存在理由（本键缺失时的真实后果，2026-09-16 本地 crm_native 实测）：
--   signal-delivery 零行 → route.loadPolicy 返 `delivery_config_missing`
--   → resolve 返空 decisions → 泵每 5 分钟空转且零投递 → crm.signal_delivery 恒 0 行；
--   同时 signalMetrics 判据 A（delivery_silent）因 channels.length===0 而**不触发**
--   → 面板「红框消失」但链路并未接通（判据与链路同时静默，是本项目最危险的组合）。
--
-- ⚠ 渠道默认：**仅 `inbox` 开启**。inbox 属 IN_PLATFORM_CHANNELS（平台内视角消费 crm.signal），
--   无外部收件人、无凭据、无外发副作用 ⇒ 可安全出厂默认开启。
--   email / im / webhook **显式写 off**：三者需外部凭据与**真实收件人**，出厂即开会造成不可撤回的外发
--   （本机 .env 含真实 SMTP_* —— 冒然开启会真发邮件给真实收件人）。
--   与 migration-sync-config.sql 的 `enabled:false + 占位 endpoint` 同一立场：**模板骨架 ≠ 已接通**。
--   运营在配置中心启用外发渠道时，须同时配置 role_recipients（否则 recipientMiss → skip 并留痕，不静默）。
--
-- ⚠ 与 `require_export_healthy`（standing-grants-policy）的顺序纪律（不可颠倒）：
--   本文件只让出口判据①**具备**成立条件；判据①真正成立还需**泵实际跑过一轮**（定时器⑰ signal-dispatch）。
--   **先播配置并确认泵已产出 sent 行 → 再考虑开启回写/自治前置闸门**；反之会「上线即停摆」。
--
-- ⚠ 第 0 闸归属：本播种属**出厂默认**（bootstrap / 系统引导类，与 executor.js 的 ctx.bootstrap 豁免同源，
--   同 lead-pool-config / sync-config 范式），不携带 decision_id；
--   而**运营改渠道开关**属业务写，必须走配置中心 HTTP 通道（writeConfig 携带 decision_id）满足第 0 闸。
--
-- 幂等：WHERE NOT EXISTS（两代主键下均成立 —— 旧库 key 单列 PK / migrate-tenant 升级后 (tenant_id,key)
--   复合 PK；复合 PK 下 `ON CONFLICT (key)` 会报 no unique constraint，故一律不用 ON CONFLICT）。
-- 禁删铁律：仅 INSERT，不删不改任何既有行（已存在即跳过，绝不覆盖运营改过的配置）。
-- 执行渠道（双通道）：① 生产/新库 —— db/migrate.js 的 INCREMENTAL_SQL 清单（容器启动即跑）；
--   ② 测试库 —— scripts/seed-test-config.mjs 的 ensureSignalConfig()（pretest 读取本文件）。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'signal-delivery', '{
  "version": 1,
  "channels": { "inbox": "on", "email": "off", "im": "off", "webhook": "off" },
  "route": {},
  "role_recipients": {},
  "quiet_hours": null,
  "rate_limit": null,
  "retry": 0
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='signal-delivery');

INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'signal-dispatch', '{
  "version": 1,
  "max_age_days": 7
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='signal-dispatch');
