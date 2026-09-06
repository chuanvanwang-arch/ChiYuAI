// test/sales-named-accounts/named-account-board.test.js — 指名客户看板聚合纯函数
// 契约：buildNamedAccountBoard → rows[]，行含 id/name/owner/tier/visits30/visitPass/leads/opps/contracts/gaps/visits
import { describe, it, expect } from 'vitest';
import { buildNamedAccountBoard, boardSummary, accountRow, lastVisitAtOf, isLostContact } from '../../src/sales/namedAccountBoard.js';
import { mergedTargets } from '../../src/sales/namedAccountTargets.js';
import { evaluateBehaviorChecklist } from '../../src/sales/behaviorChecklist.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';
import { isControlledPredicate } from '../../src/particles/particleModel.js';

describe('Task3：named_assignment 受控谓词（审计边）', () => {
  it('named_assignment 谓词受控（审计边可建，决策第0闸可见）', () => {
    expect(isControlledPredicate('named_assignment')).toBe(true);
  });

  it('accountRow: named_owner 优先, 无 named_owner 回退 owner_id(向后兼容), named 字段标记', () => {
    const rows = buildNamedAccountBoard({
      accounts: [
        { id: 'A-003', title: '新指名户', payload: { named_owner: 'alice', tier: '重点', visit_notes: [] } },
        { id: 'A-004', title: '旧数据户', payload: { owner_id: 'bob', tier: '目标', visit_notes: [] } },
        { id: 'A-005', title: '无主户', payload: { tier: '潜力', visit_notes: [] } },
      ],
      deals: [],
      contracts: [],
      targetsCfg: cfg,
    });
    const a3 = rows.find(r => r.id === 'A-003');
    const a4 = rows.find(r => r.id === 'A-004');
    const a5 = rows.find(r => r.id === 'A-005');
    expect(a3.owner).toBe('alice');
    expect(a3.named).toBe(true);
    expect(a4.owner).toBe('bob');
    expect(a4.named).toBe(true);  // named_state 缺省 active → 旧数据视为指名
    expect(a5).toBeUndefined();   // 指名客户视图下无主账户被剔除（非指名客户不计入）
  });

  it('ownerFilter 按 named_owner 过滤（非 owner_id）', () => {
    const rows = buildNamedAccountBoard({
      accounts: [
        { id: 'A-003', title: '新指名户', payload: { named_owner: 'alice', owner_id: 'bob', tier: '重点', visit_notes: [] } },
      ],
      deals: [],
      contracts: [],
      targetsCfg: cfg,
      ownerFilter: 'alice',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('alice');
  });

  it('named_state=inactive 的账户不出现在看板', () => {
    const rows = buildNamedAccountBoard({
      accounts: [
        { id: 'A-003', title: '停用户', payload: { named_owner: 'alice', named_state: 'inactive', tier: '重点', visit_notes: [] } },
      ],
      deals: [],
      contracts: [],
      targetsCfg: cfg,
    });
    // 看板是"当前指名客户"视图——软停用账户不计入（禁删铁律：状态位而非 DELETE）
    expect(rows.find(r => r.id === 'A-003')).toBeUndefined();
  });
});

// 与生产语义一致：读 config_store 后必须先 mergedTargets 铺底（tiers/window_days/metrics 缺一不可）
const cfg = mergedTargets({});

const base = {
  accounts: [
    { id: 'A-001', title: '朝阳机械', payload: { owner_id: 'alice', tier: '重点', visit_notes: [{ at: new Date(Date.now() - 2 * 86400000).toISOString() }] } },
    { id: 'A-002', title: '北方集团', payload: { owner_id: 'bob', tier: '目标', visit_notes: [] } },
  ],
  deals: [
    { id: 'D-001', payload: { account_id: 'A-001', stage: 'S3' } },
    { id: 'D-002', payload: { account_id: 'A-002', stage: 'lead' } },
  ],
  contracts: [{ id: 'C-001', payload: { account_id: 'A-001' } }],
};

describe('指名客户看板聚合', () => {
  it('owner 过滤：alice 只见自己的客户', () => {
    const rows = buildNamedAccountBoard({ ...base, targetsCfg: cfg, ownerFilter: 'alice' });
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe('alice');
  });

  it('四维：拜访/线索/商机/合同计数正确', () => {
    const rows = buildNamedAccountBoard({ ...base, targetsCfg: cfg });
    const a1 = rows.find(r => r.id === 'A-001');
    expect(a1.leads).toBe(0);
    expect(a1.opps).toBe(1);
    expect(a1.contracts).toBe(1);
    expect(a1.visits30).toBe(1);
    expect(a1.visitPass).toBe(true);
  });

  it('目标客户无拜访 → 覆盖率缺口', () => {
    const rows = buildNamedAccountBoard({ ...base, targetsCfg: cfg });
    const a2 = rows.find(r => r.id === 'A-002');
    expect(a2.visitPass).toBe(false);
    expect(a2.gaps).toContain('覆盖率缺口（近30天无拜访）');
  });

  it('超过 coverage.lost_contact_days 天无拜访 → 接触流失警戒（id32 可调）', () => {
    // A-003：100 天前唯一拜访（默认警戒 90 天）→ 应标「接触流失」
    const accs = [
      { id: 'A-001', title: '甲', payload: { owner_id: 'alice', tier: '目标', visit_notes: [{ at: new Date(Date.now() - 100 * 86400000).toISOString() }] } },
    ];
    const rows = buildNamedAccountBoard({ accounts: accs, deals: [], contracts: [], targetsCfg: cfg });
    expect(rows[0].gaps.some(g => g.includes('接触流失警戒'))).toBe(true);
    // 配置放宽到 120 天 → 100 天前不算流失
    const loose = mergedThresholds({ coverage: { lost_contact_days: 120 } });
    const rows2 = buildNamedAccountBoard({ accounts: accs, deals: [], contracts: [], targetsCfg: cfg, thresholds: loose });
    expect(rows2[0].gaps).not.toContain('接触流失警戒');
  });

  it('S4/S5 停留超 30 天 → 推进卡点', () => {
    const stuck = {
      ...base,
      deals: [{ id: 'D-003', payload: { account_id: 'A-001', stage: 'S4', stage_changed_at: new Date(Date.now() - 40 * 86400000).toISOString() } }],
    };
    const rows = buildNamedAccountBoard({ ...stuck, targetsCfg: cfg });
    const a1 = rows.find(r => r.id === 'A-001');
    expect(a1.gaps).toContain('推进卡点（S4/S5 停留>30天）');
  });

  it('accountRow 输出 visits 明细（供详情 TAB）', () => {
    const rows = buildNamedAccountBoard({ ...base, targetsCfg: cfg });
    const a1 = rows.find(r => r.id === 'A-001');
    expect(Array.isArray(a1.visits)).toBe(true);
    expect(a1.visits[0]).toHaveProperty('at');
  });

  it('BANTCC 缺口：商机存在但资质齐全度<0.6 → 标记缺口', () => {
    const rows = buildNamedAccountBoard({
      accounts: [{ id: 'A-010', title: '缺口户', payload: { owner_id: 'alice', tier: '目标' } }],
      deals: [{ id: 'D-010', payload: { account_id: 'A-010', stage: 'S3', ai: { bantcc_completeness: { value: 0.4 } } } }],
      contracts: [],
      targetsCfg: cfg,
    });
    const a = rows.find(r => r.id === 'A-010');
    expect(a.opps).toBe(1);
    expect(a.gaps).toContain('BANTCC 信息缺口');
  });

  it('BANTCC 达标：商机资质齐全度≥0.6 → 不标记缺口', () => {
    const rows = buildNamedAccountBoard({
      accounts: [{ id: 'A-011', title: '达标户', payload: { owner_id: 'alice', tier: '目标' } }],
      deals: [{ id: 'D-011', payload: { account_id: 'A-011', stage: 'S3', ai: { bantcc_completeness: { value: 0.8 } } } }],
      contracts: [],
      targetsCfg: cfg,
    });
    const a = rows.find(r => r.id === 'A-011');
    expect(a.gaps).not.toContain('BANTCC 信息缺口');
  });

  it('BANTCC 派生取所属商机最高齐全度（多商机取 max）', () => {
    const rows = buildNamedAccountBoard({
      accounts: [{ id: 'A-012', title: '多商机户', payload: { owner_id: 'alice', tier: '目标' } }],
      deals: [
        { id: 'D-012a', payload: { account_id: 'A-012', stage: 'S3', ai: { bantcc_completeness: { value: 0.4 } } } },
        { id: 'D-012b', payload: { account_id: 'A-012', stage: 'S3', ai: { bantcc_completeness: { value: 0.9 } } } },
      ],
      contracts: [],
      targetsCfg: cfg,
    });
    const a = rows.find(r => r.id === 'A-012');
    expect(a.gaps).not.toContain('BANTCC 信息缺口'); // 取 max=0.9 ≥0.6
  });
});

describe('指名客户看板聚合 KPI（boardSummary）', () => {
  const now = Date.now();
  const kpiBase = {
    accounts: [
      { id: 'A-001', title: '朝阳机械', payload: { owner_id: 'alice', tier: '重点', visit_notes: [
        { at: new Date().toISOString(), t_objective: '今日拜访', t_result: 'r', t_next: 'n' },          // 今日
        { at: new Date(now - 3 * 86400000).toISOString(), t_objective: '本周', t_result: 'r', t_next: 'n' }, // 本周(近7天)
        { at: new Date(now - 20 * 86400000).toISOString(), t_objective: '本月', t_result: 'r', t_next: 'n' }, // 本月(近30天)
        { at: new Date(now - 40 * 86400000).toISOString(), t_objective: '更早', t_result: 'r', t_next: 'n' }, // 超出本月
      ] } },
      { id: 'A-002', title: '北方集团', payload: { owner_id: 'bob', tier: '目标', visit_notes: [] } },
    ],
    deals: [
      { id: 'D-001', payload: { account_id: 'A-001', stage: 'S3' } },
      { id: 'D-002', payload: { account_id: 'A-002', stage: 'lead' } },
    ],
    contracts: [{ id: 'C-001', payload: { account_id: 'A-001' } }],
  };

  it('目标客户数 = scope 内账户数（alice 名下 1）', () => {
    const s = boardSummary(kpiBase.accounts, kpiBase.deals, kpiBase.contracts, cfg, 'alice');
    expect(s.targetCustomers).toBe(1);
    expect(s.namedTotal).toBe(1);
  });

  it('今日/本周/本月拜访数按日期窗口聚合', () => {
    const s = boardSummary(kpiBase.accounts, kpiBase.deals, kpiBase.contracts, cfg, 'alice');
    expect(s.todayVisits).toBe(1);
    expect(s.weekVisits).toBe(2);   // 今日 + 3天前
    expect(s.monthVisits).toBe(3);  // + 20天前
    expect(s.totalVisits).toBe(4);  // 含 40天前
  });

  it('owner 过滤后 KPI 仅计本人（bob 无拜访）', () => {
    const s = boardSummary(kpiBase.accounts, kpiBase.deals, kpiBase.contracts, cfg, 'bob');
    expect(s.targetCustomers).toBe(1);
    expect(s.todayVisits).toBe(0);
    expect(s.totalVisits).toBe(0);
  });

  it('四维汇总：alice 商机/合同/缺口', () => {
    const s = boardSummary(kpiBase.accounts, kpiBase.deals, kpiBase.contracts, cfg, 'alice');
    expect(s.opps).toBe(1);
    expect(s.contracts).toBe(1);
    expect(typeof s.gapTotal).toBe('number');
  });

  it('boardSummary 输出 21 条行为合格率 behaviorPassRate', () => {
    const s = boardSummary(kpiBase.accounts, kpiBase.deals, kpiBase.contracts, cfg, 'alice');
    expect(typeof s.behaviorPassRate).toBe('number');
    expect(s.behaviorPassRate).toBeGreaterThanOrEqual(0);
    expect(s.behaviorPassRate).toBeLessThanOrEqual(100);
  });

  it('L1：todayCalls 计入 type=call，todayVisits 仅计非 call（向后兼容缺省 visit）', () => {
    const accs = [{
      id: 'A-020', title: '呼户', payload: { owner_id: 'alice', tier: '目标', visit_notes: [
        { at: new Date().toISOString(), type: 'call' },
        { at: new Date().toISOString() },
        { at: new Date().toISOString(), type: 'call' },
      ] },
    }];
    const s = boardSummary(accs, [], [], cfg, 'alice');
    expect(s.todayCalls).toBe(2);
    expect(s.todayVisits).toBe(1);
  });

  it('L1：weekVisitCustomers = 近7天有拜访的去重账户数（owner 过滤后）', () => {
    const accs = [
      { id: 'A-021', title: '户甲', payload: { owner_id: 'alice', tier: '目标', visit_notes: [
        { at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { at: new Date(Date.now() - 2 * 86400000).toISOString() },
      ] } },
      { id: 'A-022', title: '户乙', payload: { owner_id: 'alice', tier: '目标', visit_notes: [
        { at: new Date(Date.now() - 3 * 86400000).toISOString() },
      ] } },
      { id: 'A-023', title: '户丙', payload: { owner_id: 'bob', tier: '目标', visit_notes: [
        { at: new Date(Date.now() - 1 * 86400000).toISOString() },
      ] } },
    ];
    const s = boardSummary(accs, [], [], cfg, 'alice');
    expect(s.weekVisitCustomers).toBe(2); // 甲、乙，去重；丙属 bob 不计
  });

  it('L1：weekNewCustomers = created_at 近7天的账户数', () => {
    const accs = [
      { id: 'A-031', title: '新客', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), payload: { owner_id: 'alice', tier: '目标' } },
      { id: 'A-032', title: '老客', created_at: new Date(Date.now() - 40 * 86400000).toISOString(), payload: { owner_id: 'alice', tier: '目标' } },
    ];
    const s = boardSummary(accs, [], [], cfg, 'alice');
    expect(s.weekNewCustomers).toBe(1);
  });

  it('L1：量化目标随 behaviorStd 覆写（每天电话量目标）', () => {
    const accs = [{ id: 'A-040', title: '户', payload: { owner_id: 'alice', tier: '目标', visit_notes: [] } }];
    const s = boardSummary(accs, [], [], cfg, 'alice', [], { daily_call_count: 20 });
    expect(s.dailyCallTarget).toBe(20);
    expect(s.dailyVisitTarget).toBe(2); // 未覆写取默认
  });

  it('L1：coverage 覆盖/拜访容量基准注入（id32 可后台直调）', () => {
    const s = boardSummary(base.accounts, base.deals, base.contracts, cfg, 'alice');
    // 默认标准（外部 SKILL 建议值）
    expect(s.covDailyVisitTarget).toBe(3);
    expect(s.covWeeklyVisitTarget).toBe(15);
    expect(s.covDailyVisitOptimized).toBe(4);
    expect(s.covInfoCollectWeekly).toBe(5);
    expect(s.covCustomerCountMin).toBe(60);
    expect(s.covCustomerCountTarget).toBe(75);
    // 达标布尔存在且为布尔
    expect(typeof s.covVisitsOk).toBe('boolean');
    expect(typeof s.covWeekVisitsOk).toBe('boolean');
    expect(typeof s.covCustomerOk).toBe('boolean');
    // 客户数 1 < 60 → covCustomerOk=false
    expect(s.covCustomerOk).toBe(false);
    // 配置可调：daily=5/week=20/customer_min=30 → 标准随配置变化
    const cov = mergedThresholds({ coverage: { daily_visits_target: 5, weekly_visits_target: 20, customer_count_min: 30 } });
    const sc = boardSummary(base.accounts, base.deals, base.contracts, cfg, 'alice', [], {}, cov);
    expect(sc.covDailyVisitTarget).toBe(5);
    expect(sc.covWeeklyVisitTarget).toBe(20);
    // alice 名下 1 客户，min=30 仍不达标（保持 false）
    expect(sc.covCustomerOk).toBe(false);
  });
});

describe('21 条行为标准合格线（evaluateBehaviorChecklist）', () => {
  it('空账户 → 21 条逐项可判定且关键项为 false', () => {
    const r = evaluateBehaviorChecklist({}, [], []);
    expect(r.total).toBe(21);
    expect(r.pass).toBeLessThanOrEqual(5); // 无数据时仅「无需求/无商机=合规」等默认真项
    expect(r.gaps.length).toBeGreaterThanOrEqual(16);
    expect(r.items['01-01']).toBe(false);
    expect(r.items['01-02']).toBe(false);
    expect(r.items['03-01']).toBe(false);
    expect(r.items['07-01']).toBe(false);
  });

  it('完整账户+商机+联系人 → 高通过率', () => {
    const accountPayload = {
      account_segment: 'target',
      visit_notes: [{
        at: new Date().toISOString(),
        t_type: 'opportunity',
        t_objective: '确认方案范围与预算',
        t_result: '客户认可 A3 方案',
        t_next: '下周三报价',
        t_achieved: '达到',
        prepare: '已看客户年报',
        review: '已复盘',
        t_new_contact: false,
        t_collaboration: '售前同事张三',
      }],
      needs: { pain: '人工排版效率低' },
    };
    const deals = [{
      payload: {
        account_id: 'A-001',
        stage: 'S3',
        ai: { bantcc_completeness: { value: 0.8 } },
        win_strategy: '总拥有成本优势',
        team: ['alice', 'bob'],
      },
    }];
    const contacts = [
      { payload: { account_id: 'A-001', business_title: '采购经理' } },
      { payload: { account_id: 'A-001', business_title: '技术主管' } },
    ];
    const r = evaluateBehaviorChecklist(accountPayload, deals, contacts);
    expect(r.total).toBe(21);
    expect(r.pass).toBeGreaterThan(15);
    expect(r.items['03-01']).toBe(true);
    expect(r.items['04-01']).toBe(true);
    expect(r.items['06-02']).toBe(true);
    expect(r.items['06-03']).toBe(true);
  });

  it('BANTCC 不达标 → 03-01 为 false', () => {
    const r = evaluateBehaviorChecklist({}, [{
      payload: { account_id: 'A-001', ai: { bantcc_completeness: { value: 0.3 } } },
    }], []);
    expect(r.items['03-01']).toBe(false);
    expect(r.gaps).toContain('BH-03 BANTCC');
  });

  // 2026-08-30 回归守卫：种子数据改用无 t_ 前缀字段名后，21 条判定曾全部失效。
  // 契约：visit_notes 项字段名 t_* 与无前缀两种写法必须等价判定。
  it('字段兼容：t_ 前缀 与 无前缀 写法判定结果完全一致', () => {
    const noteT = {
      at: new Date().toISOString(),
      t_type: 'opportunity', t_objective: '确认方案范围与预算', t_result: '客户认可 A3 方案',
      t_next: '下周三报价', t_achieved: '达到', prepare: '已看客户年报', review: '已复盘',
      t_new_contact: true, t_collaboration: '售前同事张三',
    };
    const notePlain = {
      at: new Date().toISOString(),
      type: 'opportunity', objective: '确认方案范围与预算', result: '客户认可 A3 方案',
      next: '下周三报价', achieved: '达到', prepare: '已看客户年报', review: '已复盘',
      new_contact: true, collaboration: '售前同事张三',
    };
    const base = { account_segment: 'target', needs: { pain: '人工排版效率低' } };
    const a = evaluateBehaviorChecklist({ ...base, visit_notes: [noteT] }, [], []);
    const b = evaluateBehaviorChecklist({ ...base, visit_notes: [notePlain] }, [], []);
    expect(b.pass).toBe(a.pass);
    expect(b.items).toEqual(a.items);
    // 关键项在新写法下必须为真（否则等于静默失效）
    expect(b.items['01-01']).toBe(true);
    expect(b.items['01-02']).toBe(true);
    expect(b.items['03-03']).toBe(true);
    expect(b.items['04-02']).toBe(true);
    expect(b.items['04-03']).toBe(true);
    expect(b.items['07-02']).toBe(true);
  });
});

// ───── 2026-08-31：失联判定（侧栏「客户跟踪」告警角标数据源）─────
describe('失联判定纯函数（lastVisitAtOf / isLostContact）', () => {
  const TH = mergedThresholds({}); // coverage.lost_contact_days 默认 90

  it('lastVisitAtOf 取最近一次拜访时间戳（无拜访/脏数据 → null）', () => {
    const now = Date.now();
    const d100 = new Date(now - 100 * 86400000).toISOString();
    const d10 = new Date(now - 10 * 86400000).toISOString();
    // 多条拜访取最近（max），非首条
    expect(lastVisitAtOf({ visit_notes: [{ at: d100 }, { at: d10 }] })).toBe(new Date(d10).getTime());
    expect(lastVisitAtOf({ visit_notes: [] })).toBeNull();
    expect(lastVisitAtOf({})).toBeNull();
    // 脏数据：at 非法被过滤（防御 NaN 污染 max）
    expect(lastVisitAtOf({ visit_notes: [{ at: 'not-a-date' }] })).toBeNull();
    expect(lastVisitAtOf({ visit_notes: [{ at: d10 }, { at: 'bad' }] })).toBe(new Date(d10).getTime());
  });

  it('isLostContact 按 coverage.lost_contact_days 判定（阈值可配，零硬编码）', () => {
    const now = Date.now();
    // 100 天前 → 超过默认 90 天 → true
    expect(isLostContact({ visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] }, TH)).toBe(true);
    // 10 天前 → false
    expect(isLostContact({ visit_notes: [{ at: new Date(now - 10 * 86400000).toISOString() }] }, TH)).toBe(false);
    // 从未拜访 → false（新客户不算失联，避免误报）
    expect(isLostContact({ visit_notes: [] }, TH)).toBe(false);
    expect(isLostContact({}, TH)).toBe(false);
    // 阈值可调：配置成 5 天 → 10 天前变 true（配置化铁律验证）
    const tight = mergedThresholds({ coverage: { lost_contact_days: 5 } });
    expect(isLostContact({ visit_notes: [{ at: new Date(now - 10 * 86400000).toISOString() }] }, tight)).toBe(true);
    // 阈值放宽到 120 天 → 100 天前变 false
    const loose = mergedThresholds({ coverage: { lost_contact_days: 120 } });
    expect(isLostContact({ visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] }, loose)).toBe(false);
  });

  it('accountRow 输出 lostContact/lastContactDays（仅指名客户计算）', () => {
    const now = Date.now();
    const named = accountRow(
      { id: 'A-1', payload: { name: '失联户', named_owner: 'alice', named_state: 'active',
        visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] } },
      [], [], cfg, [], TH
    );
    expect(named.named).toBe(true);
    expect(named.lostContact).toBe(true);
    expect(named.lastContactDays).toBe(100);

    const fresh = accountRow(
      { id: 'A-2', payload: { name: '活跃户', named_owner: 'bob', named_state: 'active',
        visit_notes: [{ at: new Date(now - 3 * 86400000).toISOString() }] } },
      [], [], cfg, [], TH
    );
    expect(fresh.lostContact).toBe(false);
    expect(fresh.lastContactDays).toBe(3);

    // 无主户（非指名）→ lostContact 恒 false（与 alertRed 统计同源，不引入新口径）
    const orphan = accountRow(
      { id: 'A-3', payload: { name: '无主户', visit_notes: [{ at: new Date(now - 200 * 86400000).toISOString() }] } },
      [], [], cfg, [], TH
    );
    expect(orphan.named).toBe(false);
    expect(orphan.lostContact).toBe(false);
    expect(orphan.lastContactDays).toBeNull();
  });

  it('boardSummary 汇总 lostContactCount（无主户不计）', () => {
    const now = Date.now();
    const accs = [
      { id: 'A-1', payload: { name: '失联1', named_owner: 'alice', named_state: 'active',
        visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] } },
      { id: 'A-2', payload: { name: '失联2', named_owner: 'alice', named_state: 'active',
        visit_notes: [{ at: new Date(now - 120 * 86400000).toISOString() }] } },
      { id: 'A-3', payload: { name: '活跃', named_owner: 'alice', named_state: 'active',
        visit_notes: [{ at: new Date(now - 3 * 86400000).toISOString() }] } },
      { id: 'A-4', payload: { name: '无主', visit_notes: [{ at: new Date(now - 300 * 86400000).toISOString() }] } },
    ];
    const s = boardSummary(accs, [], [], cfg, 'alice', [], {}, TH);
    expect(s.lostContactCount).toBe(2); // A-1/A-2 失联；A-3 活跃；A-4 无主不计
  });

  it('DRY 守卫：gapHint 接触流失警戒与 isLostContact 同源（两处口径一致）', () => {
    const now = Date.now();
    const acc = { id: 'A-DRY', title: '同源验证户', payload: { named_owner: 'alice', named_state: 'active', tier: '目标',
      visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] } };
    const rows = buildNamedAccountBoard({ accounts: [acc], deals: [], contracts: [], targetsCfg: cfg, thresholds: TH });
    // gapHint 标「接触流失警戒」 ⟺ accountRow.lostContact 为 true（消除双源漂移）
    expect(rows[0].gaps.some(g => g.includes('接触流失警戒'))).toBe(true);
    expect(rows[0].lostContact).toBe(true);
    // 放宽阈值 → 两者同时为 false
    const loose = mergedThresholds({ coverage: { lost_contact_days: 150 } });
    const rows2 = buildNamedAccountBoard({ accounts: [acc], deals: [], contracts: [], targetsCfg: cfg, thresholds: loose });
    expect(rows2[0].gaps.some(g => g.includes('接触流失警戒'))).toBe(false);
    expect(rows2[0].lostContact).toBe(false);
  });
});