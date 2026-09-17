#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把仓库打好的两个插件 zip 安装到本地 WorkBuddy：

  1) 「我的专家」本地市场源  ~/.workbuddy/plugins/marketplaces/my-experts/plugins/<name>/
  2) 已安装专家实例          ~/.workbuddy/experts/custom/<uuid>/

关键点：zip 内 name 为 `crm-native`，但本地既有注册（settings.json / expert.json /
marketplace.json）用的是 `crm-native-agent`。安装时把 name 规范化为既有值，
否则应用会当成新专家，产生重复条目。

用法: python scripts/install-plugins-to-workbuddy.py [--dry-run]
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid as uuidlib
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WB = os.path.join(os.path.expanduser("~"), ".workbuddy")
MARKET = os.path.join(WB, "plugins", "marketplaces", "my-experts", "plugins")
CUSTOM = os.path.join(WB, "experts", "custom")

DRY = "--dry-run" in sys.argv
LOG = []


def step(msg):
    print(msg)
    LOG.append(msg)


def unzip(zip_path, dest):
    """解压到 dest（覆盖式，不删除既有文件）。"""
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            target = os.path.join(dest, info.filename.replace("/", os.sep))
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def read_manifest(dest):
    p = os.path.join(dest, ".codebuddy-plugin", "plugin.json")
    with open(p, encoding="utf-8") as f:
        return json.load(f), p


def write_manifest(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def install(zip_rel, market_name, normalize_name=None, custom_dir=None,
            create_custom=False, experts_json=None):
    """安装一个插件：市场源 +（可选）已装实例。"""
    zip_path = os.path.join(REPO, zip_rel)
    if not os.path.exists(zip_path):
        raise SystemExit(f"zip 不存在: {zip_path}")

    targets = [(os.path.join(MARKET, market_name), "市场源")]
    if custom_dir:
        targets.append((custom_dir, "已装实例"))

    for dest, label in targets:
        if not os.path.exists(dest) and not create_custom:
            step(f"  ! 跳过（目录不存在）: {dest}")
            continue
        step(f"  → {label}: {dest}")
        if DRY:
            continue
        unzip(zip_path, dest)
        mf, mpath = read_manifest(dest)
        if normalize_name and mf.get("name") != normalize_name:
            step(f"     name 规范化: {mf.get('name')} -> {normalize_name}")
            mf["name"] = normalize_name
            mf["plugin"] = normalize_name
            write_manifest(mpath, mf)

        # avatar 兼容：若历史实例引用的是 avatars/expert.png，补一份同名副本
        av = mf.get("avatar", "")
        if av.startswith("avatars/") and av != "avatars/expert.png":
            src = os.path.join(dest, av.replace("/", os.sep))
            dst = os.path.join(dest, "avatars", "expert.png")
            if os.path.exists(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
                step("     avatar 兼容副本: avatars/expert.png")

    if create_custom and custom_dir and not DRY:
        if experts_json:
            p = os.path.join(custom_dir, "experts.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(experts_json, f, ensure_ascii=False, indent=2)
                f.write("\n")
            step(f"     experts.json: {experts_json}")


def main():
    step("=" * 60)
    step("安装插件到本地 WorkBuddy" + ("（DRY-RUN）" if DRY else ""))
    step("=" * 60)

    # ---- 1. sales-decision-platform：更新市场源 + 已装实例 ----
    existing = [d for d in os.listdir(CUSTOM)
                if os.path.exists(os.path.join(CUSTOM, d, ".codebuddy-plugin", "plugin.json"))]
    crm_dir = None
    for d in existing:
        with open(os.path.join(CUSTOM, d, ".codebuddy-plugin", "plugin.json"),
                  encoding="utf-8") as f:
            j = json.load(f)
        # 兼容旧名：2026-09-17 平台报「crm-native 已被占用」后更名为 sales-decision-platform，
        # 本机若已装旧名实例（包名 crm-native / 历史市场源名 crm-native-agent）须被识别并覆盖更新，
        # 而非与新名实例并存。范式同下方 crm-platform-admin -> sales-decision-admin。
        if j.get("name") in ("sales-decision-platform", "crm-native", "crm-native-agent"):
            crm_dir = os.path.join(CUSTOM, d)
            break

    step(f"[1/2] sales-decision-platform (zip: {os.path.basename('plugin/crm-native-plugin.zip')})")
    if not crm_dir:
        crm_dir = os.path.join(CUSTOM, str(uuidlib.uuid4()))
        step(f"  ! 未找到既有实例，将新建: {crm_dir}")
    install("plugin/crm-native-plugin.zip", "sales-decision-platform",
            normalize_name="sales-decision-platform", custom_dir=crm_dir,
            create_custom=False)

    # ---- 2. sales-decision-admin：更新市场源 + 新建已装实例 ----
    pa_dir = None
    for d in existing:
        with open(os.path.join(CUSTOM, d, ".codebuddy-plugin", "plugin.json"),
                  encoding="utf-8") as f:
            j = json.load(f)
        # 兼容旧名：2026-09-17 平台报「crm-platform-admin 已被占用」后更名为 sales-decision-admin，
        # 本机若已装旧名实例须被识别并覆盖更新，而非并存（范式同上方 crm-native / crm-native-agent）。
        if j.get("name") in ("sales-decision-admin", "crm-platform-admin"):
            pa_dir = os.path.join(CUSTOM, d)
            break
    if not pa_dir:
        pa_dir = os.path.join(CUSTOM, str(uuidlib.uuid4()))
        step(f"  ! 未找到既有实例，将新建: {os.path.basename(pa_dir)}")

    step("[2/2] sales-decision-admin (zip: plugin-platform-admin.zip)")
    install("plugin-platform-admin.zip", "sales-decision-admin",
            normalize_name=None, custom_dir=pa_dir,
            create_custom=True, experts_json=["platform-admin"])

    step("=" * 60)
    step("安装完成。" + ("（DRY-RUN，未写盘）" if DRY else "请重启 WorkBuddy 使专家列表刷新。"))
    step("=" * 60)


if __name__ == "__main__":
    main()
