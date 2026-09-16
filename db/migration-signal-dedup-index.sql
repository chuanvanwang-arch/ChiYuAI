-- 2026-09-16 主动运行时 S1 修复：crm.signal 去重索引谓词 与 运行时去重谓词 对齐
--
-- 缺陷（真库实测复现，2026-09-16）：
--   idx_signal_dedup 原为 UNIQUE(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL —— **全状态唯一**；
--   而 store.findOpenByDedup 只查 `status IN ('open','acked')` —— **仅未关闭**。
--   两者谓词不一致 ⇒ 一条信号被 closed/acted 之后，它的 dedup_key 仍被索引占位：
--     ① 同类告警再次产生时 findOpenByDedup 漏过（因已关闭）→ 走 INSERT → 撞唯一索引 **抛异常**；
--     ② 经 persister（fire-and-forget）时该异常被 catch → 只留 trace → **信号静默丢失**。
--   实测：{"constraint":"idx_signal_dedup","routine":"_bt_check_unique"}（crm_native，smoke 租户已 closed 行）。
--
-- 修法：把索引收窄为与查询谓词**逐字一致**的部分唯一索引（仅未关闭态唯一）——
--   未关闭期间仍严格去重；已关闭后允许同类信号重新产生（这才是「告警闭环后能再提醒」的语义）。
--   DROP + CREATE 是必须的：`CREATE UNIQUE INDEX IF NOT EXISTS` 不会修改已存在同名索引的定义。
--
-- 铁律呼应：谓词定义在 SQL 与 JS 两处 ⇒ 必须一致（同 test/tier-predicate-parity.test.js 教训）。
--   本文件末尾自带断言，若索引未按预期生效则迁移直接失败（不静默放过）。

DROP INDEX IF EXISTS crm.idx_signal_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_dedup
  ON crm.signal(tenant_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND status IN ('open','acked');

DO $$
DECLARE d TEXT;
BEGIN
  SELECT indexdef INTO d FROM pg_indexes WHERE schemaname='crm' AND indexname='idx_signal_dedup';
  IF d IS NULL OR d NOT LIKE '%open%' OR d NOT LIKE '%acked%' THEN
    RAISE EXCEPTION '[migration-signal-dedup-index] 索引谓词未按预期生效: %', COALESCE(d, '<index missing>');
  END IF;
  RAISE NOTICE '[migration-signal-dedup-index] OK: %', d;
END $$;
