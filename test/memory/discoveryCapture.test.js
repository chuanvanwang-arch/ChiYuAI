// test/memory/discoveryCapture.test.js — Task 9：记忆捕获域 + 上下文 L2 注入红线（P0 #2）验收
// 全部为纯单测 + fs 读文件 + vi.mock 替身，零 PG 依赖（对齐 test/memory/ 现有纯函数用例范式）。
//
// ⚠️ id36 平台红线：src/context/routing.js 与 src/context/assembler.js 为 context-routing 冻结件。
//    本文件冻结其 sha256 哈希，任何改动都会使测试变红。
//    若合法需求确需修改这两个文件：须先经 brainstorming 批准，批准后**同步更新本测试的冻结哈希**，
//    严禁为「跑绿」而单方面改哈希或绕过断言。
import { describe, test, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ④ emit → 捕获闭环：把 appendMemory 换成替身，验证「白名单捕获 → 落记忆」这条线真接通
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: vi.fn(async () => ({ ok: true })),
}));

import { appendMemory } from '../../src/memory/memoryLog.js';
import {
  getCaptureDomains, isCapturable, setCaptureDomains, registerCaptureSubscriber,
} from '../../src/memory/capture.js';
import { emit, on } from '../../src/events/bus.js';
import { enforceContextByteLimit, KNOWLEDGE_CONTEXT_BYTE_LIMIT } from '../../src/agent/discoverySchema.js';
import { ROUTING_KEY } from '../../src/context/routing.js';

const SRC = (p) => path.resolve(process.cwd(), p);
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// 导入期快照出厂白名单（含 discovery）；此后各用例可安全覆盖，afterEach 复位到该基线。
//   setCaptureDomains 是「整表替换」语义，这里必须用完整清单而非合并，否则会把 discovery 复位掉。
const DEFAULT_DOMAINS = getCaptureDomains();

afterEach(() => {
  vi.clearAllMocks();
  // 复位白名单（setCaptureDomains 内部会 resubscribe，顺带退订本用例注册的订阅）
  setCaptureDomains(DEFAULT_DOMAINS);
});

describe('① 捕获域生效：discovery 进入白名单', () => {
  test('getCaptureDomains() 含 discovery 且 isCapturable(discovery) 为真', () => {
    expect(getCaptureDomains()).toContain('discovery');
    expect(isCapturable('discovery')).toBe(true);
  });
});

describe('② 白名单硬闸不可绕过', () => {
  test('BLOCKED_DOMAINS 域即便被 set 也恒不生效；discovery 仍生效', () => {
    setCaptureDomains(['discovery', 'trace']);
    expect(isCapturable('trace')).toBe(false);      // trace 是 BLOCKED，配置无法放开
    expect(isCapturable('discovery')).toBe(true);
  });
});

describe('③ id36 红线：context 路由/装配件零改动（内联冻结哈希）', () => {
  const ROUTING = 'src/context/routing.js';
  const ASSEMBLER = 'src/context/assembler.js';
  const FREEZE = {
    [ROUTING]: 'aa7a5ad7b5ca7d12fce8a1063a0e4d6107a640632ff62891415c428ec8671f67',
    [ASSEMBLER]: '12ac9bc27edc76a8ffa03c082ae94cd43d261c492e6001524de8c0fa73e5b54a',
  };

  test('routing.js 冻结哈希一致', () => {
    expect(sha256(SRC(ROUTING))).toBe(FREEZE[ROUTING]);
  });

  test('assembler.js 冻结哈希一致', () => {
    expect(sha256(SRC(ASSEMBLER))).toBe(FREEZE[ASSEMBLER]);
  });

  test('两文件源码均不含 discovery 字面量（捕获域变更不得渗入红线件）', () => {
    for (const p of [ROUTING, ASSEMBLER]) {
      const src = fs.readFileSync(SRC(p), 'utf8');
      expect(src.includes('discovery'), `${p} 不应含 discovery`).toBe(false);
    }
  });

  test('ROUTING_KEY 契约值不变', () => {
    expect(ROUTING_KEY).toBe('context-routing');
  });
});

describe('④ emit → 捕获闭环（vi.mock 替身，零 DB）', () => {
  test('白名单域 emit → appendMemory 被调用，且 payload 锚点/摘要齐备', async () => {
    registerCaptureSubscriber();
    emit('discovery', 'lead-discovered', { summary: '发现线索 XX制造 → DL-1', account_id: 'ACC-1' });
    await new Promise((r) => setImmediate(r));

    expect(appendMemory).toHaveBeenCalledTimes(1);
    const arg = appendMemory.mock.calls[0][0];
    expect(arg.topic).toBe('event:discovery:lead-discovered');
    expect(arg.payload.summary).toBeTruthy();
    expect(arg.payload.account_id).toBe('ACC-1');
  });

  test('未在白名单的域 emit → appendMemory 不被调用', async () => {
    registerCaptureSubscriber();
    emit('unlisted-domain', 'x', {});
    await new Promise((r) => setImmediate(r));
    expect(appendMemory).not.toHaveBeenCalled();
  });

  test('退订后不再捕获（订阅生命周期可回收）', async () => {
    const unsub = registerCaptureSubscriber();
    unsub();
    emit('discovery', 'lead-discovered', { summary: 's', account_id: 'A' });
    await new Promise((r) => setImmediate(r));
    expect(appendMemory).not.toHaveBeenCalled();
  });

  // 说明：on 从 bus.js 导入用于契约可见性（捕获正是基于逐域 on 订阅，绝非 on('*')）
  test('bus 契约：逐域订阅可正常收发', () => {
    const seen = [];
    const un = on('__probe__', (m) => seen.push(m.type));
    emit('__probe__', 'ping', {});
    un();
    expect(seen).toEqual(['ping']);
  });
});

describe('⑤ 上下文注入体积闸（64KB 纯函数）', () => {
  test('KNOWLEDGE_CONTEXT_BYTE_LIMIT === 65536', () => {
    expect(KNOWLEDGE_CONTEXT_BYTE_LIMIT).toBe(65536);
  });

  test('小 payload 原样返回且 truncated:false', () => {
    const out = enforceContextByteLimit({ summary: 's', account_id: 'A' });
    expect(out.truncated).toBe(false);
    expect(out.summary).toBe('s');
    expect(out.account_id).toBe('A');
  });

  test('大 payload：裁剪到 ≤64KB、标 truncated、降级层含 L2、summary 非空', () => {
    const big = {
      summary: 'x'.repeat(200000),
      account_id: 'A',
      evidence: Array.from({ length: 200 }, (_, i) => ({ type: `f${i}`, detail: 'y'.repeat(500) })),
    };
    const out = enforceContextByteLimit(big);
    expect(out.truncated).toBe(true);
    expect(Array.isArray(out.degradedLayers)).toBe(true);
    expect(out.degradedLayers.includes('L2')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(KNOWLEDGE_CONTEXT_BYTE_LIMIT);
    expect(typeof out.summary).toBe('string');
    expect(out.summary.length).toBeGreaterThan(0);
    // 锚点字段不得被裁掉（C2 依赖）
    expect(out.account_id).toBe('A');
  });

  test('自定义 limitBytes 同样生效（契约可参数化）', () => {
    const out = enforceContextByteLimit(
      { summary: 'z'.repeat(5000), account_id: 'A', note: 'q'.repeat(5000) },
      { limitBytes: 1024 }
    );
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(1024);
    expect(out.summary.length).toBeGreaterThan(0);
  });
});
