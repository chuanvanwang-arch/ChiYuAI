-- =============================================================================
-- migration-signal-contact-owner.sql — 派生信号责任人「父实体穿透」回填（2026-09-17）
--
-- 背景（用户实测：「没有完全按照销售员进行隔离，很多信息是相同的」）：
--   src/signal/activityDerivation.js 锚定 CRM_CONTACT（联系人自身无 owner_id），
--   原实现只看 entity.payload.owner_id ⇒ 该类信号 owner_id 恒为 NULL ⇒ 经
--   src/signal/store.js list() 的 ownerScope 谓词
--   （owner_id IS NULL AND target_role=$role）**广播给同租户全体销售**。
--   真库取证：12 条 contact_change 全无主，其中 **8 条**可经 payload.account_id
--   → 父账户 payload.owner_id 解析。
--
-- 处置（零 DELETE，纯回填）：
--   把「无主 + 锚实体无自身 owner + 父链接键(account_id)可解出责任人」的派生信号，
--   owner_id 回填为父实体的责任人；解析不出的一律保持 NULL（按角色广播是正确回退，
--   绝不猜测责任人）。
--
-- 为什么不停留在「等下一轮自然刷新」：dedup_key 为 `derived:{rule}:{entity}:{bucket}`，
--   同一桶内 store.create 会命中既有行并原样返回 ⇒ 旧行要等到桶翻滚（次日/次周）才被替换，
--   期间仍向全体销售广播。
--
-- 幂等：条件含 owner_id IS NULL，回填后再跑影响行数为 0。
-- =============================================================================

 UPDATE crm.signal s
    SET owner_id = acct.payload ->> 'owner_id'
   FROM crm.particles pc
   JOIN crm.particles acct
     ON acct.tenant_id = pc.tenant_id
    AND acct.id::text  = pc.payload ->> 'account_id'
  WHERE pc.id::text = s.particle_id::text
    AND pc.type = 'CRM_CONTACT'
    AND pc.payload ->> 'owner_id' IS NULL
    AND acct.payload ->> 'owner_id' IS NOT NULL
    AND s.owner_id IS NULL
    AND s.source = 'derived'
    AND s.kind = 'contact_change'
    AND s.status IN ('open', 'acked');
