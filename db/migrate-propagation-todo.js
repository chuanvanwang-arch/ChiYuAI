// db/migrate-propagation-todo.js — ADMIN 待办闭环（Task 12 / 设计 §16.1/16.4）
// 落点：
//   · calibration_patch 增 assignee（§16.4 默认 ADMIN）/ tenant_id（设计修正 #10：tan_admin 本租户过滤与租户级写入需该列）；
//   · knob CHECK 扩 'config_store'——必须在既有 13 类上**追加**，禁收窄（计划修正 #8）；
//   · 索引 (status, assignee, tenant_id, created_at DESC) 服务 todos feed 列表查询。
// 运行：PGDATABASE=crm_native_test node db/migrate-propagation-todo.js
// 约定同 migrate-propagation-rectification.js：queryWrite 来自 ../src/db.js；ADD COLUMN IF NOT EXISTS 幂等；约束名 calibration_patch_knob_check（schema.sql 同名）。
import { pathToFileURL } from 'node:url';
import { queryWrite } from '../src/db.js';

export async function migratePropagationTodo() {
  // ① 待办定向：admin 全部 / 租户级 tan_admin（§16.4）
  await queryWrite(
    `ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT 'ADMIN'`
  );
  // ② 租户上下文：tan_admin 限本租户可见性 + 策略 apply 写入目标租户 config（缺陷 #10）
  await queryWrite(
    `ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`
  );
  // ③ knob 枚举扩 'config_store'（在 13 类基础上追加；计划原文 4 类清单会破坏既有旋钮，缺陷 #8）
  //    2026-09-05 P1：再追加 routing_tracks/routing_weight/routing_threshold（场景路由反推三旋钮）→ 17 类。
  //    ⚠ 必须与 db/schema.sql 的 calibration_patch_knob_check 保持一致，否则本迁移会把 schema 的宽枚举收窄。
  await queryWrite(`ALTER TABLE crm.calibration_patch DROP CONSTRAINT IF EXISTS calibration_patch_knob_check`);
  await queryWrite(
    `ALTER TABLE crm.calibration_patch
      ADD CONSTRAINT calibration_patch_knob_check
      CHECK (knob IN ('threshold','weight','required_dims',
                      'confidence','edge_binding','outcome_threshold','strictness',
                      'meta_attr_map','particle_attr_add','k_edge_add',
                      'source_refresh','dim_order','precedent_distill',
                      'config_store',
                      'routing_tracks','routing_weight','routing_threshold'))`
  );
  // ④ todos 列表查询索引
  await queryWrite(
    `CREATE INDEX IF NOT EXISTS idx_calibration_patch_todo
      ON crm.calibration_patch(status, assignee, tenant_id, created_at DESC)`
  );
  console.log('[migrate-propagation-todo] done');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migratePropagationTodo().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}