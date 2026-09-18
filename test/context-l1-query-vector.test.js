// test/context-l1-query-vector.test.js — L1 查询侧向量必须与存储列同源同维（2026-09-18 P0 回归锁）
//
// 实证缺陷：src/context/assembler.js 的 L1 召回固定用 hashVector(q)（DIM=384）对
//   crm.particles.embedding vector(1024) 执行 `embedding <=> $1::vector`
//   ⇒ PG 抛 `different vector dimensions 1024 and 384`（本机与生产容器内均已复现）；
//   异常被 assembleContext 的 `catch { missing.L1 = true }` 吞掉 ⇒ L1 实体召回 100% 静默失效。
//
// 为什么既有测试全绿却漏掉：测试环境 NODE_ENV=test ⇒ 不启用真向量 ⇒ embedding 全为 NULL
//   ⇒ `WHERE embedding IS NOT NULL` 选出空集，PG 从未真正比较过一对向量，维度错不触发。
//   ⇒「环境差异把缺陷藏起来」：本文件改为**断言渲染产物**（L1 是否真的含该实体），
//     而非「查询是否发出/是否 200」。
//
// 本文件锁三件事：
//   ① 维度常量语义：hash 产物维度 ≠ 存储列维度（两者不得互相参与 <=>）
//   ② 行为：名称精确归位**不依赖**向量存在（无真向量也必须召回；这是 ATTIO T10 契约的兜底）
//   ③ 结构：assembler.js 不得再以 hashVector 构造 L1 查询向量（否定断言先剥离注释）
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { assembleContext } from '../src/context/assembler.js';
import { DIM, STORED_EMBED_DIM } from '../src/ontology/embedding.js';

beforeEach(async () => {
  // 与 attio-inheritance 同款隔离：decision 域残留会污染装配（先例/时间线），一并清
  await query(`TRUNCATE particles, edges, events, decision, decision_event CASCADE`);
});

describe('L1 查询侧维度一致性（P0 回归锁）', () => {
  it('维度常量：hash 产物 384 ≠ 存储列 1024（不同空间，不得互为排序依据）', () => {
    expect(STORED_EMBED_DIM).toBe(1024);
    expect(DIM).toBe(384);
    expect(DIM).not.toBe(STORED_EMBED_DIM);
  });

  it('名称精确归位不依赖向量存在：测试环境（无真向量）也须召回到刚建实体', async () => {
    const acct = await createParticle('CRM_ACCOUNT', {
      name: '维度回归客户',
      employee_range: '51-200',
    });
    const ctx = await assembleContext({
      actor: 'presales',
      intent: { scenario: 'OPP_QUALIFY' },
      query: '维度回归客户',
    });
    const l1 = ctx.layers.L1 || [];
    // ① 不得再被吞成 missing（旧缺陷的表现：查询抛维度错 → catch → missing.L1）
    expect(ctx.missing?.L1).not.toBe(true);
    // ② 渲染产物断言：L1 必须真的含这条实体（而非"查询发出过"）
    expect(l1.some((p) => p.entity_id === acct.id)).toBe(true);
  });

  it('assembler 不得以 hashVector 构造 L1 查询向量（剥离注释后判定，防注释文本充当证据）', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/context/assembler.js', import.meta.url)),
      'utf8'
    );
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/hashVector/);
    expect(code).toMatch(/l1QueryVector/);
    expect(code).toMatch(/STORED_EMBED_DIM/);
  });
});
