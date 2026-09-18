// vitest.config.js — 测试隔离配置
// 测试连独立测试库 crm_native_test（agent2b@5433），与业务库 crm_native/crm 完全隔离：
//  - 测试文件 beforeEach TRUNCATE particles/edges/events 只清 crm_native_test，业务库不再被波及
//  - 业务脚本/服务默认连 src/db.js 的 crm_native 库，天然互不干扰
//  - fileParallelism:false + singleFork：单进程内顺序执行，防止同库多文件并发 TRUNCATE 踩踏
// 2026-09-16：新增 exclude —— `.release-wt/`（发布用快照目录）会整树复制 test/，
//   未被排除时 vitest 会把整套用例跑两遍（实测 workbench-routes 报 22 + 22 例），
//   既翻倍耗时，又会让"快照里的旧代码"失败被误判为本仓回归。
// 2026-09-16（晚）：新增 setupFiles 凭据隔离 —— Vite/Vitest 会把项目根 `.env`（本机运行态真实凭据）
//   载入 process.env，破坏"无凭据/未配置"为前提的用例（假红），且是安全缺陷（测试会拿真凭据打真实 API）。
//   ⚠ 隔离在 setupFiles 里做「**置空**」而非「删除」：dotenv 只跳过"已存在"的键，删除会被重新填充。
//   全量对照实测（701 文件）：修好 1 个假红、**0 个真实新增红**（详见 test/setup/isolate-env-credentials.mjs 注释）。
import { defineConfig, configDefaults } from 'vitest/config';

// 强制测试进程连 crm_native_test（对 fork/子进程同样生效，覆盖 src/db.js 的 PGDATABASE 默认值）
process.env.PGDATABASE = process.env.CRM_TEST_DB || 'crm_native_test';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    // 凭据隔离：在 Vite/dotenv 载入 .env 之后、测试文件执行之前，把凭据类键置空。
    // 回归护栏：test/setup/env-isolation.guard.test.js（钉住"置空而非删除"）。
    setupFiles: ['./test/setup/isolate-env-credentials.mjs'],
    // 2026-08-31：Windows 下 forks 单进程 worker 对 executor 重导入链会静默崩溃（exit1 无输出）；
    // 改用 threads 池（vitest 现代默认），单文件串行（fileParallelism:false）仍防并发 TRUNCATE 踩踏。
    pool: 'threads',
    // 发布快照/构建产物不参与测试（configDefaults.exclude 覆盖 node_modules、dist 等默认项）
    // 2026-09-17：新增 `.workbuddy/**` —— 与 `.release-wt/` 同族问题的第二次出现：
    //   品牌/版本更名时为留取证快照，把 `test/` 与 `src/` 整树备份进 `.workbuddy/backups/<批次>/`；
    //   该目录未被排除时，vitest 会扫到备份里的 `*.test.js` 并**按备份内相对路径**解析其依赖
    //   （实测 `signalActions.test.js` → `./registry.js` 缺失 ⇒ 1 文件加载失败），
    //   即「备份动作本身把测试搞红」。`.workbuddy/` 是项目数据/备份目录，永不应参与测试发现。
    exclude: [...configDefaults.exclude, '.release-wt/**', '.rel-oauth*/**', '.workbuddy/**'],
  },
});
