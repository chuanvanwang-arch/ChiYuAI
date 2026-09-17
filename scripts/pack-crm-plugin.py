#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pack-crm-plugin.py — 将 CRM-ai-native 专家包打包为 WorkBuddy 合规的 .zip 分发文件。

合规依据：~/.workbuddy/plugins/cache/workbuddy-builtin/skill-expert-manager/0.1.0/scripts/validate_expert.py
硬规则（error 级）：
  1. 元数据必须位于 `.codebuddy-plugin/plugin.json`（不认 `.workbuddy-plugin`）。
  2. agents/ skills/ avatars/ 必须在【插件根目录】，禁止嵌套进 .codebuddy-plugin/。
  3. tags 必须恰好 3 个；quickPrompts 必须恰好 3 个。
  4. displayDescription.zh 推荐 40–50 字（warning）。

源事实（README）：
  - 仓库根 skills/ 为权威源；.workbuddy-plugin/skills/ 是分发副本。
  - .workbuddy-plugin/{plugin.json, agents, avatars} 为插件定义源。

本脚本做的事：
  - 读取 .workbuddy-plugin/plugin.json，做合规归一化并【写回源】(.workbuddy-plugin/plugin.json)。
  - 将资源重组为合规布局后打包到 plugin/crm-native-plugin.zip：
        .codebuddy-plugin/plugin.json   (归一化)
        agents/crm-native.md
        avatars/crm-native.png
        skills/<repo-root skills/ 全部>
  - 纯标准库实现（zipfile），无第三方依赖。

用法：
    python scripts/pack-crm-plugin.py
    python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
"""

import argparse
import json
import os
import sys
import zipfile

# ---- 路径解析（脚本位于 <repo>/scripts/） ----
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

SRC_PLUGIN_DIR = os.path.join(REPO_ROOT, ".workbuddy-plugin")   # 插件定义源
SRC_SKILLS_DIR = os.path.join(REPO_ROOT, "skills")              # 权威 skills 源
SRC_README = os.path.join(REPO_ROOT, "plugin", "README.md")     # 随包 README（validator 推荐）
DEFAULT_OUT = os.path.join(REPO_ROOT, "plugin", "crm-native-plugin.zip")

# displayDescription.zh 合规区间
DESC_MIN, DESC_MAX = 40, 50
DESC_ZH_FIXED = "角色自适应的企业AI销售决策专家：一句话查询、两阶段对话式写入、链断裂主动预警。"


def _fit_desc(zh: str) -> str:
    """保证 displayDescription.zh 落在 [DESC_MIN, DESC_MAX] 区间内。"""
    if DESC_MIN <= len(zh) <= DESC_MAX:
        return zh
    if len(zh) > DESC_MAX:
        return zh[:DESC_MAX]
    # 过短则补全角空格至下限（兜底，正常不会触发）
    return zh + "　" * (DESC_MIN - len(zh))

_META_DIRNAME = ".codebuddy-plugin"   # 平台唯一认可的元数据目录名


def normalize_plugin_json(pj: dict) -> list:
    """就地归一化 plugin.json，返回修改说明列表。"""
    notes = []

    # 1) tags 必须恰好 3 个
    tags = pj.get("tags")
    if isinstance(tags, list) and len(tags) != 3:
        kept = tags[:3]
        dropped = [t.get("zh", t.get("en", "?")) for t in tags[3:]]
        pj["tags"] = kept
        notes.append(f"tags: {len(tags)} -> 3（丢弃 {dropped}）")

    # 2) quickPrompts 必须恰好 3 个
    qp = pj.get("quickPrompts")
    if isinstance(qp, list) and len(qp) != 3:
        pj["quickPrompts"] = qp[:3]
        notes.append(f"quickPrompts: {len(qp)} -> 3")

    # 3) displayDescription.zh 推荐 40–50 字
    dd = pj.get("displayDescription")
    if isinstance(dd, dict):
        zh = dd.get("zh", "")
        if zh and not (DESC_MIN <= len(zh) <= DESC_MAX):
            new_zh = _fit_desc(DESC_ZH_FIXED)
            dd["zh"] = new_zh
            notes.append(f"displayDescription.zh: {len(zh)} 字 -> 合规区间（{len(new_zh)} 字）")

    # 4) defaultInitPrompt.zh 应与 quickPrompts[0].zh 一致（warning 级，自动对齐）
    dip = pj.get("defaultInitPrompt")
    if isinstance(dip, dict) and isinstance(qp, list) and qp and isinstance(qp[0], dict):
        if dip.get("zh") and dip["zh"] != qp[0].get("zh"):
            dip["zh"] = qp[0]["zh"]
            notes.append("defaultInitPrompt.zh 对齐 quickPrompts[0].zh")

    return notes


def build_zip(out_zip: str, pj_normalized: dict) -> dict:
    """按合规布局构建 zip，返回统计信息。"""
    if not os.path.isdir(SRC_SKILLS_DIR):
        raise SystemExit(f"[FATAL] 找不到权威 skills 源: {SRC_SKILLS_DIR}")
    agent_md = os.path.join(SRC_PLUGIN_DIR, "agents", "crm-native.md")
    avatar_png = os.path.join(SRC_PLUGIN_DIR, "avatars", "crm-native.png")
    for f in (agent_md, avatar_png):
        if not os.path.exists(f):
            raise SystemExit(f"[FATAL] 缺少源文件: {f}")

    os.makedirs(os.path.dirname(out_zip), exist_ok=True)
    if os.path.exists(out_zip):
        os.remove(out_zip)

    skill_count = 0
    file_count = 0

    def add_bytes(zf, arcname, data):
        nonlocal file_count
        zf.writestr(arcname, data)
        file_count += 1

    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        # 元数据
        add_bytes(zf, f"{_META_DIRNAME}/plugin.json",
                  json.dumps(pj_normalized, indent=2, ensure_ascii=False).encode("utf-8"))
        # agent 定义
        zf.write(agent_md, "agents/crm-native.md")
        file_count += 1
        # avatar
        zf.write(avatar_png, "avatars/crm-native.png")
        file_count += 1
        # skills（权威源，仅打包 manifest 清单内技能，WIP 不纳入）
        # 清单形如 "./skills/<name>"（.workbuddy-plugin）或 "skills/<name>"（openclaw）
        included = set()
        for s in pj_normalized.get("skills", []):
            name = s.replace("./", "").replace("skills/", "").strip("/")
            if name:
                included.add(name)
        for name in sorted(included):
            src_dir = os.path.join(SRC_SKILLS_DIR, name)
            if not os.path.isdir(src_dir):
                print(f"  [SKIP] 清单项在权威源缺失: {name}")
                continue
            for root, _, files in os.walk(src_dir):
                for fn in files:
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, SRC_SKILLS_DIR)
                    zf.write(full, os.path.join("skills", rel))
                    file_count += 1
                    if fn == "SKILL.md":
                        skill_count += 1

        # README（validator 推荐项）
        if os.path.exists(SRC_README):
            zf.write(SRC_README, "README.md")
            file_count += 1

    return {"skill_count": skill_count, "file_count": file_count, "out_zip": out_zip}


def main():
    ap = argparse.ArgumentParser(description="Pack sales-decision-platform expert into a compliant WorkBuddy zip")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出 zip 路径")
    args = ap.parse_args()

    pj_path = os.path.join(SRC_PLUGIN_DIR, "plugin.json")
    if not os.path.exists(pj_path):
        raise SystemExit(f"[FATAL] 找不到插件清单: {pj_path}")

    with open(pj_path, encoding="utf-8") as f:
        pj = json.load(f)

    notes = normalize_plugin_json(pj)

    # 写回归一化后的清单（idempotent：下次打包源即已合规）
    with open(pj_path, "w", encoding="utf-8") as f:
        json.dump(pj, f, indent=2, ensure_ascii=False)

    stats = build_zip(args.out, pj)

    print("=== pack-crm-plugin 完成 ===")
    if notes:
        print("plugin.json 归一化：")
        for n in notes:
            print("  -", n)
    else:
        print("plugin.json 已合规，无需修改。")
    print(f"输出: {stats['out_zip']}")
    print(f"技能数(SKILL.md): {stats['skill_count']}  文件数: {stats['file_count']}")
    print(f"布局: .codebuddy-plugin/plugin.json + 根目录 agents/ skills/ avatars/")


if __name__ == "__main__":
    main()
