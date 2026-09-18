// src/http/channelRouter.js — 需求② §4.5/§4.6 后端：通道配置读写 + 接入向导三步（WorkBuddy/网页两入口共用）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §4.5（系统主导 Onboarding 向导）+ §8 裁决
// 红线（§4.5.1/§8）：
//   ① 凭据直进 credentialVault（明文不落响应/审计/会话）——persistSecret 加密落库；
//   ② 接入=四类动作 first-connect → 过 review-gate（HITL 人工闸）；
//   ③ verifyScope 真探测 fail-closed（不 mock 代真）；
//   ④ 禁删铁律：disconnect=enabled:false 软停用（不物理删除描述符）。
// 范式：handlers 直调式（与 configRouter.test.js 同范式），routes.js 里以 app.get/post 接线。
// 契约：
//   GET  /api/channels                  → 租户通道列表（来自 integration-providers，含 enabled/trust_level）
//   POST /api/channels/connect          → 接入向导③确认入库（凭据入 vault→verifyScope 探测→review-gate→描述符 upsert）
//       body.verify_only=true           → 向导②**只探测、零副作用**（不落凭据/不铸决策/不写描述符/不过人工闸）
//   POST /api/channels/:id/disconnect   → 软停用（enabled=false）
// 写闸（与 configRouter 同源，同一键 `integration-providers` 不得两套写语义）：
//   config-store 写前铸 `config-change` 决策（produceConfigDecision 单一实现）→ decisionId 落 writeConfig。
//   connect 另加 review-gate（§4.5.1 ③ first-connect HITL）；两者是不同闸，缺一不可。
// 通道 kind 判据单一事实源（channels/kinds.js）：
//   ⚠ 不得用 `kind.startsWith('generic-')` 判定——`generic-rest/mcp/cli` 同前缀但**不是通道**
//   （会把通用数据源错当通道展示/接入＝同名前缀两义）。configRouter 的 VALID_KINDS 与之 kind 域不相交。
import { isChannelKind } from '../channels/kinds.js';
// 接入形态单一事实源（channels/sourceKinds.js）：三形态的取值域、默认值、联合键判定只此一处
import { isSourceKind, sourceKindOf, verifiedKindsOf, credentialsOnPlatform, DEFAULT_SOURCE_KIND, SOURCE_KINDS, SOURCE_KIND_LABELS } from '../channels/sourceKinds.js';
// 多租户隔离（2026-09-18 实修）：此前本路由信任客户端传入的 tenant_id（缺省回退 'system'）
//   ⇒ 前端未带 tenant_id 时所有通道操作落到 platform 租户，ten_admin 误看/误改他租户数据（假绿）。
//   现与 configRouter（§15）同源：租户一律从会话 resolveMe 推导，客户端 tenant_id 参数被忽略。
import { resolveMe } from './auth.js';
import { scopeTenant, scopeOf } from './tenantScope.js';

export function createChannelRouter(
  { readConfig, writeConfig, reviewGate, verifyScope, persistSecret, produceDecision,
    // 租户解析（2026-09-18 实修）：默认从会话推导，忽略客户端 tenant_id 参数（防越权/误落 platform）
    resolveMe: resolveMeFn = resolveMe, scopeTenant: scopeTenantFn = scopeTenant, scopeOf: scopeOfFn = scopeOf,
  } = {}
) {
  // 凭据落密默认走 credentialVault.persistSecret（若不注入）
  const saveSecret = persistSecret || (async ({ tenantId, providerId, raw }) => {
    const m = await import('../connectors/discovery/credentialVault.js');
    return m.persistSecret({ tenantId, providerId, raw });
  });

  async function get(req, res) {
    // ⚠ 租户隔离（2026-09-18）：一律从会话推导，忽略客户端 tenant_id 参数
    const me = await resolveMeFn(req);
    if (!me?.ok) return res.status(401).json({ ok: false, error: '需要登录' });
    const tenantId = scopeTenantFn(me);
    try {
      const row = await readConfig('integration-providers', { tenantId });
      // 只呈现**通道**（isChannelKind）；通用数据源（generic-rest/mcp/cli）归 /api/integration/providers 面
      const list = (Array.isArray(row?.value) ? row.value : []).filter((d) => isChannelKind(d.kind));
      res.json({
        ok: true,
        channels: list.map((d) => ({
          id: d.id, kind: d.kind, label: d.label, enabled: d.enabled, trust_level: d.trust_level,
          objects: Array.isArray(d.objects) ? d.objects : [],
          // P2：形态 + 各形态的验证状态（三形态互不冒充，界面上必须逐个可见）
          source_kind: sourceKindOf(d),
          source_kind_label: SOURCE_KIND_LABELS[sourceKindOf(d)],
          verified_kinds: verifiedKindsOf(d),
          verifications: d.verifications && typeof d.verifications === 'object' ? d.verifications : {},
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  async function connect(req, res) {
    // ⚠ 租户隔离（2026-09-18）：一律从会话推导（scopeOf 写，永不通配），忽略客户端 tenant_id 参数
    const me = await resolveMeFn(req);
    if (!me?.ok) return res.status(401).json({ ok: false, error: '需要登录' });
    const tenantId = scopeOfFn(me);
    const { id, kind, credentials, trust_level = 'L1', objects = [], label } = req.body || {};
    if (!id || !isChannelKind(kind)) return res.status(400).json({ ok: false, error: 'kind_invalid' });
    // verify_only（向导步骤②）：**只探测、零副作用**——不落凭据、不铸决策、不写描述符、不过人工闸。
    //   为什么必须显式支持：否则「验证」步骤会真的落库/落密（验证即副作用），与设计 §4.5.1
    //   「②验证 → ③确认才入库」的两步语义相悖，且会让未确认的凭据提前进入保险库。
    const verifyOnly = req.body?.verify_only === true;
    // ── 接入形态（P2 §5.1）──
    // 新建默认 connector（连接器优先）；非法取值**直接拒**，不静默回落：
    //   静默回落会让「用户以为按 local-bridge 接入（凭据留本机）、系统实际按 direct 落了凭据」成立——
    //   这是合规意义上的假绿，比报错严重得多。
    const rawSourceKind = req.body?.source_kind;
    if (rawSourceKind !== undefined && rawSourceKind !== null && !isSourceKind(rawSourceKind)) {
      return res.status(400).json({ ok: false, error: 'source_kind_invalid', allowed: [...SOURCE_KINDS] });
    }
    const sourceKind = isSourceKind(rawSourceKind) ? rawSourceKind : DEFAULT_SOURCE_KIND;
    let probeName = null; // 验证器名（写进形态验证记录，便于日后回答「当时靠什么判定通过」）
    // 既有描述符：防双写检查与合并写都需要（提前读一次，与后面 upsert 共用）
    const cfgRow = await readConfig('integration-providers', { tenantId }).catch(() => null);
    const list = Array.isArray(cfgRow?.value) ? cfgRow.value : [];
    const idx = list.findIndex((d) => d.id === id);
    const existing = idx >= 0 ? list[idx] : null;
    // 同一通道只允许一个**已验证**形态生效（§5.4 判据 5）：两形态同时 verified ⇒ 同一批数据可能
    //   被两条通路各写一次（双写），且排障时无法判断哪条在生效。
    //   仅对**落库路径**检查：向导步骤②（verify_only）应只回答「连通与否」，不做配置裁定。
    const alreadyVerified = verifiedKindsOf(existing);
    if (!verifyOnly && alreadyVerified.length && !alreadyVerified.includes(sourceKind)) {
      return res.status(409).json({
        ok: false, error: 'channel_already_verified', verified_kinds: alreadyVerified,
        hint: `该通道已由「${SOURCE_KIND_LABELS[alreadyVerified[0]] || alreadyVerified[0]}」验证通过；`
          + '同一通道只允许一个形态生效（防双写）。如需换形态，请先断开该通道。',
      });
    }
    // ① 凭据直进 vault（明文不落响应/审计；verify_only 不落）。
    //   P0-1（2026-09-18）：仅**平台直连(direct)**形态才落 vault——该形态凭据归平台持有（pgcrypto 加密）。
    //   用户侧形态（connector / local-bridge）凭据只在本机/对方平台，平台侧**绝不落库**（红线：不保存密码）。
    if (!verifyOnly && credentials && typeof credentials === 'object' && Object.keys(credentials).length) {
      if (credentialsOnPlatform(sourceKind)) {
        try {
          await saveSecret({ tenantId, providerId: id, raw: credentials, sourceKind });
        } catch (e) {
          return res.status(500).json({ ok: false, error: `credential_store_failed: ${e?.code || e?.message || e}` });
        }
      }
      // 用户侧形态：凭据不进我方 vault（落库由本机桥/对方连接器负责），仅记 pending 待用户侧确认（见 ②）
    }
    // ② 按**形态**分路验证（P2 §5.2：各自 fail-closed，互不冒充）
    //   为什么必须分路：connector / local-bridge 的凭据**不在我方平台**，平台侧没有可用的探针。
    //   若对它们照跑 direct 的探针，只有两种结局——恒失败（用户永远接不进来）或假装成功（假绿）。
    //   故这两形态由**用户侧**确认：平台如实记 `pending`（未验证），绝不写 ok:true。
    const needsPlatformProbe = sourceKind === 'direct';
    if (!needsPlatformProbe) {
      const method = sourceKind === 'connector' ? 'user_side_connector' : 'user_side_local';
      if (verifyOnly) {
        return res.json({
          ok: true, verified: false, pending: true, stored: false, source_kind: sourceKind, method,
          hint: sourceKind === 'connector'
            ? '该形态由你在连接器应用内确认：请在对话中让我读取一次日程或邮件，成功即完成确认（平台侧不持有凭据，无从代验）。'
            : '该形态的凭据只在你的本机：请在本机运行下方自检命令，通过后在对话中告诉我（平台侧无从代验）。',
        });
      }
      probeName = method;
    } else if (typeof verifyScope === 'function') {
      // ⚠ 必须把本次提交的凭据交给 verifyScope：verify_only（向导②）**不落库**，
      //   只查 vault 会永远 credentials_missing ⇒ 探针从不执行 ⇒ 「验证」结构性不可通过。
      const inlineCred = credentials && typeof credentials === 'object' && Object.keys(credentials).length ? credentials : null;
      const v = await verifyScope({ tenantId, id, kind, credentials: inlineCred }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!v?.ok) {
        return res.status(400).json({
          ok: false, error: v?.error || 'verify_failed', probe: v?.probe || null,
          missing: Array.isArray(v?.missing) && v.missing.length ? v.missing : null, // 告诉用户**缺哪个字段**
          // hint 优先取探针实报（如 163 服务端原话「需用客户端授权码」）：
          //   一律用 credentials_missing 的话术会让「授权机制不符」被读成「凭据没填」（假失败）。
          hint: v?.hint || (v?.error === 'credentials_missing' ? '该通道需补齐凭据（credentials_missing）' : null),
        });
      }
      probeName = v?.probe || null;
      if (verifyOnly) {
        return res.json({
          ok: true, verified: true, stored: false, probe: v?.probe || null,
          detail: v?.detail ?? null, // 探针实证（如日历 displayname 数 / 会议条数），证明真的取到了数据
          hint: '仅验证，未落库（确认后才入库）',
        });
      }
    } else if (verifyOnly) {
      // 未注入 verifyScope 时**不得**谎称已验证（fail-closed：如实报未验证）
      return res.status(400).json({ ok: false, error: 'verify_not_wired', hint: '未装配探测，不能宣称已验证' });
    }
    // ③ 接入=四类动作 first-connect → 过 review-gate（HITL 人工闸）
    if (reviewGate && typeof reviewGate.hasApproval === 'function') {
      const a = await reviewGate.hasApproval({ action: 'first-connect', tenantId, ctx: { id, kind } }).catch(() => null);
      if (!a) return res.status(403).json({ ok: false, error: 'approval_required' });
    }
    // 描述符 upsert（禁删铁律：改 enabled/trust_level 不动删除）
    // ⚠ 必须**合并**而非整体替换：整体替换会静默抹掉既有 verifications / objects 等字段
    //   （P2 的形态验证记录就存在描述符里 —— 替换式写法会让「另一形态已验证」的记录凭空消失，
    //    防双写判据随即失效，且全程没有任何报错）。
    const desc = {
      ...(existing || {}),
      id, kind,
      label: label || existing?.label || kind,
      enabled: true,
      trust_level,
      // 本次未声明 objects 时保留既有（原实现覆盖成 []＝静默丢掉对象清单）
      objects: Array.isArray(objects) && objects.length
        ? objects
        : (Array.isArray(existing?.objects) ? existing.objects : []),
      source_kind: sourceKind,
      // 形态验证记录：联合键 = (channel_id 由描述符承载, source_kind 即对象键) → 三形态互不覆盖
      verifications: {
        ...((existing?.verifications && typeof existing.verifications === 'object') ? existing.verifications : {}),
        [sourceKind]: needsPlatformProbe
          ? { ok: true, verified_at: new Date().toISOString(), probe: probeName }
          // 用户侧形态（connector / local-bridge）：**如实记 pending（ok:false）**。
          //   若图省事写 ok:true，会出现三处连锁错误：verifiedKindsOf 把它当作「已生效形态」→
          //   防双写判据失效；界面显示成「已验证」→ 与事实相反；「已接入」变成无需任何人确认的自我声明。
          : { ok: false, pending: true, method: probeName, recorded_at: new Date().toISOString() },
      },
    };
    if (idx >= 0) list[idx] = desc; else list.push(desc);
    // 配置写第 0 闸（与 configRouter 同源）：铸 config-change 决策，decisionId 落库（写无决策不留白）
    const decision = typeof produceDecision === 'function'
      ? await produceDecision('config-change', { key: 'integration-providers', action: 'connect', id, kind }).catch(() => null)
      : null;
    await writeConfig('integration-providers', list, {
      tenantId, decisionId: decision?.decisionId || null, updatedBy: req?.user?.id || 'system',
    });
    res.json({
      ok: true, stored: true,
      channel: {
        id, kind, enabled: true, trust_level, source_kind: sourceKind,
        source_kind_label: SOURCE_KIND_LABELS[sourceKind],
        credentials_on_platform: credentialsOnPlatform(sourceKind),
      },
      decision: decision?.decisionId || null,
      // 形态不同，成功语义也不同：direct 是「平台已实测连通」，connector/local-bridge 是
      //   「配置已受理，待你在自己那侧确认」——两者若返回同一句话，用户会把后者读成前者。
      verified: needsPlatformProbe,
      pending_user_side: !needsPlatformProbe,
      hint: needsPlatformProbe
        ? '首次只读（L1），信任提升过独立闸门'
        : (sourceKind === 'connector'
          ? '已受理（未验证）：请在对话中让我读取一次日程或邮件完成确认；此形态平台不持有你的凭据。'
          : '已受理（未验证）：请在本机运行自检命令确认连通；此形态凭据只留在你的机器上。'),
    });
  }

  async function disconnect(req, res) {
    // ⚠ 租户隔离（2026-09-18）：一律从会话推导（scopeOf 写，永不通配），忽略客户端 tenant_id 参数
    const me = await resolveMeFn(req);
    if (!me?.ok) return res.status(401).json({ ok: false, error: '需要登录' });
    const tenantId = scopeOfFn(me);
    try {
      const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
      const list = Array.isArray(row?.value) ? row.value : [];
      const d = list.find((x) => x.id === req.params.id);
      if (!d) return res.status(404).json({ ok: false, error: 'channel_not_found' });
      d.enabled = false;
      // 配置写第 0 闸（与 configRouter 同源）
      const decision = typeof produceDecision === 'function'
        ? await produceDecision('config-change', { key: 'integration-providers', action: 'disconnect', id: d.id }).catch(() => null)
        : null;
      await writeConfig('integration-providers', list, {
        tenantId, decisionId: decision?.decisionId || null, updatedBy: req?.user?.id || 'system',
      });
      res.json({ ok: true, channel: { id: d.id, enabled: false }, decision: decision?.decisionId || null });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  // P2.5 入口集成最后一公里：用户侧形态（connector / local-bridge）确认回写。
  //   connector 形态：用户侧 Agent 调一次只读工具成功 → 经此端点回写 {ok:true, tool}。
  //   local-bridge 形态：本机自检命令通过 + 用户确认 → 经此端点回写 {ok:true, probe}。
  // 语义铁律（§5.4 判据①）：未确认前 verifications[sk] 停在 pending（ok:false），界面显示「待确认」；
  //   此端点把它翻为 ok:true（绝不可在 connect 阶段直接写 ok:true 冒充已验证）。
  // 平台侧形态（direct）已实测连通，不经此路径；此端点只动用户侧形态的联合键，互不覆盖。
  async function confirmUserSide(req, res) {
    // ⚠ 租户隔离（2026-09-18）：一律从会话推导（scopeOf 写，永不通配），忽略客户端 tenant_id 参数
    const me = await resolveMeFn(req);
    if (!me?.ok) return res.status(401).json({ ok: false, error: '需要登录' });
    const tenantId = scopeOfFn(me);
    const { id } = req.params;
    const { sourceKind: rawSourceKind, tool, probe } = req.body || {};
    try {
      const row = await readConfig('integration-providers', { tenantId }).catch(() => null);
      const list = Array.isArray(row?.value) ? row.value : [];
      const idx = list.findIndex((x) => x.id === id);
      if (idx < 0) return res.status(404).json({ ok: false, error: 'channel_not_found' });
      const d = list[idx];
      // 形态：优先 body 指定，否则取描述符当前 source_kind（联合键互不覆盖）
      const sourceKind = isSourceKind(rawSourceKind) ? rawSourceKind : sourceKindOf(d);
      if (!sourceKind) return res.status(400).json({ ok: false, error: 'source_kind_unknown' });
      const existingRec = (d.verifications && typeof d.verifications === 'object' ? d.verifications[sourceKind] : null) || {};
      const verifiedAt = new Date().toISOString();
      const verifications = {
        // ⚠ 必须**合并**而非整体替换：整体替换会抹掉其它形态的验证记录（P2 防双写判据失效）
        ...(d.verifications && typeof d.verifications === 'object' ? d.verifications : {}),
        [sourceKind]: {
          // 保留既有探针元数据（method/recorded_at），pending→ok 不丢上下文
          ...existingRec,
          ok: true,
          pending: false,
          verified_at: verifiedAt,
          ...(tool ? { tool } : {}),
          ...(probe ? { probe } : {}),
        },
      };
      list[idx] = { ...d, verifications };
      // 配置写第 0 闸（与 configRouter/connect 同源）
      const decision = typeof produceDecision === 'function'
        ? await produceDecision('config-change', { key: 'integration-providers', action: 'confirm-user-side', id, sourceKind }).catch(() => null)
        : null;
      await writeConfig('integration-providers', list, {
        tenantId, decisionId: decision?.decisionId || null, updatedBy: req?.user?.id || 'system',
      });
      res.json({
        ok: true,
        channel: { id, source_kind: sourceKind, verified: true },
        verification: verifications[sourceKind],
        decision: decision?.decisionId || null,
        hint: '用户侧形态已确认（待确认→已验证）；平台侧回写通道仍受 P3 评审闸约束。',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  return { handlers: { get, connect, disconnect, confirmUserSide } };
}
