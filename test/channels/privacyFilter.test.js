// test/channels/privacyFilter.test.js — P1 隐私排除清单（G7）单测
// 判据来源：docs/2026-09-18-unified-integration-design-v2.md §8.1 / §10（反假绿：过滤必须写在入口之前）
import { describe, it, expect } from 'vitest';
import {
  normalizePrivacyConfig, domainMatches, addressMatches, evaluateSignals, domainFromEmail,
  signalsFromChannelEvent, signalsFromSyncRow, createPrivacyFilter, PRIVACY_REASONS,
} from '../../src/channels/privacyFilter.js';

describe('P1 隐私排除清单：归一', () => {
  it('未配置（null/undefined）＝合法状态 config_ok=true；形状坏＝异常 config_ok=false', () => {
    // 区分这两种状态的意义：未配置若也报 config_ok=false，每个未配置的租户每轮同步都会落一条
    // 「配置异常」，真正的配置损坏会被淹没在噪音里（告警疲劳 = 另一种假绿）。
    for (const raw of [null, undefined]) {
      const r = normalizePrivacyConfig(raw);
      expect(r.config_ok).toBe(true);
      expect(r.exclude_domains).toEqual([]);
    }
    for (const raw of ['oops', 42, []]) {
      const r = normalizePrivacyConfig(raw);
      expect(r.config_ok).toBe(false);
      expect(r.exclude_domains).toEqual([]);
    }
    // 空对象 = 合法配置（用户只是没加规则）
    expect(normalizePrivacyConfig({}).config_ok).toBe(true);
  });

  it('接受 readConfig 行形态 {value:{...}} 与裸对象（两种形状同一结果，消费点不必各自解包）', () => {
    const bare = { exclude_domains: ['Corp.COM'] };
    const row = { value: { exclude_domains: ['Corp.COM'] } };
    expect(normalizePrivacyConfig(row).exclude_domains).toEqual(normalizePrivacyConfig(bare).exclude_domains);
  });

  it('域名归一：大小写、前导点、通配前缀三种写法等价；非法项被剔除并记账', () => {
    const r = normalizePrivacyConfig({ exclude_domains: ['Corp.COM', '.corp.com', '*.corp.com', '', 7, null] });
    expect(r.exclude_domains).toEqual(['corp.com']);
    expect(r.config_ok).toBe(false);          // 有非法项 ⇒ 留痕（不是静默吞掉）
    expect(r.invalid_items.length).toBe(3);   // '', 7, null
  });

  it('非数组的规则键 → 视为空表且留痕（不得因形状错而 throw）', () => {
    const r = normalizePrivacyConfig({ exclude_keywords: 'receipt' });
    expect(r.exclude_keywords).toEqual([]);
    expect(r.config_ok).toBe(false);
    expect(r.invalid_items[0]).toContain('exclude_keywords');
  });
});

describe('P1 匹配语义', () => {
  it('域名按后缀匹配含子域，但不做「字符串包含」（notcorp.com 不得命中 corp.com）', () => {
    expect(domainMatches('a.corp.com', 'corp.com')).toBe(true);
    expect(domainMatches('corp.com', 'corp.com')).toBe(true);
    expect(domainMatches('notcorp.com', 'corp.com')).toBe(false);   // 关键反例：假命中＝拦错人
    expect(domainMatches('corp.com.evil.net', 'corp.com')).toBe(false);
  });

  it('地址三种写法各有所指：local@ / 全地址 / local', () => {
    expect(addressMatches('ceo@any.com', 'ceo@')).toBe(true);
    expect(addressMatches('assistant@any.com', 'ceo@')).toBe(false);
    expect(addressMatches('a@corp.com', 'a@corp.com')).toBe(true);
    expect(addressMatches('a@other.com', 'a@corp.com')).toBe(false);
    expect(addressMatches('ceo@any.com', 'ceo')).toBe(true);
  });

  it('命中原因取**最具体**的规则（地址 > 域名 > 关键词），不随书写顺序漂移', () => {
    const rules = normalizePrivacyConfig({
      exclude_keywords: ['invoice'], exclude_domains: ['corp.com'], exclude_addresses: ['ceo@'],
    });
    const hit = evaluateSignals({ emails: ['ceo@corp.com'], domains: ['corp.com'], texts: ['invoice #1'] }, rules);
    expect(hit.reason).toBe(PRIVACY_REASONS.ADDRESS);
    const hit2 = evaluateSignals({ emails: ['x@corp.com'], domains: ['corp.com'], texts: ['invoice #1'] }, rules);
    expect(hit2.reason).toBe(PRIVACY_REASONS.DOMAIN);
    const hit3 = evaluateSignals({ emails: ['x@ok.com'], domains: ['ok.com'], texts: ['invoice #1'] }, rules);
    expect(hit3.reason).toBe(PRIVACY_REASONS.KEYWORD);
  });

  it('空规则不丢任何行（配置缺失不等于全丢——那会把「读不到配置」变成数据消失的假红）', () => {
    const empty = normalizePrivacyConfig(null);
    expect(evaluateSignals({ emails: ['a@b.com'], domains: ['b.com'], texts: ['hello'] }, empty).drop).toBe(false);
  });

  it('字段缺失不等于命中规则（不做「无信号即拦」的推断）', () => {
    const rules = normalizePrivacyConfig({ exclude_domains: ['corp.com'] });
    expect(evaluateSignals({}, rules).drop).toBe(false);
    expect(evaluateSignals({ emails: [], domains: [], texts: [] }, rules).drop).toBe(false);
  });
});

describe('P1 信号抽取（两条线各自的适配器）', () => {
  it('通道事件：取发件人 + 参与者邮箱、对方域名 + 参与者归属域名、主题与片段', () => {
    const s = signalsFromChannelEvent({
      actor: { email: 'A@Corp.com' },
      participants: [{ email: 'b@other.com', corp: 'other.com' }],
      domain: 'corp.com',
      content: { subject: 'Invoice', snippet: 'please pay' },
    });
    expect(s.emails).toEqual(['a@corp.com', 'b@other.com']);
    expect(s.domains).toEqual(['corp.com', 'other.com']);
    expect(s.texts).toEqual(['Invoice', 'please pay']);
  });

  it('同步行：按语义字段名抽取（不做「遍历所有字符串值」的宽泛扫描）', () => {
    const s = signalsFromSyncRow({ Email: 'X@Corp.com', Website: 'www.corp.com', Subject: 'Receipt', model: 'corp.com-like-string' });
    expect(s.emails).toEqual(['x@corp.com']);
    // 域名信号 = 显式域名字段 + **邮箱自身的域名**（同步行常常只有邮箱字段，
    //   不补这一步就会出现「配了排除该域名、通道线拦了、同步线照落」的半失效）
    expect(s.domains).toEqual(['www.corp.com', 'corp.com']);
    expect(s.texts).toEqual(['receipt']);
    // 型号等无关字段不得被当成域名（宽泛扫描会把它拦掉，且用户无法解释为什么）
    expect(JSON.stringify(s)).not.toContain('corp.com-like-string');
  });

  it('domainFromEmail：无 @ / @ 开头 → 空串（不产出垃圾域名规则）', () => {
    expect(domainFromEmail('a@b.com')).toBe('b.com');
    expect(domainFromEmail('nodomain')).toBe('');
    expect(domainFromEmail('@x.com')).toBe('');
    expect(domainFromEmail(null)).toBe('');
  });

  it('域名规则对**只有邮箱字段的同步行**同样生效（通道线与同步线同一语义）', () => {
    const rules = normalizePrivacyConfig({ exclude_domains: ['secret.com'] });
    expect(evaluateSignals(signalsFromSyncRow({ email: 'bob@secret.com' }), rules).drop).toBe(true);
    expect(evaluateSignals(signalsFromSyncRow({ email: 'bob@ok.com' }), rules).drop).toBe(false);
  });

  it('同步行支持描述符覆盖字段清单', () => {
    const s = signalsFromSyncRow({ contact_mail: 'a@b.com' }, { emailFields: ['contact_mail'] });
    expect(s.emails).toEqual(['a@b.com']);
  });
});

describe('P1 工厂：消费点唯一入口', () => {
  it('isEmpty 正确反映「无规则」（消费点据此零行为变化短路，避免无谓判定开销）', () => {
    expect(createPrivacyFilter(null).isEmpty).toBe(true);
    expect(createPrivacyFilter({ exclude_domains: ['x.com'] }).isEmpty).toBe(false);
  });
  it('config_ok 透传给消费点（用于留痕：配置形状坏必须记账，未配置不记账）', () => {
    expect(createPrivacyFilter(null).config_ok).toBe(true);          // 未配置：合法
    expect(createPrivacyFilter({}).config_ok).toBe(true);
    expect(createPrivacyFilter({ exclude_domains: 'oops' }).config_ok).toBe(false); // 形状坏：留痕
  });
});
