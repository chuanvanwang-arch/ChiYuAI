// test/methodology-sync.test.js — 方法论 SKILL → DB 镜像 写时同步（§6.6 单一事实源纪律）
// 验证（审计修复 P1#3 的收口）：
//  1. dryRun 不落库（只出 ops 清单）；
//  2. 幂等：真实同步两遍，第二遍零新增（既有 template/dimension 不动）；
//  3. 归一映射：MEDDICC SKILL(M1/E1/I1) → DB(M/E/I) 不产生重复维；OPPORTUNITY_MATRIX → OPP_MATRIX 归一；
//  4. 无映射方法论（PRESALES_SOLUTION / BANT）：维度原样保留，新建模板不全空（此即 normalizeDims 修复点）；
//  5. listMethodologySkew 输出漂移清单。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../src/db.js';
import {
  normalizeDims, readMethodologyJson, syncMethodologyFromSkill,
  syncAllMethodologies, listMethodologySkew,
} from '../src/skills/methodologySync.js';

describe('normalizeDims（SKILL 键 → DB 键 归一）', () => {
  it('MEDDICC：M1/E1/I1 漂移键归一为 M/E/I，D1/D2/C1/C2 同名原样保留', () => {
    const dimsIn = [
      { dim_key: 'M1', label: 'Metrics', weight: 1.0, required: true },
      { dim_key: 'E1', label: 'Economic Buyer', weight: 1.0, required: true },
      { dim_key: 'D1', label: 'Decision Criteria', weight: 0.8, required: true },
      { dim_key: 'D2', label: 'Decision Process', weight: 0.8, required: true },
      { dim_key: 'I1', label: 'Pain', weight: 1.0, required: true },
      { dim_key: 'C1', label: 'Champion', weight: 1.0, required: true },
      { dim_key: 'C2', label: 'Competition', weight: 0.6, required: true },
    ];
    const out = normalizeDims({ methodology_id: 'MEDDICC' }, dimsIn);
    expect(out.map((d) => d.dim_key)).toEqual(['M', 'E', 'D1', 'D2', 'I', 'C1', 'C2']);
  });

  it('OPPORTUNITY_MATRIX：V1/F1 归一为 value/win_prob（F1→win_prob 语义修正），P1 竞争定位映射为 competitive_position（SKILL 真实独立维，不丢弃）', () => {
    const dimsIn = [
      { dim_key: 'V1', label: '商业价值', weight: 1.0, required: true },
      { dim_key: 'F1', label: '可行性', weight: 1.0, required: true },
      { dim_key: 'P1', label: '竞争定位', weight: 0.6, required: false },
    ];
    const out = normalizeDims({ methodology_id: 'OPPORTUNITY_MATRIX' }, dimsIn);
    expect(out.map((d) => d.dim_key)).toEqual(['value', 'win_prob', 'competitive_position']);
  });

  it('ROLE_MAP：D/I/U/S 四角色归一为 DB 键（economic_buyer/champion/blocker/sponsor）', () => {
    const dimsIn = [
      { dim_key: 'D', weight: 1.0 }, { dim_key: 'I', weight: 0.8 },
      { dim_key: 'U', weight: 0.7 }, { dim_key: 'S', weight: 0.5 },
    ];
    const out = normalizeDims({ methodology_id: 'ROLE_MAP' }, dimsIn);
    expect(out.map((d) => d.dim_key)).toEqual(['economic_buyer', 'champion', 'blocker', 'sponsor']);
  });

  // STOP_LOSS 镜像债修复（2026-09-03）：CB 归一键须为 cost_budget，绝不臆造为 probability
  // （旧版 probability 与 SKILL 事实源 methodology.json STOP_LOSS.CB 标签「投入预算上限 Cost Budget」自相矛盾，
  //  且使 listMethodologySkew 因两侧同口径归一报 dim_skew=false 形成审计假绿）。
  it('STOP_LOSS：NV/CB/EG 归一为 burn/cost_budget/exit_guard（CB 不再臆造为 probability）', () => {
    const dimsIn = [
      { dim_key: 'NV', label: '净投入净值 Net Value', weight: 1.0, required: true },
      { dim_key: 'CB', label: '投入预算上限 Cost Budget', weight: 1.0, required: true },
      { dim_key: 'EG', label: '退出门 Exit Gate', weight: 1.0, required: true },
    ];
    const out = normalizeDims({ methodology_id: 'STOP_LOSS' }, dimsIn);
    expect(out.map((d) => d.dim_key)).toEqual(['burn', 'cost_budget', 'exit_guard']);
    expect(out.some((d) => d.dim_key === 'probability')).toBe(false);
  });

  it('无映射方法论（PRESALES_SOLUTION / BANT 等未登记归一表）→ 维度原样保留，全部落库（修复点）', () => {
    const dimsIn = [
      { dim_key: 'S1', weight: 1.0 }, { dim_key: 'S2', weight: 1.0 },
      { dim_key: 'S3', weight: 0.8 }, { dim_key: 'S4', weight: 0.8 },
    ];
    expect(normalizeDims({ methodology_id: 'PRESALES_SOLUTION' }, dimsIn)).toHaveLength(4);
    expect(normalizeDims({ methodology_id: 'PRESALES_SOLUTION' }, dimsIn).map((d) => d.dim_key))
      .toEqual(['S1', 'S2', 'S3', 'S4']);
    // BANT 键与 DB 同名（B/A/N/T），无映射也应原样保留
    expect(normalizeDims({ methodology_id: 'BANT' }, [
      { dim_key: 'B' }, { dim_key: 'A' }, { dim_key: 'N' }, { dim_key: 'T' },
    ]).map((d) => d.dim_key)).toEqual(['B', 'A', 'N', 'T']);
  });
});

describe('syncMethodologyFromSkill / syncAllMethodologies（写时同步）', () => {
  it('dryRun：不落库，只返回 ops 清单', async () => {
    const before = (await query('SELECT count(*)::int n FROM crm.methodology_template')).rows[0].n;
    const r = await syncAllMethodologies({ dryRun: true });
    expect(r.length).toBeGreaterThanOrEqual(8); // 8 个 method-* SKILL 全部枚举
    const after = (await query('SELECT count(*)::int n FROM crm.methodology_template')).rows[0].n;
    expect(after).toBe(before); // dryRun 零落库
  });

  it('实同步：method 模板 7→8（新建 PRESALES_SOLUTION）、MEDDICC 7 维不变（归一不重复）', async () => {
    const r = await syncAllMethodologies(); // 真实落库（幂等：已存在不动）
    const tpl = (await query('SELECT methodology_id FROM crm.methodology_template ORDER BY methodology_id')).rows.map((x) => x.methodology_id);
    expect(tpl).toContain('PRESALES_SOLUTION'); // 售前模板已批准（§6.13.12），镜像补齐
    // MEDDICC 保持 7 维：M1/E1/I1 归一到既有 M/E/I，不新增
    const md = (await query("SELECT count(*)::int n FROM crm.methodology_dimension WHERE methodology_id='MEDDICC'")).rows[0].n;
    expect(md).toBe(7);
    // 已存在方法论不破坏：BANT 4 维保持
    const bant = (await query("SELECT count(*)::int n FROM crm.methodology_dimension WHERE methodology_id='BANT'")).rows[0].n;
    expect(bant).toBe(4);
  });

  it('幂等：第二次全量同步零新增（template & dimension 均不动）', async () => {
    const t1 = (await query('SELECT count(*)::int n FROM crm.methodology_template')).rows[0].n;
    const d1 = (await query('SELECT count(*)::int n FROM crm.methodology_dimension')).rows[0].n;
    const r2 = await syncAllMethodologies(); // 第二遍
    const t2 = (await query('SELECT count(*)::int n FROM crm.methodology_template')).rows[0].n;
    const d2 = (await query('SELECT count(*)::int n FROM crm.methodology_dimension')).rows[0].n;
    expect(t2).toBe(t1);
    expect(d2).toBe(d1);
    const addedAll = r2.reduce((s, x) => s + (x.added || 0), 0);
    expect(addedAll).toBe(0); // 第二遍无任何新增维度
  });
});

describe('listMethodologySkew（漂移清单）', () => {
  it('输出 SKILL↔DB 镜像的漂移条目（编号平移/缺失维/多余维）', async () => {
    const skew = await listMethodologySkew();
    expect(skew.length).toBeGreaterThanOrEqual(1);
    // 已知漂移至少覆盖：OPPORTUNITY_MATRIX→OPP_MATRIX 模板 id 平移、FACT_VS_SCRIPT→FACT_VS_TALK 平移
    const ids = skew.map((s) => s.methodology_id);
    expect(ids.some((i) => /OPPORTUNITY_MATRIX|OPP_MATRIX/.test(i))).toBe(true);
    expect(ids.some((i) => /FACT_VS_SCRIPT|FACT_VS_TALK/.test(i))).toBe(true);
  });

  // 口径一致性回归（2026-09-01）：审计侧必须走与落库侧相同的 normalizeDims，
  // 否则 SKILL 原始键（M1/E1/I1）直比 DB 归一键（M/E/I）会凭空产生 6 条假漂移，
  // 误导「知识系统闭环」判定为断点。现拆为 dim_skew（真维度漂移）/ mapped（模板 id 已显式映射）。
  it('漂移条目区分 dim_skew 与 mapped，且无维度级假漂移', async () => {
    const skew = await listMethodologySkew();
    for (const s of skew) {
      expect(s).toHaveProperty('dim_skew');
      expect(s).toHaveProperty('mapped');
      expect(typeof s.dim_skew).toBe('boolean');
      expect(typeof s.mapped).toBe('boolean');
    }
    // 同步完成后不应存在维度级漂移（SKILL 与 DB 维度集合应完全一致）
    expect(skew.filter((s) => s.dim_skew).length).toBe(0);
    // 剩余的均为模板 id 命名差异，且已由 MIRROR_ID 显式登记 → mapped 标记生效
    const rest = skew.filter((s) => !s.dim_skew);
    expect(rest.length).toBe(skew.length);
    expect(rest.every((s) => s.id_skew === true)).toBe(true);
    expect(rest.filter((s) => s.mapped).length).toBeGreaterThanOrEqual(1);
  });

  // STOP_LOSS 镜像债修复回归：修正后 STOP_LOSS 与 SKILL 事实源完全对齐，不出现在漂移清单
  // （此前因 CB→probability 与标签自相矛盾且同口径归一，漂移被隐藏为审计假绿）。
  it('STOP_LOSS 完全对齐：不在漂移清单（无 id 漂移、无维度漂移）', async () => {
    const skew = await listMethodologySkew();
    const sl = skew.find((s) => s.methodology_id === 'STOP_LOSS');
    expect(sl).toBeUndefined();
  });
});