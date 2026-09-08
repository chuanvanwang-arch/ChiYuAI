/**
 * 把「绑定技能」承载的方法论内核内联进每个胶囊/模式的 systemPrompt。
 *
 * 背景：connector/skills/ 下的 16 个技能尚未在开放平台市场上架，配置页「绑定技能」
 * 下拉选不到。若不处理，胶囊会失去方法论能力。本脚本把每个技能的核心方法论压成
 * 一段精炼文本，追加到 systemPrompt 末尾的【方法论内核】段，使胶囊自包含。
 *
 * 用法: node scripts/inline-skill-capability.mjs [--dry]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

/** 技能 → 方法论内核（精炼到 60~140 字，可直接注入模型） */
const SKILL_KERNEL = {
  'crm-native':
    '【编排】先识别意图（查询 / 写入 / 风险 / 方法论），再分发到对应能力；意图不明时先向用户澄清再执行，不臆测。',
  'crm-query':
    '【检索】跨模块推理四通道：粒子图关系遍历、多跳路径、语义相似检索、历史决策先例。返回结构化结果，并标注数据来源与时间口径。',
  'crm-write':
    '【写入】两阶段：先完整展示待写入内容与影响范围，获得用户显式确认后才落库；写操作必经决策第 0 闸与 HITL；绝对禁止删除，只能停用或归档。',
  'crm-risk':
    '【风险探测】常驻检查四类异常：商机到技术方案超 30 天、赢单前无方案、回款逾期、阶段倒挂。命中即预警并给出止损建议。',
  'method-bant':
    '【BANT】逐项评估 Budget 预算 / Authority 权限 / Need 需求 / Timeline 时间线四维。缺任一硬维度禁止升级阶段，先补维度再谈推进。',
  'method-meddicc':
    '【MEDDICC】七维：Metrics 量化收益、Economic Buyer 经济买家、Decision Criteria 决策标准、Decision Process 决策流程、Identify Pain 痛点确认、Champion 内部拥护者、Competition 竞争。多决策人、周期超 3 个月或金额较大的商机必须走全量七维。',
  'method-role-map':
    '【角色地图】识别决策链四类角色：决策者（拍板）、影响者（左右）、使用者（实际用）、利益相关方（受影响）。标注各自立场（支持 / 中立 / 反对）与影响力权重；缺失关键角色即判高风险。',
  'method-funnel-classification':
    '【大漏斗分类】客户分三类：商机客户（已有在跟商机）、目标客户（有明确意向待开发）、潜力客户（画像匹配但未接触）。按类确定接触节奏与资源投入。',
  'method-opportunity-matrix':
    '【机会矩阵】按商业价值 × 可行性 × 竞争定位三轴排序：高价值高可行主攻、高价值低可行培育、低价值高可行快打、低价值低可行暂缓。',
  'method-risk-tradeoff':
    '【风险权衡】量化风险与收益比；触碰红线（合规问题、超权限、无书面批文）一票否决；有可行缓解措施才可推进，且缓解措施须写进结论。',
  'method-stage-progression':
    '【阶段推进】S1-S6 按客户行为三列判定（客户已做 / 已确认 / 已承诺），不采信销售主观判断。每阶段列出缺失行为作为推进条件。',
  'method-stop-loss':
    '【止损点】预设三条退出线：负净值、投入预算上限、退出门条件。触发即建议退出并说明沉没成本，防止被已投入绑架。',
  'method-behavior-standard':
    '【行为标准】21 条合格线（BH-01~07 有/无检查）+ TAORAN 六要素拜访记录：时间、地点、人物、议题、结论、下一步。',
  'method-fact-vs-script':
    '【事实 vs 话术】严格区分可验证证据（有记录 / 有文件 / 有第三方佐证）与口头表述。以事实为决策依据，话术仅作跟进线索，并标注来源与日期。',
  'decision-retrospective':
    '【决策复盘】按时间窗口统计决策质量：根因分布、应连边缺失率、结果校验态。产出可复核的整改处方，复盘时区分事实与话术。',
  'method-presales':
    '【售前方案】六维评估：方案契合、技术可行、价值量化、风险异议、差异化、交付可信。作为商机能否进入报价的门控。',
};

const KERNEL_TAG = '【方法论内核】';

/** 去掉已有内核段，再重新追加，保证幂等 */
const stripKernel = (text) => {
  const i = text.indexOf(KERNEL_TAG);
  return i === -1 ? text.trim() : text.slice(0, i).trim();
};

const buildKernel = (skills) => {
  const parts = (skills || []).map((s) => SKILL_KERNEL[s]).filter(Boolean);
  if (!parts.length) return '';
  return `${KERNEL_TAG}\n${parts.join('\n')}`;
};

const apply = (text, skills) => {
  const base = stripKernel(text || '');
  const kernel = buildKernel(skills);
  return kernel ? `${base}\n\n${kernel}` : base;
};

const manifestPath = join(root, 'buddy-crm-manifest.json');
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

const unknown = new Set();
let capsuleCount = 0;
let kernelCount = 0;

for (const w of m.home.workModes) {
  w.systemPrompt = apply(w.systemPrompt, w.skills);
  for (const s of w.skills || []) if (!SKILL_KERNEL[s]) unknown.add(s);
  for (const c of w.capsules) {
    c.systemPrompt = apply(c.systemPrompt, c.skills);
    for (const s of c.skills || []) if (!SKILL_KERNEL[s]) unknown.add(s);
    capsuleCount += 1;
    if (c.systemPrompt.includes(KERNEL_TAG)) kernelCount += 1;
  }
}

if (unknown.size) {
  console.error('未知技能（无内核映射）: ' + [...unknown].join(', '));
  process.exit(1);
}

if (!DRY) writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');

console.log(`胶囊 ${capsuleCount} 个，已内联方法论内核 ${kernelCount} 个`);
console.log(`模式 ${m.home.workModes.length} 个，系统提示词均已重写`);
if (DRY) console.log('(dry-run 未写入)');
