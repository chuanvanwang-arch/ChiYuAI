// vitest.config.js — 测试隔离配置
// 测试连独立测试库 crm_native_test（agent2b@5433），与业务库 crm_native/crm 完全隔离：
//  - 测试文件 beforeEach TRUNCATE particles/edges/events 只清 crm_native_test，业务库不再被波及
//  - 业务脚本/服务默认连 src/db.js 的 crm_native 库，天然互不干扰
//  - fileParallelism:false + singleFork：单进程内顺序执行，防止同库多文件并发 TRUNCATE 踩踏
// 2026-09-16：新增 exclude —— `.release-wt/`（发布用快照目录）会整树复制 test/，
//   未被排除时 vitest 会把整套用例跑两遍（实测 workbench-routes 报 22 + 22 例），
//   既翻倍耗时，又会让"快照里的旧代码"失败被误判为本仓回归。
import { defineConfig, configDefaults } from 'vitest/config';

// 强制测试进程连 crm_native_test（对 fork/子进程同样生效，覆盖 src/db.js 的 PGDATABASE 默认值）
process.env.PGDATABASE = process.env.CRM_TEST_DB || 'crm_native_test';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // 2026-08-31：Windows 下 forks 单进程 worker 对 executor 重导入链会静默崩溃（exit1 无输出）；
    // 改用 threads 池（vitest 现代默认），单文件串行（fileParallelism:false）仍防并发 TRUNCATE 踩踏。
    pool: 'threads',
    // 发布快照/构建产物不参与测试（configDefaults.exclude 覆盖 node_modules、dist 等默认项）
    exclude: [...configDefaults.exclude, '.release-wt/**', '.rel-oauth*/**'],
  },
});
