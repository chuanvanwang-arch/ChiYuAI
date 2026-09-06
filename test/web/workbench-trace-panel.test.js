// test/web/workbench-trace-panel.test.js — C-DAI Task 13（T11/T12/T13）作战室溯源面板守卫
// 背景（2026-08-30）：Task 13 三块前端已在先前会话落地（以代码事实为准，不重复造轮子）：
//   ① 单决策四层溯源抽屉：_rootCauseHtml()（sales-decision-monitor.html:860）+ dnRootCause() 拉 /api/decision/:id/trace（:745-764）
//   ② 巡检卡业务结果行：drillGateAttribution() 并行拉 /api/decision/:id/outcome（:521-528）+ snapHtml() 渲染业务结果行与补录入口（:535-560）
//   ③ SSE calibration 域浮卡：es.addEventListener('calibration')（:1227-1231）+ renderRetroFab()（:1160）
// 本守卫锁定上述契约，防回归。零硬编码色值原则同时被钉死（浮卡/抽屉/巡检卡全部走 tokens.css 变量）。
// 2026-08-30 补充：巡检卡归因类别色（.cat.input_missing/.input_error/.inference_bias/.context_insufficient）
//   原为裸 hex（#e8923a/#e5484d/#8b5cf6/#3b82f6），违反「颜色 100% 走 tokens.css 语义变量」铁律 →
//   tokens.css 补 --cat-* 语义分类 token，页面改 var()。本守卫锁死该契约。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/web/sales-decision-monitor.html', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../src/web/tokens.css', import.meta.url), 'utf8');
const autoSuggestSrc = readFileSync(new URL('../../src/calibration/autoSuggest.js', import.meta.url), 'utf8');

describe('Task 13 · 单决策四层溯源抽屉（T11）', () => {
  it('前端存在四层溯源抽屉渲染函数 _rootCauseHtml', () => {
    expect(html).toMatch(/function\s+_rootCauseHtml\(rc\)/);
  });

  it('抽屉按四层结构渲染：①J 决策脊柱 ②M 记忆系统 ③④K 知识系统→粒子库', () => {
    expect(html).toMatch(/① J 决策脊柱/);
    expect(html).toMatch(/② M 记忆系统/);
    expect(html).toMatch(/③④ K 知识系统 → 粒子库/);
  });

  it('抽屉拉取后端 /api/decision/:id/trace（四层链 + 根因归因条数据源）', () => {
    expect(html).toMatch(/\/api\/decision\/\$\{encodeURIComponent\(id\)\}\/trace/);
    expect(html).toMatch(/function\s+dnRootCause\(\)/);
  });

  it('抽屉渲染 E1–E7 边合规表（present/missing 语义）与粒子字段级三检', () => {
    expect(html).toMatch(/(E1–E7|E1-E7)/);
    expect(html).toMatch(/字段不一致/);
    expect(html).toMatch(/信息不完整/);
    expect(html).toMatch(/输入不及时/);
  });

  it('抽屉渲染 J3 根因归因条（code/layer/severity/evidence/处方旋钮）', () => {
    expect(html).toMatch(/root_cause\s*\|\|\s*\{\}/);
    expect(html).toMatch(/cause\.code/);
    expect(html).toMatch(/cause\.layer/);
    expect(html).toMatch(/cause\.knob/);
    expect(html).toMatch(/cause\.evidence/);
  });

  it('抽屉色值零硬编码（border/color 全走 tokens.css 变量）', () => {
    const seg = html.slice(html.indexOf('function _rootCauseHtml'), html.indexOf('function dnGraph'));
    expect(seg).toMatch(/var\(--(ok|err|warn|mut|line|panel)\)/);
    // 禁止在溯源抽屉段出现文字色/背景色 hex 硬编码（深色底白字 #fff 合法保留）
    expect(seg).not.toMatch(/color:\s*#[0-9a-fA-F]{3}\b/);
    expect(seg).not.toMatch(/background:\s*#[0-9a-fA-F]{3}\b/);
  });
});

describe('Task 13 · 巡检卡业务结果行 + 归因类别色（T12）', () => {
  it('巡检卡下钻并行拉取每个决策的业务结果（/api/decision/:id/outcome）', () => {
    expect(html).toMatch(/function\s+drillGateAttribution\(scenarioId\)/);
    expect(html).toMatch(/\/api\/decision\/\$\{encodeURIComponent\(d\.decision_id\)\}\/outcome/);
    expect(html).toMatch(/Promise\.all\(withAttr\.map/);
  });

  it('snapHtml 渲染业务结果行（outcome_type/source/verified_at）+ 无结果占位', () => {
    expect(html).toMatch(/function\s+snapHtml\(d,\s*outcomes\s*=\s*\[\]\)/);
    expect(html).toMatch(/结果 \$\{_esc\(o\.outcome_type\)\}/);
    expect(html).toMatch(/无业务结果/);
  });

  it('巡检卡提供「补录业务结果」入口（回填 L2 表单 + 滚动定位）', () => {
    expect(html).toMatch(/function\s+manualOutcomeWriteFor\(decisionId\)/);
    expect(html).toMatch(/<crm-button[^>]*>\s*补录\s*<\/crm-button>/);
    expect(html).toMatch(/l2-feedback/);
  });

  it('归因类别色零裸 hex：四类 .cat 全走 tokens.css 语义分类 token', () => {
    // tokens.css 必须定义 --cat-* 分类 token（缺一个即红）
    for (const k of ['--cat-missing', '--cat-error', '--cat-bias', '--cat-context']) {
      expect(tokensCss, `tokens.css 应定义 ${k}`).toMatch(new RegExp(k));
    }
    // 页面四类 .cat 禁止再出现裸 hex background
    const catSeg = html.slice(html.indexOf('.cat.input_missing'), html.indexOf('/* 待办/决策任务列表 */'));
    expect(catSeg).not.toMatch(/background:\s*#[0-9a-fA-F]{6}/);
    expect(catSeg).toMatch(/var\(--cat-/);
    // 深层语义：input_error 用错误色（--err）语义等同校验——分类 token 应含 4 个
    expect(tokensCss.match(/--cat-[a-z]+:/g) || []).toHaveLength(4);
  });
});

describe('Task 13 · SSE calibration 域自动建议浮卡（T13）', () => {
  it('前端订阅 SSE calibration 域 retro-suggestions 并消费 msg.summary', () => {
    expect(html).toMatch(/es\.addEventListener\('calibration'/);
    expect(html).toMatch(/msg\?\.type\s*===\s*'retro-suggestions'/);
    expect(html).toMatch(/renderRetroFab\(msg\.summary\s*\|\|\s*\{\}\)/);
  });

  it('renderRetroFab 骨架齐全（渲染簇/处方/守卫/理由 + 折叠/加载态）', () => {
    expect(html).toMatch(/function\s+renderRetroFab\(data\)/);
    expect(html).toMatch(/draft_patches|draftPatches/);
    expect(html).toMatch(/retro-fab/);
    expect(html).toMatch(/retro-fab-collapse/);
  });

  it('autoSuggest 默认出口 emit calibration 域 retro-suggestions（与前端监听契约同源）', () => {
    expect(autoSuggestSrc).toMatch(/emit\('calibration',\s*'retro-suggestions'/);
    expect(autoSuggestSrc).toMatch(/source:\s*'autoSuggest'/);
    expect(autoSuggestSrc).toMatch(/draft_patches:\s*s\.patches\.map/);
    expect(autoSuggestSrc).toMatch(/guards:\s*s\.guards/);
  });

  it('autoSuggest 守卫优先：无样本不产出处方（R6 样本不足）', () => {
    expect(autoSuggestSrc).toMatch(/patches\.length\s*\)\s*emitSuggestions/);
    expect(autoSuggestSrc).toMatch(/样本不足|sample/i);
  });

  it('浮卡订阅异常隔离（订阅者失败不阻断决策写路径）', () => {
    const sseSeg = html.slice(html.indexOf('es.addEventListener'), html.indexOf('</script>', html.indexOf('es.addEventListener')));
    expect(sseSeg).toMatch(/try\s*\{|catch/);
  });
});