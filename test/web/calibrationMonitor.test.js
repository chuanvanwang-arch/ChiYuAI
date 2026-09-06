// test/web/calibrationMonitor.test.js — P2 校准监控页签守卫
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7（四段式 UI）
// 守卫目标（对盘上权威实现）：
//   ① 页面含校准页签（page-tab-calibration）+ 四段式渲染入口（loadCalib）
//   ② 单一事实源：归因只来自后端 /api/calibration/attribution（R1-R6 定义在 src/calibration/rules.js）
//      渲染子模块 /portal/calibrationRender.js 不得复制规则（不得含 R1/R5 阈值条件硬编码）
//   ③ 渲染子模块零服务端 import（浏览器 ESM 可加载）
//   ④ 页面 module script 消费渲染子模块 + api.js 封装
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const page = fileURLToPath(new URL('../../src/web/sales-decision-monitor.html', import.meta.url));
const render = fileURLToPath(new URL('../../src/portal/calibrationRender.js', import.meta.url));
const html = readFileSync(page, 'utf8');
const renderSrc = readFileSync(render, 'utf8');

test('页面含校准页签与加载入口', () => {
  expect(html).toContain('page-tab-calibration');
  expect(html).toContain('loadCalib();');
  expect(html).toContain('/api/calibration/attribution');
  expect(html).toContain('/api/calibration/patches');
});

test('页面 module script 消费渲染子模块与 api.js 封装', () => {
  expect(html).toMatch(/import\s*\{[^}]*renderCalibration[^}]*\}\s*from\s*['"]\/portal\/calibrationRender\.js['"]/);
  expect(html).toMatch(/import\s*\{[^}]*get,\s*post[^}]*\}\s*from\s*['"]\/portal\/api\.js['"]/);
});

test('四段式渲染函数齐全（指标卡/归因/处方/历史）', () => {
  expect(renderSrc).toContain('renderMetricCards');
  expect(renderSrc).toContain('renderAttribution');
  expect(renderSrc).toContain('renderPatchCard');
  expect(renderSrc).toContain('renderHistory');
  expect(renderSrc).toContain('renderCalibration');
});

test('单一事实源：渲染子模块不复制归因规则条件', () => {
  // 禁特征：R5 阈值 0.3 / R6 样本 20 / R1 覆写 0.25 硬编码进前端
  // 禁硬编码规则条件（R1 覆写率>0.25 / R5 先例<0.3 / R6 样本<20），防前端复制规则
  expect(renderSrc).not.toContain('> 0.25');
  expect(renderSrc).not.toContain('< 0.3');
  expect(renderSrc).not.toContain('sample_size < 20');
  expect(renderSrc).not.toMatch(/coverage_avg\s*[<>]/);
  expect(renderSrc).not.toMatch(/override_rate\s*[<>]/);
  // 应消费后端 attribution 形状（patches/guards/reason）而非自行求值
  expect(renderSrc).toMatch(/attribution/);
});

test('渲染子模块零服务端 import（浏览器 ESM 可加载）', () => {
  const forbidden = /import\s+[^;]*from\s+['"](express|\.\.\/db\.js|\.\.\/calibration\/[^'"]+|\.\.\/decision\/[^'"]+|\.\.\/monitor\/[^'"]+|\.\.\/http\/[^'"]+)['"]/;
  const bad = renderSrc.match(forbidden);
  expect(bad, `不得含服务端 import: ${bad?.[0] || ''}`).toBeNull();
  expect(renderSrc).not.toMatch(/import\s+[^;]*from\s+['"]\.\.\//);
});

test('端点为只读归因（GET attribution 而非前端 self-attribute）', () => {
  // 页面不自行请求 metrics 再求值；端点名 attribution 表示服务端已归因
  expect(html).not.toMatch(/\/api\/calibration\/metrics\?/);
  expect(html).toContain('/api/calibration/attribution');
});