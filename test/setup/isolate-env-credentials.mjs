// test/setup/isolate-env-credentials.mjs — 测试进程凭据隔离（Vite/dotenv 之后执行）
//
// 为什么需要它（2026-09-16 全量对照实测）：
//   Vite/Vitest 会把项目根 `.env`（**本机运行态文件**，含真实凭据）载入 `process.env`。
//   于是所有以「无凭据 → fail-open / 未配置 → fail-closed」为**前提**的用例，前提被破坏 → 成片假红。
//   更严重的是它同时是**安全缺陷**：测试进程能读到真实凭据 ⇒ 任何未 mock 外部调用的用例会**用真凭据打真实 API**。
//
// ⚠⚠ 隔离必须「置空」，不可「删除」——这是本文件存在的核心原因，勿改成 delete：
//   dotenv / Vite 的语义是「**不覆盖已存在的键，但补齐缺失的键**」。
//   - `delete process.env[k]`  ❌ 实测无效：删除后 `.env` 立刻把它**重新填上**，测试照旧红；
//   - `process.env[k] = ''`    ✅ 实测有效：键"已存在" ⇒ dotenv 跳过 ⇒ 隔离生效。
//   同一条语义的另一面：命令行对照实验也必须用 `KEY=""` 而非 `env -u KEY`（否则得到"假对照"）。
//
// ⚠ 已试过且**无效**的替代杠杆：把 Vite 的 `envDir` 指向空目录 —— 实测根 `.env` 仍被载入 `process.env`。
//   不要再尝试该方案（2026-09-16 实测记录）。
//
// ⚠ 覆盖范围说明：本文件只做「**置空**」，不做「unset」。因此被测代码若用
//   `'KEY' in process.env` 判"是否配置过"，看到的是 true（空串），与"完全未定义"仍有细微差别。
//   实测（全量 701 文件对照）该差别不产生新的真实失败，故接受；若将来出现依赖该差别的新用例，
//   应改为显式 fixture 注入，而不是回退本隔离。
//
// 回归护栏见 `test/setup/env-isolation.guard.test.js`（钉住"置空而非删除"）。

// 与项目根 `.env` 保持同步：新增凭据类键时**必须**同步加入本清单。
// 判据：凡"本机运行态才有、CI/新机器上不存在"的凭据/密钥类键，都应加入。
export const ISOLATED_ENV_KEYS = [
  'ANY_SITE_KEY',
  'PGCRYPTO_SYM_KEY',
  'SMTP_FROM',
  'SMTP_HOST',
  'SMTP_PASS',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
];

for (const k of ISOLATED_ENV_KEYS) process.env[k] = '';
