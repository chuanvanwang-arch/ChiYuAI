// test/setup/env-isolation.guard.test.js — 凭据隔离的回归护栏（E5 同轮，2026-09-16）
//
// 本文件守护的是「隔离**方式**」，不是「隔离效果」。两件事必须分清：
//   效果（anysiteRest 从红转绿）已由全量对照证明；本文件守的是**方式不被悄悄改坏**。
//
// 为什么需要它：把 `process.env[k] = ''` 改成 `delete process.env[k]` 看起来更"干净"，
//   但 dotenv 只跳过"已存在"的键 ⇒ 删除后 `.env` 会重新填上 ⇒ **隔离静默失效，测试照旧红**。
//   这类退化**不会让任何用例报错**，只会让一批假红"神秘回归"，极难归因。
//
// ⚠ 自守护特性：本文件的断言依赖 setup 文件**确实执行过**。
//   若有人从 `vitest.config.js` 的 `setupFiles` 里删掉隔离模块，下面的断言会因为读到 `.env` 真值而立刻变红
//   —— 即"移掉护栏会让护栏自己报警"，无需再用 grep 做静态守卫。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ISOLATED_ENV_KEYS } from './isolate-env-credentials.mjs';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

describe('测试进程凭据隔离（置空而非删除）', () => {
  it('清单非空且覆盖 .env 的凭据类键（防"清单被掏空"式退化）', () => {
    expect(ISOLATED_ENV_KEYS.length).toBeGreaterThanOrEqual(8);
    for (const k of ISOLATED_ENV_KEYS) expect(typeof k).toBe('string');
  });

  it('每个键都是「已存在且为空串」——不得是 unset（否则 dotenv 会重新填充）', () => {
    for (const k of ISOLATED_ENV_KEYS) {
      // ⚠ 这一条就是"置空 vs 删除"的判据：`in` 为 false 即说明被 delete 过 ⇒ 隔离已失效
      expect(k in process.env, `process.env 中缺少 '${k}' ⇒ 疑似被 delete（隔离失效）`).toBe(true);
      expect(process.env[k], `'${k}' 非空 ⇒ 隔离未生效或 .env 值泄漏`).toBe('');
    }
  });

  it('正例对照：.env 里确实存在这些键的真实值（否则本护栏是"空转通过"）', () => {
    let raw = null;
    try {
      raw = readFileSync(ENV_PATH, 'utf8');
    } catch {
      raw = null; // 无 .env（CI/新机器）→ 本次隔离确实无事可做，属合法情形
    }
    if (raw === null) {
      // 不能静默跳过整条断言：显式记录"本机无 .env，正例对照不适用"
      expect(raw).toBeNull();
      return;
    }
    const inDotenv = raw
      .split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/))
      .filter(Boolean)
      .filter((m) => m[2].trim() !== '')
      .map((m) => m[1]);
    const overlap = inDotenv.filter((k) => ISOLATED_ENV_KEYS.includes(k));
    // 若 .env 非空、却与清单无交集 ⇒ 清单已过期（新增了凭据键但没同步进清单）→ 必须变红提醒
    expect(
      overlap.length,
      `.env 中的非空键 [${inDotenv.join(', ')}] 与隔离清单无交集 —— 清单可能已过期`,
    ).toBeGreaterThan(0);
  });
});
