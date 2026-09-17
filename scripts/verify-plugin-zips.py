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


# ---- sales-decision-platform（原 crm-native）----
check_zip(
    os.path.join(REPO, "plugin", "crm-native-plugin.zip"),
    expect_name="sales-decision-platform",
    expect_version="1.12.0",
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
        # 2026-09-17 新增对外 MCP 工具：crm-signal-list / crm-signal-ics（主动运行时信号总线，
        #   Plan A 日历规则 + Plan B 内部异动派生的对外出口）。背景：后端已跑通（crm.signal 有产出）
        #   但专家包读清单不含二者 ⇒ 外部办公智能体看得见工具名、不知道何时用 → 「落树不可感知」。
        #   三条均锚定 skills/crm-native/SKILL.md，否则会被 plugin.json / README 抢先满足而假绿。
        "skill 含 crm-signal-list 信号查询路由": (r"crm-signal-list", True, "skills/crm-native/SKILL.md"),
        "skill 含 crm-signal-ics 日历导出路由": (r"crm-signal-ics", True, "skills/crm-native/SKILL.md"),
        "skill 含信号内部推断低置信警示": (r"内部推断（低置信）", True, "skills/crm-native/SKILL.md"),
    },
)

# ---- platform-admin ----
check_zip(
    os.path.join(REPO, "plugin-platform-admin.zip"),
    expect_name="sales-decision-admin",
    expect_version="1.3.0",
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

def _md5(p):
    import hashlib
    with open(p, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def check_skill_mirrors():
    """SKILL.md 多副本漂移守卫（2026-09-17 新增）。

    背景（本轮实测）：同一份 `skills/<x>/SKILL.md` 在仓库里存在 **3 份副本**——
      A. `skills/`              → 权威源（pack-crm-plugin.py 打包源）
      B. `connector/skills/`    → **实时镜像**（Buddy 连接器分发的技能文档，BUDDY 侧读这里）
      C. `.workbuddy-plugin/skills/` → 历史分发副本（无任何打包脚本消费）
    A 改而 B 不改 = 「后端/打包已更新，BUDDY 仍看到旧用法」的静默失配 —— 与
    「落树≠可感知」同族。故对 **A↔B 作硬断言**；C 属死副本，仅告警不阻断（见 WARN）。

    规则：A 下每个文件都必须在 B 中存在且 **逐字节相同**（B 允许有 A 没有的
    connector 专属技能，如 `crm-cli`，不计失败）。
    """
    print(f"\n{'=' * 60}\nskills/ ↔ connector/skills/  (实时镜像漂移守卫)\n{'=' * 60}")
    a_root = os.path.join(REPO, "skills")
    b_root = os.path.join(REPO, "connector", "skills")
    if not (os.path.isdir(a_root) and os.path.isdir(b_root)):
        bad(f"镜像目录缺失：{a_root} 或 {b_root}")
        return
    missing, drift, same = [], [], 0
    for dirpath, _dirnames, filenames in os.walk(a_root):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), a_root)
            bp = os.path.join(b_root, rel)
            if not os.path.exists(bp):
                missing.append(rel)
            elif _md5(os.path.join(dirpath, fn)) != _md5(bp):
                drift.append(rel)
            else:
                same += 1
    if missing or drift:
        for r in missing[:10]:
            bad(f"connector/skills 缺失：{r}")
        for r in drift[:10]:
            bad(f"connector/skills 漂移（内容不一致）：{r}")
        bad(f"镜像不一致：相同 {same} / 缺失 {len(missing)} / 漂移 {len(drift)}"
            f" → 跑 `cp -r skills/<x>/SKILL.md connector/skills/<x>/SKILL.md` 同步"
            f"（或整体 `cp -r skills/. connector/skills/`，保留 connector 专属技能）")
    else:
        ok(f"实时镜像一致（{same} 个文件逐字节相同，零缺失零漂移）")

    # 死副本只告警：不阻断校验，但必须显式可见（禁静默）
    c_root = os.path.join(REPO, ".workbuddy-plugin", "skills")
    if os.path.isdir(c_root):
        c_drift = []
        for dirpath, _dirnames, filenames in os.walk(a_root):
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), a_root)
                cp = os.path.join(c_root, rel)
                if not os.path.exists(cp) or _md5(os.path.join(dirpath, fn)) != _md5(cp):
                    c_drift.append(rel)
        if c_drift:
            print(f"  [WARN] .workbuddy-plugin/skills/ 已漂移 {len(c_drift)} 个文件"
                  f"（历史分发副本，**无任何打包脚本消费**，不影响发布产物；"
                  f"建议同步或移除，避免后人误以为它是源）")
        else:
            ok(".workbuddy-plugin/skills/ 与权威源一致")


def check_preview_artifacts():
    """预览页 ↔ 清单的**结构一致性**自动核对（手工/后处理产物，无法自动重建）。

    两个文件都**无法**自动同步：
      · `assets/capsules/index.html`  —— 无生成器；`pack-buddy-import.mjs` 打包时**显式排除**。
      · `assets/capsules/form-cards.html` —— 由 `gen-capsule-form-cards.mjs` 生成后，
        被**外部编辑器追加 `data-page-node-id`**；直接重生成会抹掉该后处理（实测 945/700 行差异），
        故只能手工增量维护。

    ⚠ 只核对「计数声明」不够：数字写对但**漏卡片**同样是静默陈旧（2026-09-17 实测：
      form-cards 写「14 个胶囊」而清单已 17，且实际缺 3 张卡）。故同时核对**结构证据**——
      卡片节点数 与 胶囊图标引用覆盖。不阻断（二者均非打包必需件），但每次运行必现。
    """
    print(f"\n{'=' * 60}\nassets/capsules 预览页 ↔ 清单（手工/后处理产物，结构一致性）\n{'=' * 60}")
    mf = os.path.join(REPO, "buddy-crm-manifest.json")
    if not os.path.exists(mf):
        print("  [WARN] buddy-crm-manifest.json 缺失，跳过")
        return
    man = json.load(open(mf, encoding="utf-8"))
    modes = (man.get("home") or {}).get("workModes") or []
    total = sum(len(w.get("capsules") or []) for w in modes)
    icons = sorted({
        os.path.basename(c["icon"])
        for w in modes for c in (w.get("capsules") or []) if c.get("icon")
    })

    def review(rel, count_pattern, card_pattern, icon_pattern):
        p = os.path.join(REPO, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print(f"  [WARN] {rel} 不存在（若已废弃请从 check_preview_artifacts 移除）")
            return
        txt = open(p, encoding="utf-8").read()
        # ① 计数声明
        m = re.search(count_pattern, txt)
        if not m:
            print(f"  [WARN] {rel} 未找到计数声明（格式可能已变，需人工核对）")
        elif int(m.group(1)) != total:
            print(f"  [WARN] {rel} 计数陈旧：写 {m.group(1)}，实际应为 {total}（禁静默陈旧）")
        else:
            print(f"  [OK]   {rel} 计数一致（{total} 个胶囊）")
        # ② 结构证据：卡片节点数（无稳定节点模式的文件传 None 跳过）
        if card_pattern:
            cards = len(re.findall(card_pattern, txt))
            if cards == total:
                print(f"  [OK]   {rel} 卡片节点 {cards} 个 = 胶囊总数")
            else:
                print(f"  [WARN] {rel} 卡片节点 {cards} 个 ≠ 胶囊总数 {total}"
                      f"（漏卡 = 分发面陈旧，禁静默）")
        # ③ 结构证据：图标节点数
        #    ⚠ 只验「图标名在文中出现过」太弱——同一图标有 3 处引用时删 1 处仍会通过（实测）。
        #      故按**节点**计数：每张卡必须恰好挂 1 个图标节点。
        nodes = len(re.findall(icon_pattern, txt))
        if nodes == total:
            print(f"  [OK]   {rel} 图标节点 {nodes} 个 = 胶囊总数")
        else:
            print(f"  [WARN] {rel} 图标节点 {nodes} 个 ≠ 胶囊总数 {total}"
                  f"（卡片缺图标 = 分发面陈旧，禁静默）")
        # ④ 图标名覆盖（防整类图标漏挂）
        miss = [i for i in icons if i not in txt]
        if miss:
            print(f"  [WARN] {rel} 缺 {len(miss)} 个胶囊图标："
                  f"{', '.join(miss[:6])}{' …' if len(miss) > 6 else ''}")
        else:
            print(f"  [OK]   {rel} 覆盖全部 {len(icons)} 个胶囊图标")

    review("assets/capsules/index.html", r"(\d+)\s*个场景胶囊",
           None, r'src="\./[a-z0-9-]+\.svg"')
    review("assets/capsules/form-cards.html",
           r"共\s*\d+\s*个工作模式\s*/\s*(\d+)\s*个胶囊",
           r'id="cap-[a-z0-9-]+"', r'class="ico" src="\./[a-z0-9-]+\.svg"')


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


def check_expert_display_fields():
    """专家卡片展示字段的「源清单 ↔ 包内」一致性守卫（2026-09-17 新增）。

    背景（取证见 `.workbuddy/memory/reference-infra-and-guards.md` §十三）：用户可见的专家
    卡片三层 = **大字 `profession`** / **灰色小标题 `displayName`** / 描述 `displayDescription`
    （客户端 `ExpertCard` 用 `profession` 作 h3、`displayName` 落副标题位/花名位）。
    `displayName` 是「小标题」的**唯一载体**，但它同时散落在源清单、`agents/*.md` frontmatter
    与 4 个 zip 里 —— **只改源不重打包 = 用户永远看不到新小标题**（与「落树≠可感知」同族）。

    规则：两个规范包内 `.codebuddy-plugin/plugin.json` 的 `displayName` 与 `profession`
    必须与**源清单逐字一致**（zh 与 en 都比）。`displayDescription.zh` 由打包脚本强制归一到
    40–50 字，故不参与比对（越界会被静默回写为固定句式）。
    """
    print(f"\n{'=' * 60}\n专家卡片字段 源清单 ↔ 包内  (小标题漂移守卫)\n{'=' * 60}")
    pairs = [
        (os.path.join(REPO, "plugin", "crm-native-plugin.zip"),
         os.path.join(REPO, ".workbuddy-plugin", "plugin.json"), "sales-decision-platform"),
        (os.path.join(REPO, "plugin-platform-admin.zip"),
         os.path.join(REPO, "plugin-platform-admin", ".codebuddy-plugin", "plugin.json"),
         "sales-decision-admin"),
    ]
    for zip_path, src_path, label in pairs:
        if not (os.path.exists(zip_path) and os.path.exists(src_path)):
            bad(f"{label}: 包或源清单缺失（{zip_path} / {src_path}）")
            continue
        with zipfile.ZipFile(zip_path) as z:
            inner_pj = json.loads(z.read(".codebuddy-plugin/plugin.json"))
        src_pj = json.load(open(src_path, encoding="utf-8"))
        for field in ("displayName", "profession"):
            a = src_pj.get(field) or {}
            b = inner_pj.get(field) or {}
            if a == b:
                ok(f"{label}.{field} 源↔包一致（zh={a.get('zh')!r}）")
            else:
                bad(f"{label}.{field} 源↔包不一致：源 {a} vs 包 {b}"
                    f" → 跑 `python scripts/pack-{'crm' if label == 'sales-decision-platform' else 'platform-admin'}-plugin.py` 重打包")
        # 小标题禁为空 / 禁回退成技术 ID（早期值形态）
        dz = (inner_pj.get("displayName") or {}).get("zh", "")
        # 黑名单＝全部技术 ID 形态（含 2026-09-17 前的旧 name），displayName 退化为其中任一即判失败
        if dz and dz not in (label, "crm-native", "crm-platform-admin"):
            ok(f"{label}.displayName.zh 非空且非技术 ID（{dz}）")
        else:
            bad(f"{label}.displayName.zh 缺失或退化为技术 ID：{dz!r}")


# ---- 版本一致性守卫 ----
# 为什么需要：2026-09-17 实测发现 1.11.0 轮次**只** bump 了权威源与包内清单，
#   `plugin/openclaw.plugin.json` 与 `plugin/package.json` 漏改（仍停 1.10.0），
#   而 README 把三者并称「版本三清单」⇒ **文档承诺与文件事实不一致，且无任何断言能发现**。
#   `plugin/.workbuddy-plugin/plugin.json`（历史嵌套副本，不参与分发）更长期停在 1.5.0，
#   属同族漂移噪声。本守卫把「版本一致」变成可断言对象。
VERSION_GROUPS = [
    ("sales-decision-platform", [
        ".workbuddy-plugin/plugin.json",                 # 权威源（pack-crm-plugin.py 读它）
        "plugin/openclaw.plugin.json",                   # ClawHub 清单
        "plugin/package.json",                           # npm 清单
        "plugin/.workbuddy-plugin/plugin.json",          # 历史嵌套副本（不参与分发，仅防漂移噪声）
    ]),
    ("sales-decision-admin", [
        "plugin-platform-admin/.codebuddy-plugin/plugin.json",   # 权威源
        "plugin-platform-admin/openclaw.plugin.json",            # ClawHub 清单
        "plugin-platform-admin/package.json",                    # npm 清单
    ]),
]


def check_version_consistency():
    print(f"\n{'=' * 60}\n版本一致性  (版本清单漂移守卫)\n{'=' * 60}")
    for label, rels in VERSION_GROUPS:
        found = {}
        for rel in rels:
            p = os.path.join(REPO, rel.replace("/", os.sep))
            if not os.path.exists(p):
                bad(f"{label}: 版本清单缺失 {rel}")
                continue
            try:
                d = json.load(open(p, encoding="utf-8"))
            except Exception as e:
                bad(f"{label}: {rel} 非合法 JSON（{e}）")
                continue
            found[rel] = d.get("version")

        missing = [r for r, v in found.items() if not v]
        for r in missing:
            bad(f"{label}: {r} 无 version 字段")
        vals = {r: v for r, v in found.items() if v}
        if not vals:
            continue
        uniq = set(vals.values())
        if len(uniq) == 1 and not missing:
            v = uniq.pop()
            ok(f"{label} 版本清单一致（{len(vals)} 文件）= {v}")
        else:
            bad(f"{label} 版本漂移 —— {len(vals)} 个清单出现 {len(uniq)} 个版本："
                + "; ".join(f"{r}={v}" for r, v in sorted(vals.items()))
                + " → 所有清单须同步 bump（不要只改权威源）")

    # 包内清单 ↔ 权威源（防「改了源忘记重打包 = 用户看到的仍是旧版本」）
    pairs = [
        (os.path.join(REPO, "plugin", "crm-native-plugin.zip"),
         os.path.join(REPO, ".workbuddy-plugin", "plugin.json"),
         "sales-decision-platform", "crm"),
        (os.path.join(REPO, "plugin-platform-admin.zip"),
         os.path.join(REPO, "plugin-platform-admin", ".codebuddy-plugin", "plugin.json"),
         "sales-decision-admin", "platform-admin"),
    ]
    for zip_path, src_path, label, packer in pairs:
        if not (os.path.exists(zip_path) and os.path.exists(src_path)):
            bad(f"{label}: 包或源清单缺失，无法比对版本")
            continue
        with zipfile.ZipFile(zip_path) as z:
            inner_v = json.loads(z.read(".codebuddy-plugin/plugin.json")).get("version")
        src_v = json.load(open(src_path, encoding="utf-8")).get("version")
        if inner_v == src_v:
            ok(f"{label} 包内版本 = 源版本 = {src_v}")
        else:
            bad(f"{label} 包内版本 {inner_v} ≠ 源版本 {src_v}"
                f" → 跑 `python scripts/pack-{packer}-plugin.py` 重打包")

    # connector 为**独立版本线**（不与专家包等值），仅作信息输出，避免伪断言。
    meta_p = os.path.join(REPO, "connector", "connector-meta.json")
    if os.path.exists(meta_p):
        mv = json.load(open(meta_p, encoding="utf-8")).get("version")
        print(f"  [INFO] connector 独立版本线：connector-meta.json version = {mv}")


# ---- 专家包 name 源↔包一致守卫 ----
# 为什么需要：`check_zip(expect_name=...)` 断言的是**包内** name；源清单 name 若被改动而
#   忘记重打包，`expect_name` 仍会通过（包内根本没变）⇒ 用户上传的包与源不一致，
#   属「改了源忘重打包」同族假绿。2026-09-17 平台报「专家名称已被占用」而更名时暴露此空白。
# 另断言两条：① 两包 name 互不相同（平台要求全局唯一，复制建包易撞）；② 不回退到历史技术 ID。
EXPERT_NAME_PAIRS = [
    ("plugin/crm-native-plugin.zip", ".workbuddy-plugin/plugin.json",
     "企业AI销售决策专家", "crm"),
    ("plugin-platform-admin.zip", "plugin-platform-admin/.codebuddy-plugin/plugin.json",
     "企业AI销售决策管理专家", "platform-admin"),
]
# 历史技术 ID（更名前的 name + 历史市场源名）：禁止回退，否则平台必判占用
LEGACY_NAMES = {"crm-native", "crm-platform-admin", "crm-native-agent"}


def check_expert_name_consistency():
    print(f"\n{'=' * 60}\n专家包 name 源↔包  (身份标识漂移守卫)\n{'=' * 60}")
    seen = {}
    for zip_rel, src_rel, display, packer in EXPERT_NAME_PAIRS:
        zp = os.path.join(REPO, zip_rel.replace("/", os.sep))
        sp = os.path.join(REPO, src_rel.replace("/", os.sep))
        if not (os.path.exists(zp) and os.path.exists(sp)):
            bad(f"{display}: 包或源清单缺失（{zip_rel} / {src_rel}）")
            continue
        with zipfile.ZipFile(zp) as z:
            zname = json.loads(z.read(".codebuddy-plugin/plugin.json")).get("name")
        sname = json.load(open(sp, encoding="utf-8")).get("name")
        if not zname or not sname:
            bad(f"{display}: name 缺失（包 {zname!r} / 源 {sname!r}）")
            continue
        if zname == sname:
            ok(f"{display}: 包内 name = 源 name = {zname}")
        else:
            bad(f"{display}: 包内 name {zname!r} ≠ 源 name {sname!r}"
                f" → 跑 `python scripts/pack-{packer}-plugin.py` 重打包")
        if zname in LEGACY_NAMES:
            bad(f"{display}: name 回退到历史技术 ID {zname!r}（平台会判为已被占用）")
        if zname in seen:
            bad(f"{display} 与 {seen[zname]} 的 name 相同（{zname!r}）—— 平台要求专家名全局唯一")
        else:
            seen[zname] = display
    for n, d in sorted(seen.items()):
        print(f"  [INFO] {d} name = {n}")


check_connector()
check_skill_mirrors()
check_preview_artifacts()
check_expert_display_fields()
check_version_consistency()
check_expert_name_consistency()

print("\n" + "=" * 60)
if FAIL:
    print(f"❌ 校验未通过，{len(FAIL)} 项：")
    for f in FAIL:
        print("   -", f)
    raise SystemExit(1)
print("✅ 两个包全部校验通过")
