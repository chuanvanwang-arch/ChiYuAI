// vitest.config.js — 测试隔离配置
// 测试连独立测试库 crm_native_test（agent2b@5433），与业务库 crm_native/crm 完全隔离：
//  - 测试文件 beforeEach TRUNCATE particles/edges/events 只清 crm_native_test，业务库不再被波及
//  - 业务脚本/服务默认连 src/db.js 的 crm_native 库，天然互不干扰
//  - fileParallelism:false + singleFork：单进程内顺序执行，防止同库多文件并发 TRUNCATE 踩踏
import { defineConfig } from 'vitest/config';

// 强制测试进程连 crm_native_test（对 fork/子进程同样生效，覆盖 src/db.js 的 PGDATABASE 默认值）
process.env.PGDATABASE = process.env.CRM_TEST_DB || 'crm_native_test';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // 2026-08-31：Windows 下 forks 单进程 worker 对 executor 重导入链会静默崩溃（exit1 无输出）；
    // 改用 threads 池（vitest 现代默认），单文件串行（fileParallelism:false）仍防并发 TRUNCATE 踩踏。
    pool: 'threads',
  },
});
