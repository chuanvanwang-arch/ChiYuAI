#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pack-platform-admin-plugin.py — 将企业AI销售决策管理专家（sales-decision-admin）打包为 WorkBuddy 合规 .zip 分发文件。

与 scripts/pack-crm-plugin.py 同构（同一套合规规则），差异仅在源目录与产物名：
  - 源清单：plugin-platform-admin/.codebuddy-plugin/plugin.json
  - 源技能：plugin-platform-admin/skills/   （本包自持 skills，不共享仓库根 skills/）
  - Agent：  plugin-platform-admin/agents/platform-admin.md
  - Avatar： plugin-platform-admin/avatars/platform-admin.png
  - 产物：   plugin-platform-admin.zip（仓库根）

合规硬规则（error 级，依据 validate_expert.py）：
  1. 元数据必须位于 `.codebuddy-plugin/plugin.json`（不认 `.workbuddy-plugin`）。
  2. agents/ skills/ avatars/ 必须在【插件根目录】，禁止嵌套进 .codebuddy-plugin/。
  3. tags 必须恰好 3 个；quickPrompts 必须恰好 3 个。
  4. displayDescription.zh 推荐 40–50 字（warning）。

用法：
    python scripts/pack-platform-admin-plugin.py
    python scripts/pack-platform-admin-plugin.py --out plugin-platform-admin.zip
"""

import argparse
import json
import os
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

PKG_DIR = os.path.join(REPO_ROOT, "plugin-platform-admin")
SRC_PLUGIN_DIR = os.path.join(PKG_DIR, ".codebuddy-plugin")
SRC_SKILLS_DIR = os.path.join(PKG_DIR, "skills")
SRC_AGENT = os.path.join(PKG_DIR, "agents", "platform-admin.md")
SRC_AVATAR = os.path.join(PKG_DIR, "avatars", "platform-admin.png")
SRC_README = os.path.join(PKG_DIR, "README.md")
DEFAULT_OUT = os.path.join(REPO_ROOT, "plugin-platform-admin.zip")

DESC_MIN, DESC_MAX = 40, 50
DESC_ZH_FIXED = "平台治理助手：配置化上线行业租户、开通用户与权限、执行系统初始化。零信任禁删、决策第 0 闸。"

_META_DIRNAME = ".codebuddy-plugin"


def _fit_desc(zh: str) -> str:
    """保证 displayDescription.zh 落在 [DESC_MIN, DESC_MAX] 区间内。"""
    if DESC_MIN <= len(zh) <= DESC_MAX:
        return zh
    if len(zh) > DESC_MAX:
        return zh[:DESC_MAX]
    return zh + "　" * (DESC_MIN - len(zh))


def normalize_plugin_json(pj: dict) -> list:
    """就地归一化 plugin.json，返回修改说明列表。"""
    notes = []

    tags = pj.get("tags")
    if isinstance(tags, list) and len(tags) != 3:
        kept = tags[:3]
        dropped = [t.get("zh", t.get("en", "?")) for t in tags[3:]]
        pj["tags"] = kept
        notes.append(f"tags: {len(tags)} -> 3（丢弃 {dropped}）")

    qp = pj.get("quickPrompts")
    if isinstance(qp, list) and len(qp) != 3:
        pj["quickPrompts"] = qp[:3]
        notes.append(f"quickPrompts: {len(qp)} -> 3")

    dd = pj.get("displayDescription")
    if isinstance(dd, dict):
        zh = dd.get("zh", "")
        if zh and not (DESC_MIN <= len(zh) <= DESC_MAX):
            new_zh = _fit_desc(DESC_ZH_FIXED)
            dd["zh"] = new_zh
            notes.append(f"displayDescription.zh: {len(zh)} 字 -> 合规区间（{len(new_zh)} 字）")

    dip = pj.get("defaultInitPrompt")
    if isinstance(dip, dict) and isinstance(qp, list) and qp and isinstance(qp[0], dict):
        if dip.get("zh") and dip["zh"] != qp[0].get("zh"):
            dip["zh"] = qp[0]["zh"]
            notes.append("defaultInitPrompt.zh 对齐 quickPrompts[0].zh")

    return notes


def build_zip(out_zip: str, pj_normalized: dict) -> dict:
    """按合规布局构建 zip，返回统计信息。"""
    if not os.path.isdir(SRC_SKILLS_DIR):
        raise SystemExit(f"[FATAL] 找不到 skills 源: {SRC_SKILLS_DIR}")
    for f in (SRC_AGENT, SRC_AVATAR):
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
        add_bytes(zf, f"{_META_DIRNAME}/plugin.json",
                  json.dumps(pj_normalized, indent=2, ensure_ascii=False).encode("utf-8"))
        zf.write(SRC_AGENT, "agents/platform-admin.md")
        file_count += 1
        zf.write(SRC_AVATAR, "avatars/platform-admin.png")
        file_count += 1

        included = set()
        for s in pj_normalized.get("skills", []):
            name = s.replace("./", "").replace("skills/", "").strip("/")
            if name:
                included.add(name)
        for name in sorted(included):
            src_dir = os.path.join(SRC_SKILLS_DIR, name)
            if not os.path.isdir(src_dir):
                print(f"  [SKIP] 清单项在源缺失: {name}")
                continue
            for root, _, files in os.walk(src_dir):
                for fn in files:
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, SRC_SKILLS_DIR)
                    zf.write(full, os.path.join("skills", rel))
                    file_count += 1
                    if fn == "SKILL.md":
                        skill_count += 1

        if os.path.exists(SRC_README):
            zf.write(SRC_README, "README.md")
            file_count += 1

    return {"skill_count": skill_count, "file_count": file_count, "out_zip": out_zip}


def main():
    ap = argparse.ArgumentParser(description="Pack sales-decision-admin into a compliant WorkBuddy zip")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出 zip 路径")
    args = ap.parse_args()

    pj_path = os.path.join(SRC_PLUGIN_DIR, "plugin.json")
    if not os.path.exists(pj_path):
        raise SystemExit(f"[FATAL] 找不到插件清单: {pj_path}")

    with open(pj_path, encoding="utf-8") as f:
        pj = json.load(f)

    notes = normalize_plugin_json(pj)

    with open(pj_path, "w", encoding="utf-8") as f:
        json.dump(pj, f, indent=2, ensure_ascii=False)

    stats = build_zip(args.out, pj)

    print("=== pack-platform-admin-plugin 完成 ===")
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
