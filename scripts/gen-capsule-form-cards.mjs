/**
 * 生成「场景胶囊填写卡片页」——按开放平台表单字段逐项展开，每个字段一键复制。
 *
 * 用法: node scripts/gen-capsule-form-cards.mjs
 * 输出: assets/capsules/form-cards.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(join(root, 'buddy-crm-manifest.json'), 'utf8'));

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const len = (s) => [...String(s)].length;

/** 一个可复制字段行 */
const field = (label, value, opts = {}) => {
  const { limit = 0, mono = false, multiline = false } = opts;
  const counter = limit ? `<span class="cnt">${len(value)}/${limit}</span>` : '';
  const cls = ['val', mono ? 'mono' : '', multiline ? 'multi' : ''].filter(Boolean).join(' ');
  return `
    <div class="f">
      <div class="fhead"><span class="flabel">${esc(label)}</span>${counter}</div>
      <div class="fbody">
        <div class="${cls}">${esc(value)}</div>
        <button class="copy" data-copy="${esc(value)}">复制</button>
      </div>
    </div>`;
};

const cards = m.home.workModes
  .map((w) => {
    const inner = w.capsules
      .map((c, i) => {
        const iconFile = basename(c.icon);
        const skillsHtml = c.skills.length
          ? c.skills.map((s) => `<code>${esc(s)}</code>`).join(' ')
          : '<span class="muted">（无）</span>';
        const promptsHtml = c.prompts
          .map(
            (p, pi) => `
        <div class="f">
          <div class="fhead"><span class="flabel">提示词模版 ${pi + 1}</span></div>
          <div class="fbody">
            <div class="val multi">${esc(p)}</div>
            <button class="copy" data-copy="${esc(p)}">复制</button>
          </div>
        </div>`
          )
          .join('');
        const inspHtml = c.inspirations.length
          ? c.inspirations.map((x) => `<code>${esc(x)}</code>`).join(' ')
          : '<span class="muted">（无）</span>';

        return `
      <section class="card" id="cap-${w.id}-${i + 1}">
        <header>
          <img class="ico" src="./${esc(iconFile)}" alt="${esc(c.name)}">
          <div>
            <h3>${esc(w.name)} · ${esc(c.name)}</h3>
            <p class="sub">${esc(c.en)}　|　图标文件：<code>${esc(iconFile)}</code></p>
          </div>
          <a class="dl" href="./${esc(iconFile)}" download="${esc(iconFile)}">下载 SVG</a>
        </header>
        <div class="grid">
          ${field('场景胶囊名称', c.name, { limit: 8 })}
          ${field('英文名称 *', c.en, { limit: 30 })}
          <div class="f">
            <div class="fhead"><span class="flabel">绑定专家</span></div>
            <div class="fbody"><div class="val">${esc(c.expert)}</div><button class="copy" data-copy="${esc(c.expert)}">复制</button></div>
          </div>
          <div class="f">
            <div class="fhead"><span class="flabel">绑定技能（未上架可留空）</span></div>
            <div class="fbody"><div class="val tags">${skillsHtml}</div></div>
          </div>
        </div>
        ${field('系统提示词', c.systemPrompt, { multiline: true })}
        <div class="sub-head">提示词模版（${c.prompts.length} 条，要求 2-10）</div>
        ${promptsHtml}
        <div class="f">
          <div class="fhead"><span class="flabel">关联灵感（最多 4 个，需在灵感库对照勾选）</span></div>
          <div class="fbody"><div class="val tags">${inspHtml}</div></div>
        </div>
      </section>`;
      })
      .join('');

    return `
    <h2 class="mode">${esc(w.name)} <span class="muted">（${w.capsules.length} 个胶囊${w.default ? ' · 默认模式' : ''}）</span></h2>
    ${inner}`;
  })
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>场景胶囊填写卡片 · ${esc(m.app.name || 'Buddy 应用')}</title>
<style>
  :root{
    --bg:#f7f8fa; --card:#fff; --line:#e5e7eb; --text:#1f2328; --muted:#6b7280;
    --accent:#2563eb; --accent-soft:#eff6ff; --ok:#059669;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:28px;background:var(--bg);color:var(--text);
    font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  h1{font-size:20px;margin:0 0 6px}
  .lead{color:var(--muted);margin:0 0 18px;font-size:13px}
  .notice{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px 14px;margin:0 0 22px;font-size:13px;color:#9a3412}
  .notice b{color:#7c2d12}
  h2.mode{font-size:16px;margin:26px 0 12px;padding-left:10px;border-left:3px solid var(--accent)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px}
  .card header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:14px}
  .ico{width:40px;height:40px;flex:0 0 40px}
  .card h3{margin:0;font-size:15px}
  .sub{margin:2px 0 0;color:var(--muted);font-size:12px}
  .dl{margin-left:auto;font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--accent);
    border-radius:6px;padding:4px 10px}
  .dl:hover{background:var(--accent-soft)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;margin-bottom:12px}
  .f{margin-bottom:10px}
  .fhead{display:flex;align-items:baseline;gap:8px;margin-bottom:4px}
  .flabel{font-size:12px;color:var(--muted)}
  .cnt{font-size:11px;color:var(--muted);background:#f3f4f6;border-radius:4px;padding:1px 6px}
  .fbody{display:flex;gap:8px;align-items:flex-start}
  .val{flex:1;background:#f9fafb;border:1px solid var(--line);border-radius:6px;padding:7px 10px;
    word-break:break-word;white-space:pre-wrap}
  .val.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .val.multi{max-height:190px;overflow:auto;font-size:13px}
  .val.tags{background:#f9fafb}
  code{background:#eef2ff;color:#3730a3;border-radius:4px;padding:1px 6px;font-size:12px;margin-right:4px;display:inline-block}
  .copy{flex:0 0 auto;border:1px solid var(--line);background:#fff;border-radius:6px;padding:5px 12px;
    font-size:12px;cursor:pointer;color:var(--text)}
  .copy:hover{border-color:var(--accent);color:var(--accent)}
  .copy.done{border-color:var(--ok);color:var(--ok);background:#ecfdf5}
  .sub-head{font-size:12px;color:var(--muted);margin:14px 0 8px;padding-top:10px;border-top:1px dashed var(--line)}
  .muted{color:var(--muted);font-weight:400}
  @media (max-width:820px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<h1>场景胶囊填写卡片</h1>
<p class="lead">
  应用 ID <code>${esc(m.app.appId)}</code>　|　共 ${m.home.workModes.length} 个工作模式 / ${m.home.workModes.reduce((n, w) => n + w.capsules.length, 0)} 个胶囊。
  字段顺序与开放平台表单一致，点「复制」后到页面粘贴即可。
</p>
<div class="notice">
  <b>技能未上架的处理：</b><code>connector/skills/</code> 的 16 个技能尚未在平台上架，「绑定技能」下拉可能选不到。
  已把每个技能承载的方法论内核<b>内联进「系统提示词」末尾的【方法论内核】段</b>——即使技能留空，胶囊能力也不降级。
  等技能上架后再补绑即可。
</div>
${cards}
<script>
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy');
    if (!btn) return;
    const text = btn.getAttribute('data-copy');
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
    } catch (_) { /* fall through */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      document.body.removeChild(ta);
    }
    const old = btn.textContent;
    btn.textContent = ok ? '已复制' : '请手动复制';
    btn.classList.toggle('done', ok);
    setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
  });
</script>
</body>
</html>
`;

writeFileSync(join(root, 'assets', 'capsules', 'form-cards.html'), html, 'utf8');
console.log('generated assets/capsules/form-cards.html');
