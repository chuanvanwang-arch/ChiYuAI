#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-plugin-zips.py — 对两个插件 zip 做合规字段 + 内容正确性核验。

合规依据与 scripts/pack-crm-plugin.py 同源（validate_expert.py 硬规则）：
  1. 元数据必须位于 `.codebuddy-plugin/plugin.json`；禁止 .workbuddy-plugin/ 残留。
  2. agents/ skills/ avatars/ 必须在包根。
  3. tags 恰好 3 个；quickPrompts 恰好 3 个。
  4. displayDescription.zh 落在 40–50 字。
另加内容红线核验（防回归）：
  - 不得出现「无需登录」旧错误文案（与 src/mcp/config.js requireAuth=true 矛盾）。
  - 不得出现写死的 `StreamableHTTP @ http://localhost:3001/mcp`（端点须参数化）。
  - crm-risk 须含 stop_loss_triggered 止损规则。
  - platform-admin 须含 Step 4B / Step 4.5 / Step 4C（按租户播种主数据 + KNOWLEDGE 种子 + 启用本租户 discovery 数据源）。

用法（每次重新打包后必跑）：
    python scripts/verify-plugin-zips.py
退出码 0 = 全部通过；1 = 有失败项。
"""
import json
import os
import re
import zipfile

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(_SCRIPT_DIR)
FAIL = []


def ok(msg):
    print(f"  [OK]   {msg}")


def bad(msg):
    print(f"  [FAIL] {msg}")
    FAIL.append(msg)


def check_zip(path, expect_name, expect_version, skill_names, content_rules):
    print(f"\n{'=' * 60}\n{os.path.basename(path)}  ({os.path.getsize(path)} bytes)\n{'=' * 60}")
    if not os.path.exists(path):
        bad(f"{path} 不存在")
        return
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        inner = [n for n in names if not n.endswith("/")]

        # 1. 元数据位
        meta = ".codebuddy-plugin/plugin.json"
        if meta in inner:
            ok(f"元数据位于 {meta}")
        else:
            bad(f"元数据缺失：应为 {meta}")
            return
        if any(n.startswith(".workbuddy-plugin/") for n in inner):
            bad("存在 .workbuddy-plugin/ 旧目录（平台不识别）")
        else:
            ok("无 .workbuddy-plugin/ 残留")

        pj = json.loads(z.read(meta))

        # 2. 资源在包根
        for d in ("agents/", "skills/", "avatars/"):
            hit = [n for n in inner if n.startswith(d)]
            if hit:
                ok(f"{d} 在包根（{len(hit)} 项）")
            else:
                bad(f"{d} 缺失或不在包根")

        # 3. 基本字段
        if pj.get("name") == expect_name:
            ok(f"name = {expect_name}")
        else:
            bad(f"name 应为 {expect_name}，实际 {pj.get('name')}")
        if pj.get("version") == expect_version:
            ok(f"version = {expect_version}")
        else:
            bad(f"version 应为 {expect_version}，实际 {pj.get('version')}")

        tags, qp = pj.get("tags") or [], pj.get("quickPrompts") or []
        ok(f"tags = {len(tags)}") if len(tags) == 3 else bad(f"tags 应 3 个，实际 {len(tags)}")
        ok(f"quickPrompts = {len(qp)}") if len(qp) == 3 else bad(f"quickPrompts 应 3 个，实际 {len(qp)}")

        zh = (pj.get("displayDescription") or {}).get("zh", "")
        ok(f"displayDescription.zh = {len(zh)} 字") if 40 <= len(zh) <= 50 else bad(
            f"displayDescription.zh 应 40-50 字，实际 {len(zh)}")

        # 4. skills 清单落地
        for s in skill_names:
            want = f"skills/{s}/SKILL.md"
            ok(f"skill {s}") if want in inner else bad(f"清单技能缺失: {want}")
        n_skill = len([n for n in inner if n.endswith("SKILL.md")])
        ok(f"SKILL.md 总数 = {n_skill}")

        # 5. avatar 实际有内容
        av = [n for n in inner if n.startswith("avatars/")]
        for a in av:
            size = len(z.read(a))
            ok(f"{a} = {size} bytes") if size > 1000 else bad(f"{a} 仅 {size} bytes，疑似占位损坏图")

        # 6. 内容规则
        # 规则形态：(pattern, should_exist) 或 (pattern, should_exist, path_filter)
        #   第三元素（2026-09-11 新增，可选）把规则**锚定到指定包内路径**（子串匹配）。
        #   背景：原实现遇到第一个匹配的 .md/.json 就 break → 「想校验 SKILL.md 表」的规则
        #   实际可能被 agents/crm-native.md / plugin.json 抢先满足 ⇒ 目标文件丢了内容仍全绿（假绿）。
        for label, rule in content_rules.items():
            pattern, should_exist = rule[0], rule[1]
            path_filter = rule[2] if len(rule) > 2 else None
            found = False
            where = ""
            for n in inner:
                if not (n.endswith(".md") or n.endswith(".json")):
                    continue
                if path_filter and path_filter not in n:
                    continue
                try:
                    txt = z.read(n).decode("utf-8")
                except Exception:
                    continue
                if re.search(pattern, txt):
                    found = True
                    where = n
                    break
            if found == should_exist:
                ok(f"{label}" + (f"  ({where})" if found else "  (未出现，符合预期)"))
            else:
                bad(f"{label} —— 期望{'存在' if should_exist else '不存在'}，实际相反"
                    + (f"（锚定路径 {path_filter}）" if path_filter else ""))

    print(f"  文件总数: {len(inner)}")


# ---- crm-native ----
check_zip(
    os.path.join(REPO, "plugin", "crm-native-plugin.zip"),
    expect_name="crm-native",
    expect_version="1.10.0",
    skill_names=["crm-native", "crm-query", "crm-write", "crm-risk", "decision-retrospective",
                 "method-bant", "method-meddicc", "method-opportunity-matrix", "method-role-map",
                 "method-risk-tradeoff", "method-stop-loss", "method-fact-vs-script",
                 "method-presales", "method-behavior-standard", "method-funnel-classification",
                 "method-stage-progression",
                 # 2026-09-09 补纳包：4 个已注册但未进分发包的 method-* 技能
                 "method-followup-engine", "method-intake-routing", "method-quote-engine",
                 "method-review-gate"],
    content_rules={
        "无「无需登录即可被办公智能体调用」旧错误文案": (r"无需登录即可被办公智能体调用", False),
        "crm-risk 含 stop_loss_triggered 止损规则": (r"stop_loss_triggered", True),
        "端点已参数化（写明由连接器决定）": (r"端点地址由连接器配置决定", True),
        "无写死的 StreamableHTTP @ localhost 表述": (r"StreamableHTTP `@ http://localhost:3001/mcp`", False),
        "保留 crm_login 强制登录铁律": (r"crm_login", True),
        "含决策建议工具 crm-decision-advise（2026-09-08 新增）": (r"crm-decision-advise", True),
        "含决策建议三档（A 处置 / B 红线审批 / C 补信息）": (r"B 风险提示", True),
        "agent 含 4 个补纳包 method-* 路由（2026-09-09）": (r"method-intake-routing", True),
        "agent 含报价引擎路由 method-quote-engine": (r"method-quote-engine", True),
        # 2026-09-09 新增对外 MCP 工具：data-particle-update（事实变更通道，防「已上线但包里看不到」漂移）
        "skill 含 data-particle-update 事实变更路由": (r"data-particle-update", True),
        "skill 含字段级并入语义说明（禁删）": (r"字段级并入", True),
        # 2026-09-09：crm-approval-start 新增 approvers 透传（审批失效根治，防「参数上线但文档没有」漂移）
        "skill 含起单指定审批人 approvers 说明": (r"起单指定审批人", True),
        "skill 含 approvers 覆盖全部节点 fail-closed 说明": (r"覆盖该流程的全部审批节点", True),
        "agent 含 data-particle-update 事实变更路由": (r"更正/补录字段", True),
        # 2026-09-11 新增对外 MCP 工具：discovery-*（线索自主发现，防「已上线但包里看不到」漂移）
        #   第三条 = 路径锚定到 SKILL.md（否则会被 agents/crm-native.md / plugin.json 抢先满足而假绿）
        "skill 含 discovery-run 自主发现路由": (r"discovery-run", True, "skills/crm-native/SKILL.md"),
        "skill 含线索发现写闸说明（两阶段 + 第0闸）": (r"两阶段", True, "skills/crm-native/SKILL.md"),
        "agent 含线索发现能力映射": (r"discovery-run", True, "agents/crm-native.md"),
        # 2026-09-11 新增对外 MCP 工具：线索池动作族（公海退回 / 战败归档 / 离职批量回收 / 重开）
        #   背景（本轮实测）：`buildMcpTools()` 实测 63 工具面已含 crm-lead-return /
        #   crm-deal-archive-to-pool / crm-lead-reclaim-bulk / crm-deal-reopen，
        #   但包里写清单只有 crm-lead-pick / crm-lead-recycle（且二者实为 lifecycle=reserved、
        #   **不在** MCP 工具面）→ 双向漂移。规则同 discovery：路径锚定 SKILL.md 防假绿。
        "skill 含线索池动作族（退回/归档/离职回收/重开）": (r"crm-lead-return", True, "skills/crm-native/SKILL.md"),
        "skill 含公海/私海三档阶段语义（S0/S0P）": (r"S0P", True, "skills/crm-native/SKILL.md"),
        "agent 含线索池能力映射": (r"crm-lead-return", True, "agents/crm-native.md"),
        # 2026-09-11 方案 H（deferDecisionMint）：写闸说明从「客户端须携带 decision_id」订正为
        #   「决策凭证由服务端生成（网关或执行器），客户端无需/无法提供」——原表述正是导致
        #   外部智能体误以为需要自备 decision_id（实无获取路径）的根因。锚定 SKILL.md 防假绿。
        "skill 写闸说明已订正（决策凭证由服务端生成）": (r"客户端\*\*无需提供", True, "skills/crm-native/SKILL.md"),
        "agent 写闸说明已订正（决策凭证由服务端生成）": (r"客户端\*\*无需提供", True, "agents/crm-native.md"),
        # 2026-09-14/15 新增对外 MCP 工具：prospecting-*（主动拓客三段，防「已上线但包里看不到」漂移）
        #   语义：search/select 只读（fit_score 服务端计算，适配器不注入）；confirm 写（S0 公海 +
        #   source:prospecting + 第0闸 PROSPECTING_CONFIRM + DEAL--sourcedFrom-->KNOWLEDGE 弱边）。
        #   三条均锚定 SKILL.md（防 agents/plugin.json 抢先满足假绿）。
        "skill 含 prospecting-search 主动拓客路由": (r"prospecting-search", True, "skills/crm-native/SKILL.md"),
        "skill 含拓客写闸说明（两阶段 + PROSPECTING_CONFIRM 第0闸）": (r"PROSPECTING_CONFIRM", True, "skills/crm-native/SKILL.md"),
        "agent 含主动拓客能力映射": (r"prospecting-search", True, "agents/crm-native.md"),
        # 2026-09-15 OAuth 接入改造（防「服务器改了、包文案还写着必须先 crm_login」漂移）。
        #   三条均路径锚定，否则会被 plugin.json / 其它 md 抢先满足。
        "skill 首次接入含 OAuth 授权渠道（推荐）": (r"OAuth 授权", True, "skills/crm-native/SKILL.md"),
        "agent 首次接入含 OAuth 授权渠道（推荐）": (r"OAuth 授权", True, "agents/crm-native.md"),
        "skill 含 401 resource_metadata 触发语义": (r"resource_metadata", True, "skills/crm-native/SKILL.md"),
    },
)

# ---- platform-admin ----
check_zip(
    os.path.join(REPO, "plugin-platform-admin.zip"),
    expect_name="crm-platform-admin",
    expect_version="1.2.0",
    skill_names=["industry-onboarding", "user-rbac-admin", "system-bootstrap", "platform-ops-insight"],
    content_rules={
        "industry-onboarding 含 Step 4B 按租户播种主数据": (r"Step 4B", True),
        "industry-onboarding 含 Step 4.5 租户 KNOWLEDGE 种子": (r"Step 4\.5", True),
        "端点已参数化（写明由连接器决定）": (r"端点地址由连接器配置决定", True),
        "无写死的 StreamableHTTP @ localhost 表述": (r"StreamableHTTP `@ http://localhost:3001/mcp`", False),
        "保留 sysadmin 准入双闸": (r"sysadmin", True),
        "含首次接入引导（注册→激活→登录，2026-09-09 新增）": (r"首次接入引导", True),
        # 2026-09-11 新增：Step 4C 线索发现数据源（D1 三档按租户启用）
        # ⚠ 三条均**锚定**到 skills/industry-onboarding/SKILL.md —— 否则会被同包内
        #    README.md / agents/platform-admin.md 抢先满足（check_zip 遇首个匹配即 break ⇒ 假绿）
        "industry-onboarding 含 Step 4C 启用本租户数据源": (r"Step 4C", True, "skills/industry-onboarding/SKILL.md"),
        "industry-onboarding 含 discovery-rules 键": (r"discovery-rules", True, "skills/industry-onboarding/SKILL.md"),
        "industry-onboarding 标注付费源不得启用": (r"付费源", True, "skills/industry-onboarding/SKILL.md"),
    },
)

def check_connector():
    """2026-09-15 OAuth 改造回退守卫：连接器必须声明 oauth，且不得再写死 Authorization 头。

    依据：docs/2026-09-15-mcp-oauth-design.md §8 —— 只改服务器不改连接器包 = OAuth 永不触发。
    注意：连接器是**独立分发物**，不在 plugin zip 内，故此处直接读仓库 `connector/` 目录。
    """
    print(f"\n{'=' * 60}\nconnector/  (OAuth 声明守卫)\n{'=' * 60}")
    meta_path = os.path.join(REPO, "connector", "connector-meta.json")
    mcp_path = os.path.join(REPO, "connector", "mcp.json")
    for p in (meta_path, mcp_path):
        if not os.path.exists(p):
            bad(f"{p} 不存在")
            return
    meta = json.load(open(meta_path, encoding="utf-8"))
    if meta.get("auth_mode") == "oauth":
        ok(f"connector-meta.json auth_mode = oauth（version {meta.get('version')}）")
    else:
        bad(f"connector-meta.json auth_mode 应为 'oauth'，实际 {meta.get('auth_mode')!r}"
            "（为 'token' 时客户端永不发起 OAuth 授权）")
    mcp = json.load(open(mcp_path, encoding="utf-8"))
    srv = next(iter((mcp.get("mcpServers") or {}).values()), {})
    if not (srv.get("headers") or {}).get("Authorization"):
        ok("connector/mcp.json 未写死 Authorization 头")
    else:
        bad("connector/mcp.json 不得写死 Authorization 头：OAuth 模式下 Bearer 由客户端注入，"
            "写死会与注入头冲突")
    ts_path = os.path.join(REPO, "connector", "token-schema.json")
    if os.path.exists(ts_path):
        keys = [f.get("key") for f in json.load(open(ts_path, encoding="utf-8")).get("fields", [])]
        if "CRM_API_TOKEN" in keys:
            bad(f"token-schema.json 不应再含 CRM_API_TOKEN 字段（OAuth 模式全程无需手填 token），"
                f"实际字段 {keys}")
        else:
            ok(f"token-schema.json 字段 = {keys}")


check_connector()

print("\n" + "=" * 60)
if FAIL:
    print(f"❌ 校验未通过，{len(FAIL)} 项：")
    for f in FAIL:
        print("   -", f)
    raise SystemExit(1)
print("✅ 两个包全部校验通过")
