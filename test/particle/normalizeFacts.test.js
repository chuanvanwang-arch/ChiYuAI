// test/particle/normalizeFacts.test.js — 6.6 SHACL-equivalent 写时校验
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.7：normalizeFacts(fact, metaAttr) 类型归一化 + required 缺失/类型不符抛
// ValidationError（不静默）；particleRepo 写前调用，拦截脏事实防误触发 G2 规则。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryWrite, query } from '../../src/db.js';
import { normalizeFacts, ValidationError } from '../../src/particles/normalizeFacts.js';
import { createParticle, updateParticle } from '../../src/particles/particleRepo.js';

// 用真实注册粒子类型 CRM_DEAL（PARTICLE_TYPES 内），确保 createParticle 类型闸先过
// 元模型 amount 已在 seedMetaAttr 中登记；identity 为 slug
const PT = 'CRM_DEAL';
const SLUG = 'norm-fact-deal-1';
const SLUGS = ['amount', 'due_date', 'owner', 'name'];

// 快照→恢复（2026-09-02 加固）：原实现 afterEach 无差别 DELETE 这 4 个 slug。
// 当前基线（crm_native_test）这 4 个 slug 无行，DELETE 恰好无害；但只要将来 seed/其它用例
// 登记了同名行，无差别 DELETE 就会「删掉不该删的」，把污染甩给后续文件（与 meta_attr
// 跨域毒化同型）。改为 beforeEach 整行快照 + afterEach 原样回写，使本文件对全局元模型
// 的净效果恒为 0，与执行顺序无关。
let snapshot = [];

async function takeSnapshot() {
  const r = await query(
    `SELECT to_jsonb(t) AS j FROM crm.meta_attr t
      WHERE particle_type=$1 AND attr_slug = ANY($2::text[])`,
    [PT, SLUGS]
  );
  snapshot = r.rows.map((x) => x.j);
}

async function restoreSnapshot() {
  for (const j of snapshot) {
    await queryWrite(
      `INSERT INTO crm.meta_attr SELECT * FROM jsonb_populate_record(NULL::crm.meta_attr, $1::jsonb)`,
      [JSON.stringify(j)]
    );
  }
  snapshot = [];
}

async function seedMetaAttr() {
  // 只登记本测试必要的行；amount/due_date/owner/name 全部「非必填 + 启用」——
  //   这是 CRM_DEAL 出厂语义（particleModel.js 无必填 coreAttributes 声明；identity 的 name 也为非必填）。
  //   显式复位 name：全量串行序下其他测试可能把 name 置 required=true 残留，beforeEach 必须把它拉回非必填，
  //   否则「类型归一化」用例的 fact 缺 name 会撞必填→报 required 缺失（#13 残留污染同型）。
  await queryWrite(
    `INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, required, enabled, semantic_tag)
     VALUES ($1,'amount','金额','number',false,true,'core'),
            ($1,'due_date','截止日期','date',false,true,'core'),
            ($1,'owner','负责人','text',false,true,'core'),
            ($1,'name','名称','text',false,true,'identity')
     ON CONFLICT (particle_type, attr_slug, tenant_id) DO UPDATE SET required=false, enabled=true, attr_type=EXCLUDED.attr_type`,
    [PT]
  );
}

beforeEach(async () => {
  await takeSnapshot();
  await seedMetaAttr();
});

afterEach(async () => {
  // 只清除本用例造的粒子与元模型行（不清 CRM_DEAL seed，避免污染既有测试）
  await queryWrite(`DELETE FROM crm.particles WHERE type=$1 AND slug=$2`, [PT, SLUG]);
  await queryWrite(
    `DELETE FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug = ANY($2::text[])`,
    [PT, SLUGS]
  );
  // 原样回写快照行（含 created_by/source/时间戳），保证对全局元模型的净效果为 0
  await restoreSnapshot();
});

describe('6.6 normalizeFacts 写时校验', () => {
  it('类型归一化：string number/date 归一为正确类型', async () => {
    const attrs = (await query(`SELECT * FROM crm.meta_attr WHERE particle_type=$1`, [PT])).rows;
    const fact = { amount: '120000.5', due_date: '2026-09-30', owner: 'Alin' };
    const n = normalizeFacts(fact, attrs);
    expect(n.amount).toBe(120000.5);
    expect(n.due_date).toBe('2026-09-30');
    expect(n.owner).toBe('Alin');
  });

  // 回归护栏（2026-09-02 真缺陷）：原实现把数组交给 toStringValue → String(['x.com','x.cn'])
  // 变成 "x.com,x.cn"，多值字段塌缩为单值。后果：CRM_ACCOUNT.domains 写入后不再是 JSON 数组，
  // ontology/hooks.js 身份解析的 jsonb_array_elements_text 元素级匹配落空 → auto_weak 边建不出来
  // （客户-联系人自动归一失效）。该缺陷曾被 meta-attr-schema 的 TRUNCATE 核弹掩盖为假绿。
  it('多值属性（数组）逐元素归一并保持数组（防 String(数组) 压缩回归）', () => {
    const attrs = [{ attr_slug: 'domains', attr_type: 'domain', required: false, enabled: true }];
    const n = normalizeFacts({ domains: ['x.com', 'x.cn'] }, attrs);
    expect(Array.isArray(n.domains)).toBe(true);
    expect(n.domains).toEqual(['x.com', 'x.cn']);   // 不得变成 "x.com,x.cn"
    // 数值型数组：逐元素归一为数字（而非整体转字符串）
    const n2 = normalizeFacts(
      { amounts: ['1200', '300'] },
      [{ attr_slug: 'amounts', attr_type: 'number', required: false, enabled: true }]
    );
    expect(n2.amounts).toEqual([1200, 300]);
  });

  it('required 缺失抛 ValidationError（不静默）', async () => {
    // 显式构造必填约束（不依赖库里残留的外部状态）：owner 必填且缺失 → 抛
    const attrs = [{ attr_slug: 'owner', attr_type: 'text', required: true, enabled: true }];
    expect(() => normalizeFacts({}, attrs)).toThrowError(ValidationError);
    expect(() => normalizeFacts({}, attrs)).toThrow(/required 属性缺失/);
  });

  it('required 类型不符抛 ValidationError（拦截脏事实）', async () => {
    // 显式构造金额必填 + 脏字符串 → 类型不符抛（不依赖库残留状态）
    const attrs = [{ attr_slug: 'amount', attr_type: 'number', required: true, enabled: true }];
    expect(() => normalizeFacts({ amount: 'abc' }, attrs)).toThrowError(ValidationError);
  });

  it('particleRepo 写前调用：脏事实粒子写入被拦截', async () => {
    // createParticle 契约校验在 identity 之外；normalizeFacts 已接线后脏值应被拒
    await expect(createParticle(PT, { slug: SLUG, name: 'Norm Deal', amount: 'abc' })).rejects.toThrow(/ValidationError|非法|amount/);
  });
});