// src/http/workbenchRouter.js — 待办工作台端点（G3：四视角 /todo 成品页数据面；2026-08-28 合并为「我的待办」五视角+参数调优）
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G3-T2 + 08 门户 §5
//           + docs/2026-08-28-my-todo-merge-plan.md（actor 角色匹配修复 + follow 视角合并 S05）
//           + docs/2026-09-05-param-closedloop-adaptive-design.md §2.4（tuning「参数调优」视角）
// 契约：
//   GET /api/workbench | /api/my-todo ?view=approval|processing|initiated|cc|follow|tuning → { view, alias, schema, data }
//   六视角（服务端按当前人过滤，schema 声明受控筛选形）：
//     · approval   ：CRM_APPROVAL_TASK.payload.status='todo'(兼容TODO/todo) AND approver 匹配当前人/角色
//     · processing ：kanban tasks.status='running' AND payload.actor(用户名) 匹配当前人
//     · initiated  ：CRM_APPROVAL_INSTANCE.payload.submitter=当前人
//     · cc         ：CRM_APPROVAL_INSTANCE.payload.cc 包含当前人
//     · follow     ：业务粒子（商机 lead/opportunity + 审批单 submitted + 回款 pending/submitted）待跟进
//     · tuning     ：参数调优（P1 2026-09-05）：calibration_patch.status='PENDING' 且 assignee 匹配
//                    ADMIN/SYSADMIN/TAN_ADMIN（tan_admin 限本租户）—— 夜间参数体检处方待办
//   复用 renderPage（唯一渲染出口，渲染器不改）；测试注入式（对齐 configRouter 范式）
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { queryParticles } from '../particles/particleRepo.js'; // 审批任务/实例/业务粒子查询
import { listTasks } from '../kanban/kanban.js';
import { renderPage } from '../page/renderer.js';
import { resolveMe } from './auth.js';
import { scopeTenant, scopeOf } from './tenantScope.js';
import { schema as WORKBENCH_SCHEMA } from '../pages/S33-workbench.schema.js';
import { advanceTask } from '../approval/engine.js';
import { query } from '../db.js';

// 六视角别名（VIEW_ALIASES 供成品页切换 tab 文案；映射到 schema 组件 view）
export const VIEW_ALIASES = {
  approval: '待我审批',
  processing: '我处理的',
  initiated: '我发起的',
  cc: '抄送我的',
  follow: '待跟进',
  tuning: '参数调优',
};
export const VIEWS = Object.keys(VIEW_ALIASES);

// 默认依赖（真实）：读粒子（审批任务/实例/业务跟进）+ 看板任务 + 渲染
// currentActor：优先 Bearer token 的 {username, roles}；无 token → 回退 system
const defaultDeps = {
  currentActor: async (req) => {
    try {
      const me = resolveMe(req);
      if (me.ok) return { username: me.username, roles: [me.role], tenantId: me.tenantId };
    } catch { /* 未登录/坏 token → system */ }
    return { username: 'system', roles: ['system'], tenantId: 'system' };
  },
  queryApprovalTasks: async (actor) => queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: scopeTenant(actor) }),
  queryApprovalInstances: async (actor) => queryParticles({ type: 'CRM_APPROVAL_INSTANCE', tenantId: scopeTenant(actor) }),
  queryKanbanTasks: async (actor) => listTasks({ tenantId: scopeTenant(actor) }),
  // 参数调优数据源（P1 2026-09-05）：calibration_patch PENDING 处方（assignee 匹配 + tan_admin 限租户）
  // 复用校准 store 直查（对齐 calibrationRouter.listPatches 语义；admin/sysadmin 通配，tan_admin 限本租户）
  queryPatches: async (actor) => {
    const role = (actor?.roles || [])[0] || '';
    const isAdminLike = role === 'ADMIN' || role === 'SYSADMIN' || role === 'admin' || role === 'sysadmin';
    const tenantFilter = role === 'TAN_ADMIN' || role === 'tan_admin' ? scopeOf(actor) : null;
    const r = await query(
      `SELECT * FROM crm.calibration_patch
        WHERE status='PENDING'
          AND ($1::text IS NULL OR tenant_id=$1)
        ORDER BY created_at DESC LIMIT 50`,
      [tenantFilter]
    ).catch(() => ({ rows: [] })); // fail-open：巡检处方查询失败 → 空列表（不阻断视角）
    return r.rows;
  },
  // 签批依赖（P1）：复用既有 approvePatch/rejectPatch（第0闸 + 事务原子，零新增写通道）
  approvePatch: async (patch_id, opts = {}) => (await import('../calibration/store.js')).approvePatch(patch_id, opts),
  rejectPatch: async (patch_id, opts = {}) => (await import('../calibration/store.js')).rejectPatch(patch_id, opts),
  // 待跟进数据源：聚合 S05 业务粒子（商机/报价/合同/发票/订单/回款计划/回款记录）
  queryFollowSource: async (actor) => {
    const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'];
    const out = [];
    for (const t of types) {
      const rows = await queryParticles({ type: t, tenantId: scopeTenant(actor), limit: 200 }).catch(() => []);
      out.push(...rows);
    }
    return out;
  },
  render: (schema, data) => renderPage(schema, data),
};

// approver 匹配：approver 形如 'role:xxx'（按角色集）或裸人名（按 username）；actor 为 {username, roles}
function matchApprover(approver, actor) {
  if (!approver) return false;
  if (approver.startsWith('role:')) {
    return (actor?.roles || []).includes(approver.slice('role:'.length));
  }
  return approver === actor?.username;
}

// 视角 → 行组装（服务端按当前人过滤；payload 承载字段）
async function buildViewRows(view, actor, deps) {
  const [approvalTasks, instances, kanbanTasks, followSource] = await Promise.all([
    deps.queryApprovalTasks(actor),
    deps.queryApprovalInstances(actor),
    deps.queryKanbanTasks(actor),
    deps.queryFollowSource(actor),
  ]);
  switch (view) {
    case 'approval': {
      // 待我审批：task.status='todo'（兼容 TODO/todo 大小写）+ approver 匹配当前人/角色
      const rows = approvalTasks
        .filter((t) => (t.payload?.status || 'todo').toString().toLowerCase() === 'todo'
          && matchApprover(t.payload?.approver, actor))
        .map((t) => ({
          id: t.id,
          title: t.payload?.title || t.payload?.instance_id || t.id,
          approver: t.payload?.approver,
          seq: t.payload?.seq ?? '',
          status: t.payload?.status,
          created_at: t.created_at || '',
        }));
      return rows;
    }
    case 'processing': {
      // 我处理的：kanban tasks status='running'（受控值域）+ payload.actor(用户名) 匹配当前人
      const rows = kanbanTasks
        .filter((t) => t.status === 'running' && (t.payload?.actor || '') === actor.username)
        .map((t) => ({
          id: t.id,
          title: t.title || t.id,
          actor: t.payload?.actor || '',
          chain_id: t.chain_id || '',
          status: t.status,
          created_at: t.created_at || '',
        }));
      return rows;
    }
    case 'initiated': {
      // 我发起的：instance.submitter=当前人（全状态）
      const rows = instances
        .filter((i) => i.payload?.submitter === actor.username)
        .map((i) => ({
          id: i.id,
          title: i.payload?.title || i.id,
          submitter: i.payload?.submitter,
          status: i.payload?.status,
          current_node_name: i.payload?.current_node_name || '',
          created_at: i.created_at || '',
        }));
      return rows;
    }
    case 'cc': {
      // 抄送我的：instance.payload.cc 包含当前人
      const rows = instances
        .filter((i) => Array.isArray(i.payload?.cc) && i.payload.cc.includes(actor.username))
        .map((i) => ({
          id: i.id,
          title: i.payload?.title || i.id,
          cc: (i.payload?.cc || []).join(', '),
          status: i.payload?.status,
          created_at: i.created_at || '',
        }));
      return rows;
    }
    case 'tuning': {
      // 参数调优（P1 2026-09-05 设计 §2.4）：calibration_patch.status='PENDING' 处方
      // 夜间参数体检/路由实验产出 → ADMIN/tan_admin 批准生效（有效闭合「每夜体检→待办→批准」主链路）
      // tuning 不消费审批/看板数据源，直接走校准表（deps.queryPatches）
      const patches = await deps.queryPatches(actor);
      return patches.map((p) => ({
        id: p.patch_id || p.id,
        title: `参数调优：${p.knob} ${p.target || ''}`.trim(),
        knob: p.knob || '',
        target: p.target || '',
        from_value: p.from_value ? JSON.stringify(p.from_value) : '',
        to_value: p.to_value ? JSON.stringify(p.to_value) : '',
        risk: p.risk || 'LOW',
        assignee: p.assignee || 'ADMIN',
        tenant_id: p.tenant_id || 'system',
        created_at: p.created_at || '',
      }));
    }
    case 'follow': {
      // 待跟进：业务粒子（商机 lead/opportunity + 审批单 submitted + 回款 pending/submitted）
      // 逻辑迁移自 routes.js /api/page/todo（S05 待办工作台）
      const APPROVAL_TYPES = { CRM_QUOTATION: '报价', CRM_CONTRACT: '合同', CRM_INVOICE: '发票', CRM_ORDER: '订单' };
      const todos = [];
      for (const p of followSource) {
        const t = p.type;
        if (APPROVAL_TYPES[t] && p.payload?.status === 'submitted') {
          todos.push({ deal: `${APPROVAL_TYPES[t]}单 ${p.payload?.name || p.slug || p.id}`, customer: p.payload?.customer || p.payload?.account_name || '—', stage: '待审批', due: '待审批', action: '审批' });
        } else if (t === 'CRM_DEAL') {
          const st = p.payload?.stage || 'lead';
          if (st === 'lead' || st === 'opportunity') todos.push({ deal: p.payload?.name || p.slug || '商机', customer: p.payload?.customer || p.payload?.account_name || '—', stage: st, due: '跟进', action: '跟进' });
        } else if (t === 'CRM_PAYMENT_PLAN' || t === 'CRM_PAYMENT_RECORD') {
          if (p.payload?.status === 'submitted' || p.payload?.status === 'pending') todos.push({ deal: `${t === 'CRM_PAYMENT_PLAN' ? '回款计划' : '回款记录'} ${p.payload?.name || p.slug || p.id}`, customer: p.payload?.customer || '—', stage: p.payload?.status, due: '应收', action: '核对' });
        }
      }
      return todos;
    }
    default:
      return [];
  }
}

export function createWorkbenchRouter({ deps = {} } = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    get: async (req, res) => {
      try {
        const view = req.query.view || 'approval';
        if (!VIEWS.includes(view)) {
          return res.status(400).json({ error: `view 非法: ${view}（合法: ${VIEWS.join('|')}）` });
        }
        const actor = await D.currentActor(req);
        const rows = await buildViewRows(view, actor, D);
        // 夜批日报报告卡（仅 tuning 视角）：读 nightly_report 最新一行，作为顶部摘要+查看入口
        let reportCard = null;
        if (view === 'tuning') {
          const rc = await query(
            `SELECT run_date::text AS run_date, title, file_path, total_tasks, healthy, drift, patches_count
             FROM crm.nightly_report ORDER BY run_date DESC LIMIT 1`
          ).catch(() => ({ rows: [] }));
          reportCard = rc.rows[0] || null;
        }
        // G23 修复：受控渲染只渲染「当前视角」单组件，而非整张 5 视角 schema。
        // 旧实现把 5 个 table 组件全交给 renderPage，却只注入一份共享 rows →
        // ① view 参数被无视（5 个视角恒同屏，tab 切换形同虚设）；② 5 表渲染同一份数据（多为空）。
        // 现按 view 抽出对应组件，data.components.table 注入该视角专属行，tab 切换即时生效。
        const selected = WORKBENCH_SCHEMA.components.find((c) => c.view === view) || WORKBENCH_SCHEMA.components[0];
        const singleSchema = { ...WORKBENCH_SCHEMA, components: [selected] };
        const data = { components: { table: { rows } }, reportCard };
        const rendered = D.render(singleSchema, data);
        res.json({ view, alias: VIEW_ALIASES[view], schema: singleSchema, data, html: rendered.html, warnings: rendered.warnings });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/workbench', handlers.get);
  router.get('/api/my-todo', handlers.get);

  // 轻量角标端点（侧栏数字提醒；对齐 /api/board/named-account-manage 的 followReminders 模式）
  // 返回各视角待处理计数（仅 number[]，不含行明细；轮询 60s 消耗极低）
  router.get('/api/my-todo/badge', async (req, res) => {
    try {
      const actor = await D.currentActor(req);
      const rows = await Promise.all(
        VIEWS.map((v) => buildViewRows(v, actor, D))
      );
      const counts = {};
      VIEWS.forEach((v, i) => { counts[v] = rows[i].length; });
      // approval 视角为主角标（"我的待办"菜单项显示的数字 = 待我审批数）
      counts.total = counts.approval || 0;
      res.json(counts);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 夜批日报查看（ADMIN 鉴权；仅读 nightly_report.file_path 对应 .md，不新增写通道）
  router.get('/api/nightly-report/:date', async (req, res) => {
    try {
      const actor = await D.currentActor(req);
      const role = (actor?.roles || [])[0] || '';
      if (!(role === 'ADMIN' || role === 'SYSADMIN' || role === 'admin' || role === 'sysadmin')) {
        return res.status(403).json({ error: '仅 ADMIN 可见夜批日报' });
      }
      const r = await query(`SELECT file_path FROM crm.nightly_report WHERE run_date=$1`, [req.params.date])
        .catch(() => ({ rows: [] }));
      const fp = r.rows[0]?.file_path;
      if (!fp) return res.status(404).json({ error: '报告不存在' });
      const md = readFileSync(fp, 'utf8');
      res.type('text/markdown; charset=utf-8').send(md);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 审批任务签批端点（批准 / 拒绝）
  // 安全：先以当前 actor 查询待审批任务列表，确保 task 属于当前人/角色且在同一租户
  async function resolveApprovalTask(task_id, actor) {
    const tasks = await D.queryApprovalTasks(actor);
    const task = tasks.find((t) => t.id === task_id);
    if (!task) throw new Error('审批任务不存在或无权处理');
    // 越权闸：queryApprovalTasks 返回租户全量任务，必须二次校验 approver 归属当前人/角色
    if (!matchApprover(task.payload?.approver, actor)) throw new Error('无权处理该审批任务');
    return task;
  }

  const approvalHandlers = {
    approve: async (req, res) => {
      try {
        const actor = await D.currentActor(req);
        const { task_id, opinion = '' } = req.body || {};
        const task = await resolveApprovalTask(task_id, actor);
        const r = await advanceTask(task.payload.instance_id, task_id, {
          approver: actor.username, decision: 'approve', opinion, tenantId: scopeTenant(actor),
        });
        res.json({ ok: true, ...r });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    reject: async (req, res) => {
      try {
        const actor = await D.currentActor(req);
        const { task_id, opinion = '' } = req.body || {};
        const task = await resolveApprovalTask(task_id, actor);
        const r = await advanceTask(task.payload.instance_id, task_id, {
          approver: actor.username, decision: 'reject', opinion, tenantId: scopeTenant(actor),
        });
        res.json({ ok: true, ...r });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    // 参数调优签批（P1 2026-09-05 设计 §2.4）：复用既有 approvePatch/rejectPatch（第0闸+事务原子）
    // patch_id = calibration_patch.patch_id；resolved_by = 当前人（留痕）
    tuneApprove: async (req, res) => {
      try {
        const actor = await D.currentActor(req);
        const { patch_id, opinion = '' } = req.body || {};
        if (!patch_id) { res.status(400).json({ error: 'patch_id 必填' }); return; }
        const r = await D.approvePatch(patch_id, { resolved_by: actor.username || 'sysadmin' });
        res.json({ ok: true, ...r });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
    tuneReject: async (req, res) => {
      try {
        const actor = await D.currentActor(req);
        const { patch_id, opinion = '' } = req.body || {};
        if (!patch_id) { res.status(400).json({ error: 'patch_id 必填' }); return; }
        const r = await D.rejectPatch(patch_id, { resolved_by: actor.username || 'sysadmin' });
        res.json({ ok: true, ...r });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.post('/api/my-todo/approve', approvalHandlers.approve);
  router.post('/api/my-todo/reject', approvalHandlers.reject);
  // 参数调优签批（tune-*；零新增写通道，复用 approvePatch/rejectPatch）
  router.post('/api/my-todo/tune-approve', approvalHandlers.tuneApprove);
  router.post('/api/my-todo/tune-reject', approvalHandlers.tuneReject);
  // 旧 /workbench 入口兼容（已 301 重定向到 my-todo，但 API 仍保留双路径）
  router.post('/api/workbench/approve', approvalHandlers.approve);
  router.post('/api/workbench/reject', approvalHandlers.reject);

  router.handlers = { ...handlers, ...approvalHandlers }; // 注入式测试契约（对齐 configRouter）
  return router;
}

export { defaultDeps, buildViewRows, matchApprover };
