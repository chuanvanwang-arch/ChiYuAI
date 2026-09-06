#!/usr/bin/env python3
"""
本地打包 CRM-ai-native 精简部署包（跨平台，生成正斜杠路径的 zip）。

为什么不用 PowerShell 的 Compress-Archive：它使用反斜杠作为路径分隔符，
Linux unzip 会解压出扁平的 `src\\http\\server.js` 文件而非目录树。
Python zipfile 生成标准正斜杠路径，可直接被任何 unzip 正确解压。

用法: python pack-local.py [--src D:\\system\\CRM-ai-native] [--out crm-deploy.zip]
"""
import argparse
import os
import zipfile

# 运行期必需的顶层条目（docs 不可省：src/http/routes.js 运行时读取 docs/specs/*.md）
INCLUDE_DIRS = ["src", "db", "docs", "scripts"]
INCLUDE_FILES = ["package.json", "package-lock.json"]

# 排除规则（路径片段匹配）
EXCLUDE_DIR_PARTS = {"node_modules", ".git", ".workbuddy", "__pycache__", ".venv"}
EXCLUDE_SUFFIX = {".png", ".jpg", ".jpeg", ".gif", ".zip", ".log", ".bak", ".tmp"}


def should_skip(rel_parts):
    for p in rel_parts[:-1]:
        if p in EXCLUDE_DIR_PARTS:
            return True
    name = rel_parts[-1]
    if os.path.splitext(name)[1].lower() in EXCLUDE_SUFFIX:
        return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.getcwd())
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    src = os.path.abspath(args.src)
    out = args.out or os.path.join(os.environ.get("TEMP", "."), "crm-deploy.zip")

    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for top in INCLUDE_DIRS:
            base = os.path.join(src, top)
            if not os.path.isdir(base):
                print(f"· 跳过（不存在）: {top}")
                continue
            for root, dirs, files in os.walk(base):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIR_PARTS]
                for f in files:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, src).replace(os.sep, "/")
                    if should_skip(rel.split("/")):
                        continue
                    z.write(full, rel)
                    n += 1
        for f in INCLUDE_FILES:
            full = os.path.join(src, f)
            if os.path.isfile(full):
                z.write(full, f)
                n += 1
        # 附件存储目录（src/assets/storage.js 默认写 uploads/assets）
        z.writestr("uploads/assets/.gitkeep", "")

    size_mb = os.path.getsize(out) / 1024 / 1024
    print(f"✓ 打包完成: {out}")
    print(f"  文件数: {n}   大小: {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
