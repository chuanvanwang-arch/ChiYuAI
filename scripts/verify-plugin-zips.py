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
  - platform-admin 须含 Step 4B / Step 4.5（按租户播种主数据 + KNOWLEDGE 种子）。

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
        for label, (pattern, should_exist) in content_rules.items():
            found = False
            where = ""
            for n in inner:
                if not (n.endswith(".md") or n.endswith(".json")):
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
                bad(f"{label} —— 期望{'存在' if should_exist else '不存在'}，实际相反")

    print(f"  文件总数: {len(inner)}")


# ---- crm-native ----
check_zip(
    os.path.join(REPO, "plugin", "crm-native-plugin.zip"),
    expect_name="crm-native",
    expect_version="1.6.0",
    skill_names=["crm-native", "crm-query", "crm-write", "crm-risk", "decision-retrospective",
                 "method-bant", "method-meddicc", "method-opportunity-matrix", "method-role-map",
                 "method-risk-tradeoff", "method-stop-loss", "method-fact-vs-script",
                 "method-presales", "method-behavior-standard", "method-funnel-classification",
                 "method-stage-progression"],
    content_rules={
        "无「无需登录即可被办公智能体调用」旧错误文案": (r"无需登录即可被办公智能体调用", False),
        "crm-risk 含 stop_loss_triggered 止损规则": (r"stop_loss_triggered", True),
        "端点已参数化（写明由连接器决定）": (r"端点地址由连接器配置决定", True),
        "无写死的 StreamableHTTP @ localhost 表述": (r"StreamableHTTP `@ http://localhost:3001/mcp`", False),
        "保留 crm_login 强制登录铁律": (r"crm_login", True),
        "含决策建议工具 crm-decision-advise（2026-09-08 新增）": (r"crm-decision-advise", True),
        "含决策建议三档（A 处置 / B 红线审批 / C 补信息）": (r"B 风险提示", True),
    },
)

# ---- platform-admin ----
check_zip(
    os.path.join(REPO, "plugin-platform-admin.zip"),
    expect_name="crm-platform-admin",
    expect_version="1.1.0",
    skill_names=["industry-onboarding", "user-rbac-admin", "system-bootstrap", "platform-ops-insight"],
    content_rules={
        "industry-onboarding 含 Step 4B 按租户播种主数据": (r"Step 4B", True),
        "industry-onboarding 含 Step 4.5 租户 KNOWLEDGE 种子": (r"Step 4\.5", True),
        "端点已参数化（写明由连接器决定）": (r"端点地址由连接器配置决定", True),
        "无写死的 StreamableHTTP @ localhost 表述": (r"StreamableHTTP `@ http://localhost:3001/mcp`", False),
        "保留 sysadmin 准入双闸": (r"sysadmin", True),
    },
)

print("\n" + "=" * 60)
if FAIL:
    print(f"❌ 校验未通过，{len(FAIL)} 项：")
    for f in FAIL:
        print("   -", f)
    raise SystemExit(1)
print("✅ 两个包全部校验通过")
