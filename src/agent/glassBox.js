// src/agent/glassBox.js
// C2: glass-box 可解释推理链（吸收 Clay glass-box 范式，升为一等公民）。
// 每个评分/研究判定附 rule_ref（引用哪条 ruler/信号）+ j_score（能力轴置信），
// 与 P0#1 的 2D judge（axis=capability）同源；销售可见「为何此刻判定为目标客户」。
// 铁律：
//   ① 纯函数、零副作用、不触 DB、不新增粒子
//   ② 脏信号（null / 无 type）必须过滤 —— trace 项数 = 有效信号数（与 claygent 既有实现同构）
//   ③ 无信号不抛错：why_narrative 走「无信号」分支
//   ④ ruleRef / axis 均可覆盖（配置驱动，禁在签名外硬编码具体 ruler 名）
export function buildGlassBox({ score, ruleRef, signals = [], axis = 'capability' }) {
  const names = (Array.isArray(signals) ? signals : [])
    .map((sg) => (typeof sg === 'string' ? sg : sg && sg.type))
    .filter(Boolean);
  const trace = names.map((n) => ({ signal: n, rule_ref: ruleRef, j_score: score }));
  return {
    judge: { axis, rule_ref: ruleRef, j_score: score },
    trace,
    why_narrative: `因 ${names.join('、') || '无信号'} 命中 ${ruleRef} 判定为目标客户（j_score=${score}）`,
  };
}
