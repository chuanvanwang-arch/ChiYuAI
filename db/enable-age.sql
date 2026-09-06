-- db/enable-age.sql
-- ============================================================================
-- 幂等启用 Apache AGE（Semantica 式决策网络图的查询面底座）
-- 执行者：DBA / superuser，在共享实例 plm@5433 上执行【一次】
-- 前置确认（已探测）：pg_available_extensions 含 age 1.6.0 available；
--                     当前库未装（installed_version=null，无 ag_catalog）。
-- 权限要求：CREATE EXTENSION age 需 superuser 或具扩展创建授权的角色；
--           agent2b 为普通用户，无此权限 —— 故由 DBA 预装。
-- ============================================================================

-- 1) 安装扩展（幂等）
CREATE EXTENSION IF NOT EXISTS age;

-- 2) 加载 AGE（仅当前会话；应用连接应在 db.js 连接后 SET search_path 或显式限定 ag_catalog）
LOAD 'age';

-- 3) 创建业务图（幂等：已存在则跳过，避免 create_graph 抛 "already exists"）
SELECT create_graph('crm_decision_network')
WHERE NOT EXISTS (
  SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'crm_decision_network'
);

-- 4) 校验（DBA 确认输出含 age 扩展 + crm_decision_network 图）
SELECT extname, extversion
FROM pg_extension
WHERE extname = 'age';

SELECT name
FROM ag_catalog.ag_graph
WHERE name = 'crm_decision_network';

-- ============================================================================
-- 应用侧约定（设计阶段落地，不在本脚本执行）：
--   - CRM 应用连接池建立后执行：SET search_path = ag_catalog, crm, public;
--     或所有 AGE 查询显式前缀 ag_catalog.（避免改 agent2b 全局 search_path 影响 PDM/P2P）。
--   - 事实源仍在 crm.particles / crm.edges / crm.decision 等表；
--     AGE 图（crm_decision_network）为「运行时查询面」，写时同步、只读镜像。
--   - 所有 Cypher 参数化，禁止字符串拼接（防注入）。
-- ============================================================================
