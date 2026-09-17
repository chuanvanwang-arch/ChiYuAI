// test/signal/dateDrivenDemoSeed.test.js — 日期驱动演示脚本的**红线守卫**（2026-09-17）
//
// 为什么给「演示脚本」也写守卫：
//   本次演示要在真实库（crm_native）造数据并把提醒**真发出去**，因而脚本同时踩在三条红线上：
//     ① 禁删铁律 ② 租户隔离（演示数据不得污染他租户） ③ 不把个人信息写进平台模板行
//   而脚本是**可被后人复制改写**的样板：一次越界（例如把 role_recipients 写到 system 模板，
//   或加一句 TRUNCATE 便于重跑）就会造成静默泄漏/不可逆删除。守卫必须锁在测试里，不能只靠注释提醒。
//
// 守卫口径：**剥注释后**断言（本仓已登记两次的教训：否定断言被自己的说明注释命中 → 永久假红）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
const seed = codeOnly(fs.readFileSync('scripts/seed-date-driven-demo.mjs', 'utf8'));
const push = codeOnly(fs.readFileSync('scripts/demo-date-driven-push.mjs', 'utf8'));

describe('日期驱动演示脚本：红线守卫', () => {
  it('禁删铁律：两个脚本都不得出现 DELETE / TRUNCATE / DROP', () => {
    for (const [name, src] of [['seed', seed], ['push', push]]) {
      for (const kw of ['DELETE', 'TRUNCATE', 'DROP ']) {
        expect(src, `${name} 脚本含 ${kw} —— 违反禁删铁律`).not.toMatch(new RegExp(`\\b${kw.trim()}\\b`, 'i'));
      }
    }
  });

  it('租户隔离：seed 只向演示租户写配置，绝不写 (system, key) 模板行', () => {
    // 铁律依据：autoSeed 会把 (system,key) **深拷贝**给任何缺该键的租户
    //   ⇒ 往模板行写演示收件人 = 把演示数据泄漏给未来所有租户（记忆已登记的红线）。
    //
    // ⚠ 覆盖度守卫（2026-09-17 自证时实测到自己的漏洞）：窗口若写 `{0,200}?`，
    //   超过 200 字符的多行调用**整条逃过检查**（实测只捕获 1/2 条，第二条未被验证）。
    //   故此处：① 窗口放大到足够容下多行调用；② 断言「捕获数 === writeConfig 出现次数」，
    //   任何一条没被捕获 = 守卫覆盖不全 → 直接红，而不是静默放行。
    const total = (seed.match(/writeConfig\(/g) || []).length;
    const writes = [...seed.matchAll(/writeConfig\(([\s\S]{0,800}?)\)/g)].map((m) => m[1]);
    expect(total, '未检出任何 writeConfig 调用，守卫失去意义').toBeGreaterThan(0);
    expect(writes.length, `有 ${total - writes.length} 条 writeConfig 未被守卫捕获（窗口过窄）`).toBe(total);
    for (const w of writes) {
      expect(w, `writeConfig 未限定演示租户：${w.slice(0, 80)}`).toContain('DEMO_TENANT');
      expect(w, `writeConfig 出现了 system 模板租户：${w.slice(0, 80)}`).not.toMatch(/['"`]system['"`]/);
    }
  });

  it('收件人不写死在代码里（从 env 取账号本人地址）', () => {
    // 个人信息不得入库到代码/模板；脚本只允许经 SMTP_FROM/SMTP_USER 读取，且缺省时关闭出站渠道。
    expect(seed).toMatch(/process\.env\.SMTP_FROM/);
    expect(seed).toMatch(/process\.env\.SMTP_USER/);
    // 反例锚：不得出现字面量邮箱
    expect(seed, '脚本内出现字面量邮箱地址').not.toMatch(/['"`][\w.+-]+@[\w-]+\.[a-z]{2,}['"`]/i);
    // 缺 env 时必须收敛为「不出站渠道」，而不是继续外发
    expect(seed).toMatch(/SELF[\s\S]{0,200}?inbox:\s*'on',\s*email:\s*'off'/);
  });

  it('push 脚本与生产同装配（registry 与 timers.js 一致，差异只在范围）', () => {
    // 判据⑤：演示路径不得用「形状不同的替身」。registry 必须与生产同构（零注入）。
    expect(push).toMatch(/createDeliveryRegistry\(\{\}\)/);
    expect(push).toMatch(/createDispatcher\(/);
    expect(push).toMatch(/createDeliveryRouter\(\{\s*query\s*\}\)/);
    // 范围收敛：必须逐条 pumpSignal，不得调用 pumpAllTenants（那会把既有租户存量信号一起群发）
    expect(push).toMatch(/pumpSignal\(/);
    expect(push, 'push 脚本调用 pumpAllTenants 会群发他租户存量信号').not.toMatch(/pumpAllTenants\(/);
  });

  it('邮件失败必须如实落账（不得伪造 sent）：脚本只报告台账，不自行写 sent', () => {
    // 防假绿：演示脚本不得自己 INSERT crm.signal_delivery 造 "sent" 行来让结果好看。
    for (const [name, src] of [['seed', seed], ['push', push]]) {
      expect(src, `${name} 直接写 signal_delivery（绕过 provider）`).not.toMatch(/INSERT\s+INTO\s+crm\.signal_delivery/i);
    }
  });
});
