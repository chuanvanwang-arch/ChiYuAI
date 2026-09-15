// src/connectors/discovery/orchestrationCompiler.js
// C1: 可组合 GTM 编排层（吸收 Clay #1 最深护城河）。
// 把 discovery-rules.playbooks 编译为可执行的四段原语计划：
//   data(适配器) -> condition(判定条件) -> ai(AI 研究) -> action(触达动作)。
// 铁律：
//   ① 零核心代码改动：新增客群/编排只改 config（配置驱动差异化铁律）
//   ② 段缺失 ⇒ 该段不产出（可组合 = 任一段可选），不抛错
//   ③ 非法入参（无 name）⇒ 抛错（fail-fast，禁匿名编排静默进主干）
//   ④ 无 match 命中且无 default 项 ⇒ selectPlaybook 返回 null
//      （= 不过滤 ⇒ 全量启用源，保持 Task 7 既有语义，绝不静默收窄适配器集）
export function compilePlaybook(pb) {
  if (!pb || typeof pb !== 'object' || !pb.name) {
    throw new Error('compilePlaybook: playbook 必须是有 name 的对象');
  }
  const steps = [];
  if (pb.data?.length) steps.push({ stage: 'data', adapters: [...pb.data] });
  if (pb.match) steps.push({ stage: 'condition', match: pb.match });
  if (pb.ai?.length) steps.push({ stage: 'ai', research: [...pb.ai] });
  if (pb.action?.length) steps.push({ stage: 'action', skills: [...pb.action] });
  return { name: pb.name, steps };
}

// 按先验信号选择 playbook：显式 match（&& 全命中）> 显式 default > null
export function selectPlaybook(rules, signals = []) {
  const list = Array.isArray(rules?.playbooks) ? rules.playbooks : [];
  const types = new Set((signals || []).map((sg) => sg?.type).filter(Boolean));
  const matches = (m) => (m || '').split('&&').map((x) => x.trim()).filter(Boolean).every((t) => types.has(t));
  const hit = list.find((pb) => pb?.match && matches(pb.match));
  if (hit) return hit;
  return list.find((pb) => pb?.name === 'default') || null;
}
