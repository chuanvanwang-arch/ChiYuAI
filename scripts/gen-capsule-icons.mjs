/**
 * 生成 Buddy 场景胶囊图标（SVG，64x64，>=48x48）
 * 输出：assets/capsules/<slug>.svg
 * 用法：node scripts/gen-capsule-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'capsules');

// 三档配色对应三个工作模式
const PALETTE = {
  sales: ['#2563eb', '#06b6d4'],
  manager: ['#0ea5e9', '#6366f1'],
  admin: ['#0d9488', '#22c55e'],
};

const ICONS = {
  'customer-360': ['sales', `<circle cx="32" cy="24" r="6"/><path d="M20 43a12 12 0 0 1 24 0"/><path d="M47 17a17 17 0 0 1 3.5 9"/><polyline points="45,12.5 49,17.5 44,20"/>`],
  'deal-progression': ['sales', `<path d="M14 45l11-8 9-4 13-13"/><polyline points="39,20 47,20 47,28"/><path d="M14 49h34"/>`],
  'quote-generation': ['sales', `<rect x="20" y="13" width="24" height="34" rx="4"/><path d="M26 24h12M26 32h12M26 40h6"/><path d="M37 47v-8h8"/>`],
  'daily-followup': ['sales', `<rect x="15" y="19" width="34" height="28" rx="5"/><path d="M15 28h34M24 14v9M40 14v9"/><path d="M25 36l5 5 9-10"/>`],
  'risk-alert': ['sales', `<path d="M32 15l18 31H14z"/><path d="M32 27v8"/><circle cx="32" cy="40" r="1.8" fill="#fff" stroke="none"/>`],
  'discovery': ['sales', `<circle cx="28" cy="28" r="11"/><path d="M36 36l11 11"/><path d="M44 12v8M40 16h8"/>`],
  'pipeline-board': ['manager', `<rect x="14" y="20" width="10" height="24" rx="2"/><rect x="27" y="20" width="10" height="24" rx="2"/><rect x="40" y="20" width="10" height="24" rx="2"/><path d="M14 31h10M27 26h10M40 34h10"/>`],
  'funnel-diagnosis': ['manager', `<path d="M14 18h36l-13 16v9l-10 6v-15z"/><path d="M21 26h22"/>`],
  'deal-retrospective': ['manager', `<circle cx="34" cy="34" r="13"/><path d="M34 26v8l6 4"/><path d="M17 24l-5-4 5-4"/><path d="M24 21l-5-4 5-4"/>`],
  'team-performance': ['manager', `<path d="M15 48h34"/><rect x="19" y="33" width="7" height="13" rx="2"/><rect x="30" y="25" width="7" height="21" rx="2"/><rect x="41" y="18" width="7" height="28" rx="2"/>`],
  'approval-decision': ['manager', `<rect x="20" y="13" width="24" height="34" rx="4"/><path d="M25 32l6 6 10-11"/>`],
  'industry-onboarding': ['admin', `<path d="M14 47V32l10-8v8l10-8v8l10-8v23z"/><path d="M25 47v-7h8v7"/>`],
  'access-control': ['admin', `<path d="M32 13l15 6v12c0 9-7 15-15 19-8-4-15-10-15-19V19z"/><circle cx="32" cy="30" r="3.5"/><path d="M32 33.5v6"/>`],
  'billing-plans': ['admin', `<rect x="14" y="19" width="36" height="26" rx="4"/><path d="M14 28h36"/><path d="M21 38h9M21 42h5"/><circle cx="42" cy="38" r="3.5"/>`],
  'skill-switch': ['admin', `<rect x="13" y="24" width="38" height="18" rx="9"/><circle cx="42" cy="33" r="5"/><path d="M21 28v10"/>`],
};

// 工作模式图标（同样 64x64 SVG）
const MODES = {
  'mode-sales': ['sales', `<path d="M14 22h24a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H26l-8 7v-7h-4a4 4 0 0 1-4-4V26a4 4 0 0 1 4-4z"/><path d="M22 31h8M22 37h5"/>`],
  'mode-manager': ['manager', `<path d="M13 45h38"/><path d="M15 41l10-9 8 5 14-15"/><circle cx="25" cy="32" r="2.6"/><circle cx="33" cy="37" r="2.6"/>`],
  'mode-admin': ['admin', `<circle cx="32" cy="32" r="6"/><path d="M32 14v7M32 43v7M14 32h7M43 32h7M19 19l5 5M40 40l5 5M45 19l-5 5M24 40l-5 5"/>`],
};

const svg = (slug, [mode, inner]) => {
  const [c1, c2] = PALETTE[mode];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${slug}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bg)"/>
  <g fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    ${inner}
  </g>
</svg>
`;
};

mkdirSync(outDir, { recursive: true });
let n = 0;
for (const [slug, def] of Object.entries(ICONS)) {
  writeFileSync(join(outDir, `${slug}.svg`), svg(slug, def), 'utf8');
  n += 1;
}

const modeDir = join(root, 'assets', 'modes');
mkdirSync(modeDir, { recursive: true });
let m = 0;
for (const [slug, def] of Object.entries(MODES)) {
  writeFileSync(join(modeDir, `${slug}.svg`), svg(slug, def), 'utf8');
  m += 1;
}
console.log(`generated ${n} capsule icons -> assets/capsules/ | ${m} mode icons -> assets/modes/`);
