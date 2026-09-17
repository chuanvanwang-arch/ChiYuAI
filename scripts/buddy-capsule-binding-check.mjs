// scripts/buddy-capsule-binding-check.mjs
// Buddy 应用「胶囊 → method-* Skill → crm-native MCP 派发」集成契约校验
// 不依赖 PG / 运行服务：直接复用真实代码路径
//   - routeThroughIntake (src/kanban/scheduler.js)：验证胶囊 (intent/targetAgent, skill_slug) 经真实路由后 skill_slug 被原样保留（精确绑定）
//   - buildMcpTools (src/mcp/tools.js)：验证每个绑定的 skill/action 名确为 crm-native MCP 已暴露工具（真实可派发）
import { buildMcpTools } from '../src/mcp/tools.js';
import { routeThroughIntake } from '../src/kanban/scheduler.js';
import { listActions } from '../src/action/registry.js';

// ── 胶囊 → method-* / crm-* 精确绑定表（源：agentSpec.skillCalls 闭包 + MCP 工具清单）──
// intent: classifyRequirement 意图桶；targetAgent: 显式路由目标（缺省按 intent 推导）
// deterministic: 该绑定是否能经 routeThroughIntake 确定性保留（skill_slug ∈ 目标 agent.skillCalls）
const BINDINGS = [
  // 客户洞察
  { tab: '客户洞察', cap: '360 视图', skill: 'crm-account-360', intent: 'quote', deterministic: false },
  { tab: '客户洞察', cap: '重点客户', skill: 'method-funnel-classification', intent: 'followup', deterministic: true },
  { tab: '客户洞察', cap: '客户拜访', skill: 'method-intake-routing', targetAgent: 'intake-router', deterministic: true },
  { tab: '客户洞察', cap: '客户任务线', skill: 'crm-account-360', intent: 'quote', deterministic: false },
  { tab: '客户洞察', cap: '线索发现', skill: 'discovery-run', targetAgent: 'decision-agent', deterministic: true },
  { tab: '客户洞察', cap: '主动拓客', skill: 'prospecting-search', targetAgent: 'prospecting', deterministic: true },
  // 商机推进
  { tab: '商机推进', cap: '管道看板', skill: 'crm-deal-advance', intent: 'quote', deterministic: false },
  { tab: '商机推进', cap: '阶段评估', skill: 'method-stage-progression', intent: 'quote', deterministic: true },
  { tab: '商机推进', cap: '漏斗分类', skill: 'method-funnel-classification', intent: 'followup', deterministic: true },
  { tab: '商机推进', cap: '商机复盘', skill: 'decision-retrospective', intent: 'retro', deterministic: true },
  // 报价折扣
  { tab: '报价折扣', cap: '报价生成', skill: 'method-quote-engine', intent: 'quote', deterministic: true },
  { tab: '报价折扣', cap: '折扣策略', skill: 'method-quote-engine', intent: 'quote', deterministic: true },
  { tab: '报价折扣', cap: '价目表', skill: 'crm-account-360', intent: 'quote', deterministic: false },
  { tab: '报价折扣', cap: '折扣审批', skill: 'method-review-gate', targetAgent: 'review-gate', deterministic: true },
  // 决策审批
  { tab: '决策审批', cap: '审批流', skill: 'method-review-gate', targetAgent: 'review-gate', deterministic: true },
  { tab: '决策审批', cap: '复核闸门', skill: 'method-review-gate', targetAgent: 'review-gate', deterministic: true },
  { tab: '决策审批', cap: '决策追溯', skill: 'method-decision-enrich', intent: 'decision-enrich', deterministic: true },
  { tab: '决策审批', cap: '根因分析', skill: 'decision-retrospective', intent: 'retro', deterministic: true },
  // 业绩治理
  { tab: '业绩治理', cap: '销售监控', skill: 'method-followup-engine', intent: 'followup', deterministic: true },
  { tab: '业绩治理', cap: '决策监控', skill: 'method-decision-enrich', intent: 'decision-enrich', deterministic: true },
  { tab: '业绩治理', cap: '校准指标', skill: 'method-behavior-standard', intent: 'followup', deterministic: true },
  { tab: '业绩治理', cap: '团队看板', skill: 'crm-account-360', intent: 'quote', deterministic: false },
  // 财务（仅 finance 角色可见；crm-* 为 reserved 生命周期 Action，经 actionExecutor 派发）
  { tab: '财务', cap: '回款计划', skill: 'crm-payment-plan-create', deterministic: false },
  { tab: '财务', cap: '回款登记', skill: 'crm-payment-record-create', deterministic: false },
  { tab: '财务', cap: '发票管理', skill: 'crm-invoice-create', deterministic: false },
  { tab: '财务', cap: '财务应收看板', skill: 'crm-finance-receivables', deterministic: false },
];

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── BUDDY 应用清单（buddy-crm-manifest.json）胶囊守卫（2026-09-17 新增）──
// 背景：`BINDINGS` 覆盖的是**门户 Tab**（buddy-crm-portal.html）的胶囊→skill 绑定；
//   而**开放平台 BUDDY 应用**的胶囊在 `buddy-crm-manifest.json` 的 workModes[].capsules[]，
//   此前**无任何守卫** ⇒ 会出现「后端能力已上线、App 里零入口」的静默缺口（本轮实测：
//   信号总线 crm.signal 已有产出，但 3 个模式 16 个胶囊零引用 → 用户感受不到）。
// 三类断言：
//   ① 必需引用（正向）：指定胶囊必须引用指定工具 —— 防「新能力加完了 App 里没入口」；
//   ② 通用解析：胶囊里出现的 `反引号工具名` 必须真在 MCP 暴露集/registry —— 防「手册写了不存在的工具」；
//   ③ 绑定闭合：胶囊 skills ⊆ 所属工作模式 skills —— 防「胶囊引用了模式未声明的技能」。
// ⚠ 覆盖范围自证（避免「自指仪器」式假绿）：② 的扫描面 = 胶囊文本里**反引号包裹**的工具名，
//   当前 n=REQUIRED_TOOL_REFS 里的数量；纯散文描述的工具**扫不到**，故 ① 才是主守卫。
const REQUIRED_TOOL_REFS = [
  { mode: '销售坐席', capsule: '今日跟进', token: 'crm-signal-list' },
  { mode: '销售坐席', capsule: '提醒日历', token: 'crm-signal-ics' },
];

function checkManifestCapsules({ exposed, registryNames, bump }) {
  const mp = resolve('buddy-crm-manifest.json');
  if (!existsSync(mp)) { bump(false, 'buddy-crm-manifest.json 不存在'); return; }
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const modes = m?.home?.workModes || [];

  // ① 必需引用（正向断言）
  for (const r of REQUIRED_TOOL_REFS) {
    const mode = modes.find((w) => w.name === r.mode);
    const cap = mode?.capsules?.find((c) => c.name === r.capsule);
    if (!cap) {
      bump(false, `[必需引用] 胶囊缺失：${r.mode}/${r.capsule}`);
      continue;
    }
    const txt = [cap.systemPrompt, ...(cap.prompts || [])].join('\n');
    const cited = txt.includes(r.token);
    const toolOk = exposed.has(r.token) || registryNames.has(r.token);
    bump(cited && toolOk,
      `[必需引用] ${r.mode}/${r.capsule} 引用 ${r.token}`
      + `（胶囊内引用=${cited} | 工具存在=${toolOk}）`);
  }

  // ② 通用解析（含扫描面自证）
  const RE = /`((?:crm|method|discovery|prospecting|data-particle|decision)-[a-z0-9-]+)`/g;
  const tokens = new Map();
  for (const w of modes) {
    for (const c of w.capsules || []) {
      const txt = [c.systemPrompt, ...(c.prompts || [])].join('\n');
      for (const mm of txt.matchAll(RE)) tokens.set(mm[1], (tokens.get(mm[1]) || 0) + 1);
    }
  }
  console.log(`  · 通用解析扫描面：${tokens.size} 个反引号工具名`
    + `（${[...tokens.keys()].sort().join(', ') || '无'}）`
    + ' —— 纯散文描述的工具扫不到，二者互补；覆盖不足时请把工具名写成 `反引号形式`');
  for (const [name, n] of tokens) {
    const ok = exposed.has(name) || registryNames.has(name);
    bump(ok, `[通用解析] 胶囊引用的 \`${name}\`（${n} 次）在 MCP 暴露集/registry`);
  }

  // ③ 绑定闭合：只作**信息项**，不作断言。
  //   ⚠ 2026-09-17 实测反证：**模式级 `skills` 并非胶囊技能的上界** —— 仓库既有 11 个胶囊
  //   都超出所属模式声明（如「客户360」胶囊加 `method-role-map`、销售坐席模式只声明 4 个技能）。
  //   若把「胶囊 skills ⊆ 模式 skills」写成硬断言，就是**臆造一条不存在的契约** → 永久假红噪声。
  //   故此处仅打印供人工核对（真正的契约是：胶囊引用的技能必须是**已上架技能**，见 ② 通用解析）。
  const overcaps = [];
  const declared = new Set(modes.flatMap((w) => w.skills || []));
  for (const w of modes) {
    const modeSkills = new Set(w.skills || []);
    for (const c of w.capsules || []) {
      const extra = (c.skills || []).filter((s) => !modeSkills.has(s));
      if (extra.length) overcaps.push(`${w.name}/${c.name} +${extra.length}`);
    }
  }
  if (overcaps.length) {
    console.log(`  · [INFO] 胶囊额外绑定的技能（超出模式声明，**非违规**，仅提示核对上架状态）：`
      + `${overcaps.length} 个 —— ${overcaps.join('; ')}`);
  }
  console.log(`  · 守卫覆盖：3 模式 / ${modes.reduce((n, w) => n + (w.capsules || []).length, 0)} 胶囊`
    + ` / 模式声明技能 ${declared.size} 个`);
}


function run() {
  const { readTools, writeTools, readSensitiveTools, authTools } = buildMcpTools();
  const exposed = new Set([
    ...readTools, ...writeTools, ...readSensitiveTools, ...authTools,
  ].map((t) => t.name));
  // Action Registry（全量，含 reserved 生命周期）：Buddy 内部 dispatch 经 actionExecutor 派发，
  // 故契约需校验 skill 名 ∈ MCP 暴露集 或 ∈ 已注册 Action（reserved 动作不进 MCP 暴露集但可被 dispatch）。
  const registryNames = new Set(listActions().map((a) => a.name));

  let pass = 0, fail = 0;
  const fails = [];
  const PA_SKILLS = resolve('plugin-platform-admin/skills');
  for (const b of BINDINGS) {
    const task = { payload: { intent: b.intent, targetAgent: b.targetAgent, skill_slug: b.skill } };
    const routed = routeThroughIntake(task);
    const got = routed.payload.skill_slug;
    const preserved = got === b.skill;

    let isResolved = true, resolveNote = '';
    if (b.scope === 'platform-admin') {
      // platform-admin 作用域：不比对 crm-native MCP 工具集，改为校验插件 Skill 目录真实存在
      isResolved = existsSync(resolve(PA_SKILLS, b.skill, 'registry.json'));
      resolveNote = `platform-admin skill=${isResolved}`;
    } else {
      isResolved = exposed.has(b.skill) || registryNames.has(b.skill);
      resolveNote = `mcp-tool=${exposed.has(b.skill)}|registry=${registryNames.has(b.skill)}`;
    }
    const ok = isResolved && (!b.deterministic || preserved);
    if (ok) pass++;
    else { fail++; fails.push({ ...b, got, preserved, isResolved, resolveNote }); }
  }

  console.log('--- buddy-crm-manifest.json（开放平台 App 胶囊）守卫 ---');
  checkManifestCapsules({
    exposed,
    registryNames,
    bump: (isOk, msg) => {
      if (isOk) pass++;
      else { fail++; fails.push({ manifest: true, cap: msg }); }
    },
  });

  console.log('=== Buddy 胶囊 → method-* → crm-native MCP 派发 契约校验 ===');
  console.log(`MCP 暴露工具总数: ${exposed.size}`);
  console.log(`method-/decision- 类工具: ${[...exposed].filter((n) => /^method-|decision-/.test(n)).sort().join(', ')}`);
  console.log(`胶囊绑定总数: ${BINDINGS.length} | 通过: ${pass} | 失败: ${fail}`);
  if (fails.length) {
    console.log('--- 失败项 ---');
    for (const f of fails) {
      if (f.manifest) { console.log(`  [manifest 胶囊] ${f.cap}`); continue; }
      console.log(`  [${f.tab}/${f.cap}] skill=${f.skill} | ${f.resolveNote} | 路由保留=${f.preserved}(got=${f.got})`);
    }
    process.exit(1);
  }
  console.log('✅ 全部胶囊绑定均通过：① method-*/crm-* 绑定真实存在于 crm-native MCP 暴露工具集，platform-admin 绑定真实存在于插件 Skill 目录；② 确定性绑定经 routeThroughIntake 原样保留；③ buddy-crm-manifest.json 里必需工具引用齐备、胶囊内反引号工具名均可解析（信号能力已在 App 侧有入口）。');
}

run();
