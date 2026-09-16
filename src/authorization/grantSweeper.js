// src/authorization/grantSweeper.js — 常驻授权凭证定期巡检（过期 + 连续否决暂停）
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §11.4（到期/信任降级）
// 铁律：全为状态字段变更，零 DELETE；阈值走 config_store（policyLoader）。
import { query, queryWrite } from '../db.js';
import { pauseGrant } from './grantStore.js';
import { loadGrantsPolicy } from './standingAuthorization.js';

export function createGrantSweeper({ q = query, qw = queryWrite, getPolicy = () => loadGrantsPolicy('system') } = {}) {
  // 单次巡检：
  //   ① 过期：status=active 且 expires_at 已过 → expired
  //   ② 连续否决信任降级：active 凭证最近 N 条执行全 rejected → paused + trace（由 pauseGrant 留痕）
  async function sweepOnce() {
    const expiredRes = await qw(
      `UPDATE crm.standing_grant SET status='expired'
       WHERE status='active' AND expires_at IS NOT NULL AND expires_at < now()`
    );
    const expired = expiredRes.rowCount || 0;

    const policy = await getPolicy();
    const N = Number(policy?.auto_pause_on_consecutive_rejects) || 3;
    let paused = 0;
    if (N > 0) {
      const active = await q(
        `SELECT tenant_id, grant_id FROM crm.standing_grant WHERE status='active'`
      );
      for (const { tenant_id, grant_id } of active.rows) {
        const v = await q(
          `SELECT hitl_verdict FROM crm.grant_execution
           WHERE tenant_id=$1 AND grant_id=$2 ORDER BY created_at DESC LIMIT $3`,
          [tenant_id, grant_id, N]
        );
        const verdicts = v.rows.map((x) => x.hitl_verdict);
        if (verdicts.length >= N && verdicts.every((x) => x === 'rejected')) {
          await pauseGrant(tenant_id, grant_id, 'consecutive-rejects');
          paused++;
        }
      }
    }
    return { expired, paused };
  }
  return { sweepOnce };
}
