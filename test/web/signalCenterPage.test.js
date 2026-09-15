import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('src/web/signal-center.html', 'utf8');

describe('signal-center 页面契约', () => {
  it('页面存在且含「信号中心」标题', () => {
    expect(html).toContain('信号中心');
  });

  it('页面调用 /api/signals（与后端双向对应）', () => {
    expect(html).toMatch(/\/api\/signals/);
  });

  it('含筛选（状态/严重度）与确认/否决按钮语义', () => {
    expect(html).toMatch(/data-signal-status|data-severity/);
    expect(html).toContain('确认');
    expect(html).toContain('否决');
  });

  it('「采纳」置灰不造假绿（S3 提供）', () => {
    expect(html).toContain('S3');
    expect(html).toContain('不造假绿');
  });

  it('调用确认/否决端点 /api/signals/:id/ack|close', () => {
    expect(html).toContain('/api/signals/${signalId}/');
    expect(html).toContain("'ack'");
    expect(html).toContain("'close'");
  });
});
