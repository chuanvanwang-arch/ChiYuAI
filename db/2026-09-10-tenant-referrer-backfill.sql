-- db/2026-09-10-tenant-referrer-backfill.sql
-- 业务诉求：租户订阅 tab「推荐人」列展示 created_by_username（设计 §D2 责任 sysadmin 归属）
-- 存量背景：`db/2026-09-04-tenant-created-by.sql` 加列后，2026-09-04 之前通过 seed/自助注册种的租户
--   因为 ON CONFLICT DO NOTHING + seedTenantDefaults 内 `.catch(() => {})` 静默兜底，这两列为 NULL。
--   表头「推荐人」读的是这两列 → 显「—」，与新建租户体感一致未带推荐人。
--
-- 修复（A 方案：语义合并为「推荐人=创建者」）：
--   1. 存量全 NULL → 'sysadmin'（平台兜底；同时标记「未明确推荐人」语义，与 selfRegister 未填默认一致）
--   2. created_by_user_id 保持 NULL（前端表头不读 UUID 列，仅显 username）
--   3. 幂等：WHERE created_by_username IS NULL → 二次跑 0 行
--
-- 铁律：禁物理 DELETE；本脚本只 UPDATE，不动租户/订阅/决策行。
UPDATE crm.tenants
   SET created_by_username = 'sysadmin'
 WHERE created_by_username IS NULL;
