#!/usr/bin/env python3
"""
在 Linux 主机上解压 CRM-ai-native 部署包。

为什么不用 unzip：Windows 的 Compress-Archive 生成的 zip 使用反斜杠 `\\` 作为路径
分隔符，Linux unzip 会将其视为文件名的一部分（解压出 `src\\http\\server.js` 这类
单文件而非目录树），导致后续找不到源码路径。本脚本统一规范化为 `/`。

用法: python3 unpack.py <zip路径> <目标目录> [--clean]

--clean: 解压前清空目标目录（重装场景）。仅对白名单前缀路径生效，防止误删。
"""
import os
import shutil
import sys
import zipfile

# 清理白名单：仅允许在这些前缀下执行清空操作
CLEAN_SAFE_PREFIXES = ("/opt/", "/srv/", "/var/www/")


def _force_remove(func, path, exc_info):
    """rmtree 的 onerror：权限不足时提权后重试（zip 可能携带异常权限位）。"""
    import stat as st
    try:
        parent = os.path.dirname(path)
        if os.path.exists(parent):
            os.chmod(parent, 0o755)
        if os.path.exists(path):
            os.chmod(path, 0o755)
    except OSError:
        pass
    try:
        func(path)
    except OSError:
        pass


def clean_dir(dest):
    """清空目标目录内容（不删除目录本身）。带路径白名单护栏。"""
    dest_abs = os.path.abspath(dest)
    if not any(dest_abs.startswith(p) for p in CLEAN_SAFE_PREFIXES) or len(dest_abs) <= 4:
        raise SystemExit(f"拒绝清空非白名单路径: {dest_abs}（仅允许 {CLEAN_SAFE_PREFIXES}）")
    if not os.path.isdir(dest_abs):
        return
    removed = 0
    for entry in os.listdir(dest_abs):
        p = os.path.join(dest_abs, entry)
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p, onerror=_force_remove)
        else:
            try:
                os.remove(p)
            except OSError:
                _force_remove(os.remove, p, None)
        removed += 1
    print(f"· 已清空 {dest_abs}（{removed} 个条目）")


def normalize_perms(dest):
    """统一目录 755 / 文件 644，消除 zip 携带的异常权限位。"""
    fixed = 0
    for root, dirs, files in os.walk(dest):
        for d in dirs:
            p = os.path.join(root, d)
            try:
                if os.stat(p).st_mode & 0o777 != 0o755:
                    os.chmod(p, 0o755)
                    fixed += 1
            except OSError:
                pass
        for f in files:
            p = os.path.join(root, f)
            try:
                if os.stat(p).st_mode & 0o777 & 0o111:
                    os.chmod(p, 0o644)
                    fixed += 1
            except OSError:
                pass
    if fixed:
        print(f"· 权限规范化: {fixed} 项")


def safe_join(root, rel):
    """拼接并防御路径穿越（../ 、绝对路径、盘符）。"""
    rel = rel.replace("\\", "/").lstrip("/")
    parts = []
    for p in rel.split("/"):
        if p in ("", ".", ".."):
            continue
        parts.append(p)
    target = os.path.join(root, *parts) if parts else root
    root_abs = os.path.abspath(root)
    target_abs = os.path.abspath(target)
    if not (target_abs == root_abs or target_abs.startswith(root_abs + os.sep)):
        raise SystemExit(f"不安全路径，已拒绝: {rel}")
    return target_abs


def main():
    args = [a for a in sys.argv[1:]]
    do_clean = "--clean" in args
    args = [a for a in args if a != "--clean"]
    if len(args) != 2:
        sys.exit("用法: python3 unpack.py <zip路径> <目标目录> [--clean]")
    zip_path, dest = args
    os.makedirs(dest, exist_ok=True)
    if do_clean:
        clean_dir(dest)

    count = 0
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if name.endswith("/"):
                continue
            target = safe_join(dest, name)
            d = os.path.dirname(target)
            os.makedirs(d, exist_ok=True)
            # 显式赋权：zip 可能记录异常权限位，导致目录不可进入（实测踩坑）
            try:
                os.chmod(d, 0o755)
            except OSError:
                pass
            with z.open(name) as src, open(target, "wb") as out:
                out.write(src.read())
            count += 1
    normalize_perms(dest)
    print(f"✓ 解压完成: {count} 个文件 -> {dest}")


if __name__ == "__main__":
    main()
