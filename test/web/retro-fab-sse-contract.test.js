// test/web/retro-fab-sse-contract.test.js — T30 作战室浮卡 SSE 消费契约守卫
// 背景（2026-08-30 修复）：bus.emit(domain,type,payload) 包装成 { domain, type, ts, summary }（src/events/bus.js:17-19），
// SSE 帧 event=domain / data={domain,type,ts,summary}（src/events/sse.js:24-25）。
// 修复前 sels-decision-monitor.html 判 msg?.event==='retro-suggestions' + 读 msg.payload —— 与 bus 包装形状不符，
// 浮卡对实时复盘跑批（autoSuggest.js:125 / decision/retro.js:235 双发射源 emit('calibration','retro-suggestions',{...})）永远不刷新。
// 本守卫锁定修复后契约：
//   ① SSE 监听判 msg?.type === 'retro-suggestions'（事件类型在 type 位，不在 event 位）
//   ② 消费 msg.summary（payload 在 summary 位，不在 payload 位）
//   ③ GET /api/calibration/retro/latest 返回 { report } 包装（calibrationRouter.js:107），前端读 j.report.clusters / j.report.draft_patches
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../src/web/sales-decision-monitor.html', import.meta.url), 'utf8');

describe('T30 浮卡 SSE 消费契约（bus 包装形状 {domain,type,ts,summary}）', () => {
  it('SSE 监听器判 msg.type（事件类型在 type 位，非 event 位）', () => {
    expect(html).toMatch(/msg\?\.type\s*===\s*'retro-suggestions'/);
  });

  it('SSE 消费 msg.summary（载荷在 summary 位，非 payload 位）', () => {
    expect(html).toMatch(/renderRetroFab\(msg\.summary\s*\|\|\s*\{\}\)/);
  });

  it('不再使用旧契约字段 msg.event / msg.payload', () => {
    const sseSeg = html.slice(html.indexOf("es.addEventListener('calibration'"), html.indexOf('</script>', html.indexOf("es.addEventListener('calibration'")));
    expect(sseSeg).not.toMatch(/msg\?\.event/);
    expect(sseSeg).not.toMatch(/msg\.payload/);
  });

  it('GET /api/calibration/retro/latest 消费 {report} 包装', () => {
    expect(html).toMatch(/rep\.clusters\?\.length/);
    expect(html).toMatch(/rep\.draft_patches\?\.length/);
    expect(html).toMatch(/renderRetroFab\(rep\)/);
  });
});