/**
 * 生成 Buddy 应用「日间 / 夜间背景图」——1000×910 PNG，零依赖（Node 内置 zlib 手写 PNG 编码）。
 *
 * 设计约束（按首页背景图的通用要求推断）：
 *  1. 中央区（标题 + 输入框所在，y≈240-660）保持低对比，不抢文字；
 *  2. 视觉元素集中在四角光晕与底部 1/4（上升柱状剪影 = 业务增长意象，与品牌 logo 同源）；
 *  3. 日间浅底深字、夜间深底浅字，两套同构。
 *
 * 用法: node scripts/gen-hero-backgrounds.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1000;
const H = 910;

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
const encodePng = (rgb, w, h) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/* ---------- 绘制原语 ---------- */
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

const newCanvas = () => new Float64Array(W * H * 3);

const fillVGrad = (buf, top, bottom) => {
  const [r0, g0, b0] = hex(top);
  const [r1, g1, b1] = hex(bottom);
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = r0 + (r1 - r0) * t;
    const g = g0 + (g1 - g0) * t;
    const b = b0 + (b1 - b0) * t;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
};

const blend = (buf, x, y, [r, g, b], a) => {
  if (a <= 0 || x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] = buf[i] * (1 - a) + r * a;
  buf[i + 1] = buf[i + 1] * (1 - a) + g * a;
  buf[i + 2] = buf[i + 2] * (1 - a) + b * a;
};

/** 径向光晕：中心最亮，边缘衰减到 0 */
const glow = (buf, cx, cy, radius, color, maxA, pow = 2) => {
  const c = hex(color);
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d >= 1) continue;
      blend(buf, x, y, c, maxA * Math.pow(1 - d, pow));
    }
  }
};

const rect = (buf, x0, y0, x1, y1, color, a) => {
  const c = hex(color);
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) blend(buf, x, y, c, a);
  }
};

/** 极淡网格，只画在非中央区 */
const grid = (buf, color, a, step = 64) => {
  const c = hex(color);
  for (let y = 0; y < H; y += step) {
    const inCenter = y > 230 && y < 670;
    for (let x = 0; x < W; x++) blend(buf, x, y, c, inCenter ? a * 0.35 : a);
  }
  for (let x = 0; x < W; x += step) {
    for (let y = 0; y < H; y++) blend(buf, x, y, c, y > 230 && y < 670 ? a * 0.35 : a);
  }
};

/** 可复现随机（LCG），保证每次生成一致 */
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const toBytes = (buf) => {
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(buf[i])));
  return out;
};

/* ---------- 日间 ---------- */
const day = newCanvas();
fillVGrad(day, '#F8FAFC', '#DCE9F7');
glow(day, 120, 110, 520, '#B5D4F4', 0.5, 2.2); // 左上主光
glow(day, 930, 60, 380, '#9EC5F0', 0.3, 2.4); // 右上辅光
glow(day, 880, 880, 460, '#042C53', 0.14, 2.0); // 右下压角
grid(day, '#94A3B8', 0.07);
// 底部上升柱状剪影（增长意象，与品牌 logo 同源）——避开中央文字区
const dayBars = [
  { x: 90, w: 74, h: 96 },
  { x: 200, w: 74, h: 142 },
  { x: 310, w: 74, h: 118 },
  { x: 420, w: 74, h: 196 },
  { x: 530, w: 74, h: 168 },
  { x: 640, w: 74, h: 244 },
  { x: 750, w: 74, h: 210 },
  { x: 860, w: 74, h: 286 },
];
dayBars.forEach((b, i) => rect(day, b.x, H - b.h, b.x + b.w, H, '#378ADD', 0.1 + i * 0.012));
rect(day, 0, H - 3, W, H, '#2E7BC6', 0.35); // 底部基线

/* ---------- 夜间 ---------- */
const night = newCanvas();
fillVGrad(night, '#062F58', '#031B33');
glow(night, 160, 130, 560, '#378ADD', 0.42, 2.2);
glow(night, 900, 90, 420, '#1D6FC4', 0.26, 2.4);
glow(night, 880, 890, 520, '#0A3D6E', 0.4, 1.9);
grid(night, '#5B8DB8', 0.06);
// 星点（避开中央）
const rnd = rng(20260908);
for (let n = 0; n < 220; n++) {
  const x = Math.floor(rnd() * W);
  const y = Math.floor(rnd() * H);
  if (y > 230 && y < 670) continue;
  const r = rnd() < 0.85 ? 1 : 2;
  const a = 0.12 + rnd() * 0.4;
  for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) blend(night, x + dx, y + dy, [226, 241, 251], a);
}
// 同构上升柱（低亮度，冷光）
const nightBars = dayBars.map((b) => ({ ...b }));
nightBars.forEach((b, i) => {
  rect(night, b.x, H - b.h, b.x + b.w, H, '#5EA6EE', 0.1 + i * 0.016);
  // 柱顶冷光描边
  rect(night, b.x, H - b.h, b.x + b.w, H - b.h + 2, '#9CCBF7', 0.3);
});
rect(night, 0, H - 3, W, H, '#3E8BD1', 0.4);

/* ---------- 输出 ---------- */
const outDir = join(root, 'buddy-app-store-listing');
mkdirSync(outDir, { recursive: true });
const files = [
  ['hero-day-1000x910.png', day],
  ['hero-night-1000x910.png', night],
];
for (const [name, buf] of files) {
  const png = encodePng(toBytes(buf), W, H);
  writeFileSync(join(outDir, name), png);
  const kb = (png.length / 1024).toFixed(1);
  console.log(`${name.padEnd(28)} ${W}×${H}  ${kb} KB  ${png.length < 1048576 ? 'OK (<1MB)' : '超限!'}`);
}
