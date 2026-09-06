-- db/migrate-named-owner-backfill.sql — 为「指名客户看板不可见」的存量账户回填归属（白名单 + 幂等）
--
-- 背景（2026-08-31 实测）：AI 销售助手把客户改名为「青煜智能」并汇报"已完成"，
--   但 /named-accounts.html（客户跟踪）看板的客户清单里找不到。
--   根因：CRM_ACCOUNT 缺 named_owner，而 src/sales/namedAccountBoard.js:91-94 的过滤链
--     accounts.filter(a => Boolean(namedOwnerOf(a.payload || {})))   -- 无主户剔除
--   把无主账户永久剔除，改名再多次也不会出现在任何销售名下的清单中。
--
-- 代码侧根治已入库（commit a38f7f2 / 2e4bb30）：
--   - particleRepo.backfillAccountOwner()：CRM_ACCOUNT 缺 named_owner 时按 ctx.actor 自动回退
--   - routes.js POST /api/particles：CRM_ACCOUNT + 非 bootstrap 通道 → ctx.enforceNamedOwner=true
--   - namedAccountBoard.listUnassignedAccounts()：admin/manager 视角 ?includeUnassigned=1 暴露无主户
-- 本脚本只修存量数据（该账户建于代码根治之前，不受新代码保护），是环境侧一次性补偿。
--
-- 幂等性（可重复执行，无副作用）：
--   WHERE 带 `COALESCE(payload->>'named_owner','') = ''` 守卫——已回填的账户重复执行不改任何值。
--   白名单外的账户（含 seed 测试 fixture 的 无主户/达标户/逾期户）完全不受影响，
--   测试库 plm_test 若不存在这些 id 则本脚本为空操作。
--
-- 回滚：merge_history 保留了回填前快照；需要撤销时执行
--   UPDATE crm.particles SET payload = payload
--     - 'named_owner' - 'owner_id' - 'owner' - 'named_state' - 'named_tier' - 'tier' - 'merge_history',
--     state = 'potential'
--   WHERE id = '<target id>' AND type = 'CRM_ACCOUNT';
--
-- 执行：
--   psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -f db/migrate-named-owner-backfill.sql
--   （凭据与端口按环境替换；生产库为 plm@5433，测试库为 plm_test）

SET search_path TO crm, public;

-- 白名单：仅回填列表内「仍无主」的账户。新增待修复账户时追加一行即可。
--   列：账户 id / 目标指名销售 username / 指名档位
CREATE TEMP TABLE _backfill_targets (id uuid, owner text, tier text);

INSERT INTO _backfill_targets (id, owner, tier) VALUES
  ('2bbd2dc1-495a-4d7d-9b0a-f874efa9f1b3', 'admin', '目标');  -- 青煜智能：AI 改名后看板不可见

UPDATE crm.particles p
SET payload = jsonb_strip_nulls(p.payload)
      || jsonb_build_object(
           'named_owner', t.owner,
           'owner_id',    t.owner,   -- 兼容旧字段约定（account-360 等按 owner_id 归属）
           'owner',       t.owner,   -- 兼容历史数据（namedOwnerOf 回退链第三顺位）
           'named_state', 'active',  -- 指名状态：过滤链硬读此键（namedAccountBoard.js:94）
           'named_tier',  t.tier,
           'tier',        t.tier,
           -- 软合并审计链（禁删铁律，零 DELETE）：记录回填前状态，可回滚
           'merge_history', COALESCE(p.payload -> 'merge_history', '[]'::jsonb)
             || jsonb_build_array(jsonb_build_object(
                  'op', 'backfill_named_owner',
                  'at', now(),
                  'by', t.owner,
                  'before_name', p.payload ->> 'name',
                  'reason', 'AI 写账户缺 named_owner → 指名看板不可见（2026-08-31 根因修复）'
                ))
         ),
    -- 粒子生命周期同步（CRM_ACCOUNT flow: potential → active；与 named_state 同源，避免视图口径分裂）
    state = 'active',
    updated_at = now()
FROM _backfill_targets t
WHERE p.id = t.id
  AND p.type = 'CRM_ACCOUNT'
  AND COALESCE(p.payload ->> 'named_owner', '') = '';

-- 回填结果核对（期望 1 行；0 行 = 已回填过或白名单 id 在本库不存在，均属预期）
SELECT p.id,
       p.payload ->> 'name'        AS name,
       p.payload ->> 'named_owner' AS named_owner,
       p.payload ->> 'named_state' AS named_state,
       p.payload ->> 'named_tier'  AS tier,
       p.state                     AS particle_state
FROM crm.particles p
JOIN _backfill_targets t ON t.id = p.id
WHERE p.type = 'CRM_ACCOUNT';
