#!/usr/bin/env python3
"""
CRM-ai-native 远程部署驱动（基于 paramiko，跨平台）。

用途：在 Windows 本机驱动腾讯云 Lighthouse 主机完成部署，无需手工 SSH 交互。

子命令:
  probe                     探测主机环境（系统/docker/磁盘/内存/sudo 免密）
  upload  --pkg <zip>       上传部署包并解压到远程项目根
  release                   【日常发布主通道】本地打包 → 上传 → 远程 build/restart → 自检
  hotfix  --file <路径>      【应急通道】单/多文件直送容器（docker cp）+ 重启，免 rebuild
  initenv                   在远程生成 .env（随机强密码）
  deploy [--seed]           仅执行 deploy.sh（release 已包含本步）
  status                    查看容器状态与 HTTP 自测
  exec    -- "<命令>"       在远程执行任意命令
  push --local X --remote Y 推送单个文件到远程任意路径（底层能力）

发布方式选择:
  - 改了源码/npm 依赖/Dockerfile/docker-compose/db/schema.sql → 用 release（镜像重建，权威）
  - 只改了几个运行期文件、想立刻生效 → 用 hotfix（快，但容器重建即失效，事后必须补 release）
  ⚠ 代码是 COPY 进镜像的（非 bind mount），把文件 push 到 /opt/crm-ai-native 不会生效。

凭据来源（优先级从高到低）:
  --password-file <路径>   从文件读取密码（推荐，避免明文出现在命令行/历史）
  --password <密码>
  环境变量 CRM_SSH_PASSWORD

常用参数:
  --host  默认环境变量 CRM_SSH_HOST 或 81.70.184.198
  --user  默认环境变量 CRM_SSH_USER  或 ubuntu
  --remote-root 默认 /opt/crm-ai-native
"""
import argparse
import os
import secrets
import stat
import sys
import time

try:
    import paramiko
except ImportError:
    sys.exit("缺少依赖：请先 pip install paramiko")

DEFAULT_TIMEOUT = 3600  # 构建/拉镜像可能较久


def build_client(args):
    password = None
    if args.password_file:
        with open(args.password_file, "r", encoding="utf-8") as f:
            password = f.read().strip()
    elif args.password:
        password = args.password
    else:
        password = os.environ.get("CRM_SSH_PASSWORD")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=args.host,
        username=args.user,
        password=password,
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run(client, cmd, timeout=DEFAULT_TIMEOUT, stream=True, check=False):
    """执行远程命令，流式回显，返回 (exit_code, output)。"""
    transport = client.get_transport()
    channel = transport.open_session()
    channel.settimeout(timeout)
    channel.exec_command(cmd)

    out = []
    start = time.time()
    while True:
        if channel.recv_ready():
            chunk = channel.recv(65536).decode("utf-8", errors="replace")
            out.append(chunk)
            if stream:
                sys.stdout.write(chunk)
                sys.stdout.flush()
        if channel.recv_stderr_ready():
            chunk = channel.recv_stderr(65536).decode("utf-8", errors="replace")
            out.append(chunk)
            if stream:
                sys.stderr.write(chunk)
                sys.stderr.flush()
        if channel.exit_status_ready():
            # 排空剩余输出
            while channel.recv_ready():
                out.append(channel.recv(65536).decode("utf-8", errors="replace"))
            while channel.recv_stderr_ready():
                out.append(channel.recv_stderr(65536).decode("utf-8", errors="replace"))
            break
        if time.time() - start > timeout:
            channel.close()
            raise TimeoutError(f"命令超时（{timeout}s）：{cmd}")
        time.sleep(0.3)

    code = channel.recv_exit_status()
    channel.close()
    if check and code != 0:
        raise SystemExit(f"命令失败（exit={code}）：{cmd}")
    return code, "".join(out)


def sftp_upload(client, local_path, remote_path):
    sftp = client.open_sftp()
    try:
        last_pct = [-1]
        total = os.path.getsize(local_path)
        done = [0]

        def cb(transferred, _total):
            done[0] = transferred
            pct = int(transferred * 100 / total)
            if pct != last_pct[0] and pct % 10 == 0:
                last_pct[0] = pct
                print(f"  上传进度: {pct}% ({transferred // 1024} KB / {total // 1024} KB)")

        sftp.put(local_path, remote_path, callback=cb)
        print(f"✓ 上传完成: {remote_path} ({total // 1024} KB)")
    finally:
        sftp.close()


PROBE_CMD = r"""
echo "=== 系统 ==="; lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME
echo "=== 内核/架构 ==="; uname -m -r
echo "=== CPU/内存 ==="; nproc; free -h | head -2
echo "=== 磁盘 ==="; df -h / | tail -1
echo "=== docker ==="; docker --version 2>/dev/null || echo "docker 未安装"
echo "=== docker compose ==="; docker compose version 2>/dev/null || echo "compose 插件未安装"
echo "=== docker 权限 ==="; docker info >/dev/null 2>&1 && echo "当前用户可直接用 docker" || echo "需要 sudo 或加入 docker 组"
echo "=== sudo 免密 ==="; sudo -n true 2>/dev/null && echo "sudo 免密可用" || echo "sudo 需要密码"
echo "=== nginx ==="; nginx -v 2>/dev/null || echo "nginx 未安装"
echo "=== 端口占用 ==="; (ss -lntp 2>/dev/null | grep -E ':80 |:443 |:3000 ' || echo "80/443/3000 均空闲")
echo "=== 出网 ==="; curl -s -o /dev/null -w "hub.docker.com: %{http_code}\n" -m 8 https://hub.docker.com/ || echo "访问 Docker Hub 失败"
curl -s -o /dev/null -w "registry.npmmirror.com: %{http_code}\n" -m 8 https://registry.npmmirror.com/ || echo "访问 npmmirror 失败"
"""


def cmd_probe(client, args):
    return run(client, PROBE_CMD, timeout=120)[0]


def cmd_upload(client, args):
    remote_zip = "/tmp/crm-deploy.zip"
    remote_unpack = "/tmp/crm-unpack.py"
    local_unpack = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unpack.py")

    print(f"==> 上传 {args.pkg} -> {remote_zip}")
    sftp_upload(client, args.pkg, remote_zip)
    sftp_upload(client, local_unpack, remote_unpack)

    # 必须经 unpack.py 规范化路径分隔符：Windows Compress-Archive 产出的 zip 用反斜杠，
    # Linux unzip 会解压成扁平文件名（src\http\server.js）而非目录树。
    print(f"==> 解压到 {args.remote_root}")
    script = f"""
set -e
sudo mkdir -p {args.remote_root}
sudo chown -R $USER:$USER {args.remote_root}
# --clean 先清空再解压；用 sudo 规避 zip 携带的异常权限位导致删除/创建失败
sudo python3 {remote_unpack} {remote_zip} {args.remote_root} --clean
sudo chown -R $USER:$USER {args.remote_root}
mkdir -p {args.remote_root}/uploads/assets
echo "---- 关键文件校验 ----"
for f in package.json package-lock.json src/http/server.js db/migrate.js db/schema.sql scripts/tencent-lighthouse-deploy/deploy.sh; do
  [ -f "{args.remote_root}/$f" ] && echo "OK  $f" || echo "缺失 $f"
done
echo "---- 目录概览 ----"
ls -la {args.remote_root}
du -sh {args.remote_root}
"""
    return run(client, script, timeout=900, check=True)[0]


def cmd_initenv(client, args):
    pw = secrets.token_urlsafe(24)
    env_dir = f"{args.remote_root}/scripts/tencent-lighthouse-deploy"
    script = f"""
set -e
cd {env_dir}
if [ -f .env ]; then
  echo "已存在 .env，保留现有配置（如需重置请先删除）"
else
  cat > .env <<EOF
PGUSER=agent2b
PGPASSWORD={pw}
PGDATABASE=crm_native
NODE_ENV=production
PORT=3000
EOF
  chmod 600 .env
  echo "已生成 .env"
fi
echo "--- .env 脱敏预览 ---"
sed 's/^PGPASSWORD=.*/PGPASSWORD=***（见本地 .env.server）/' .env
"""
    code = run(client, script, timeout=120)[0]
    if code == 0:
        # 保存凭据到本地（提醒 gitignore）
        local_save = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env.server")
        with open(local_save, "w", encoding="utf-8") as f:
            f.write(f"# 腾讯云 Lighthouse 部署凭据（自动生成，请勿提交 git）\n")
            f.write(f"SSH_HOST={args.host}\n")
            f.write(f"SSH_USER={args.user}\n")
            f.write(f"PGUSER=agent2b\n")
            f.write(f"PGPASSWORD={pw}\n")
            f.write(f"PGDATABASE=crm_native\n")
            f.write(f"REMOTE_ROOT={args.remote_root}\n")
        os.chmod(local_save, stat.S_IRUSR | stat.S_IWUSR)
        print(f"\n✓ 数据库凭据已保存到本地: {local_save}  （请备份，勿提交 git）")
    return code


def cmd_push(client, args):
    """推送单个本地文件到远程（增量更新，不影响 .env 与数据库卷）。"""
    if not args.local or not args.remote:
        raise SystemExit("push 需要同时指定 --local 与 --remote")
    if not os.path.isfile(args.local):
        raise SystemExit(f"本地文件不存在: {args.local}")
    sftp_upload(client, args.local, args.remote)
    print(f"✓ 已推送: {args.local} -> {args.remote}")
    return 0


# ───────────────────────── 发布（打包 → 上传 → 部署 → 自检）─────────────────────────
# 代码是 COPY 进镜像的（Dockerfile: `COPY . .`），不是 bind mount，
# 所以改了源码必须走 rebuild；只 push 文件到 /opt 目录不会影响运行中的容器。
def cmd_release(client, args):
    import subprocess

    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(args.local_root)
    packer = os.path.join(here, "pack-local.py")
    if not os.path.isfile(packer):
        raise SystemExit(f"缺少打包脚本: {packer}")

    pkg = args.pkg or os.path.join(os.environ.get("TEMP", "."), "crm-deploy.zip")
    print(f"==> [1/4] 本地打包 {root}")
    r = subprocess.run([sys.executable, packer, "--src", root, "--out", pkg])
    if r.returncode != 0:
        raise SystemExit("打包失败")
    args.pkg = pkg

    print(f"==> [2/4] 上传并解压到 {args.remote_root}")
    cmd_upload(client, args)

    print("==> [3/4] 远程一键部署（rebuild app/mcp + 幂等迁移）")
    code = cmd_deploy(client, args)
    if code != 0:
        return code

    print("==> [4/4] 部署后自检")
    cmd_status(client, args)
    print("\n✓ 发布流程结束。请确认：公网 / 返回 200、app 日志无 ERROR、关键功能已点检。")
    return 0


# ───────────────────────── 热修（单/多文件直送容器，免 rebuild）─────────────────────────
# 适用：仅改了 JS/SQL/前端等运行期文件，且未改动 package.json 依赖。
# 不适用：新增/升级 npm 依赖、改 Dockerfile、改 db/schema.sql 之外的镜像层内容 —— 必须走 release。
# 注意：docker cp 只改容器可写层，容器重建（docker compose up）即失效，
#       所以热修后仍须把改动提交 git，并尽快走一次 release 让镜像与仓库对齐。
HOTFIX_ALLOW_TOP = {"src", "db", "scripts", "docs"}
HOTFIX_ALLOW_FILES = {"package.json", "package-lock.json"}


def _rel_to_root(root, local):
    p = os.path.abspath(local)
    try:
        rel = os.path.relpath(p, root)
    except ValueError:
        # Windows 跨盘符时 os.path.relpath 抛 ValueError（不是越权，但同样应拒绝）
        raise SystemExit(f"文件与项目根不在同一盘符，拒绝热修: {local} （项目根 {root}）")
    rel = rel.replace(os.sep, "/")
    if rel.startswith("..") or rel.startswith("/"):
        raise SystemExit(f"文件不在项目根内，拒绝热修: {local}")
    top = rel.split("/")[0]
    if "/" in rel:
        if top not in HOTFIX_ALLOW_TOP:
            raise SystemExit(f"目录不在白名单 {sorted(HOTFIX_ALLOW_TOP)} 内，拒绝热修: {rel}")
    elif rel not in HOTFIX_ALLOW_FILES:
        raise SystemExit(f"文件不在白名单内，拒绝热修: {rel}")
    return rel


def cmd_hotfix(client, args):
    if not args.file:
        raise SystemExit("hotfix 需要至少一个 --file <项目根内的文件路径>")
    root = os.path.abspath(args.local_root)
    rels = []
    for f in args.file:
        if not os.path.isfile(f):
            raise SystemExit(f"本地文件不存在: {f}")
        rels.append(_rel_to_root(root, f))

    remote_dir = f"{args.remote_root}/.hotfix-{int(time.time())}"
    # 注意：/opt 本身是 root 所有，临时目录必须落在已 chown 给 $USER 的项目根内
    run(client, f"mkdir -p {remote_dir}", timeout=60, stream=False)

    for src, rel in zip(args.file, rels):
        dst = f"{remote_dir}/{rel.replace('/', '__')}"
        sftp_upload(client, src, dst)
        target = f"{args.remote_root}/{rel}"
        # 先落到项目根（保持服务器代码与镜像构建上下文一致），再从容器外 cp 进容器
        run(client, f"mkdir -p $(dirname {target}) && cp {dst} {target} && echo '  -> {target}'", timeout=60)
        for c in ("crm-app", "crm-mcp"):
            code, out = run(client, f"docker cp {target} {c}:/app/{rel} 2>&1", timeout=120, stream=False)
            if code != 0:
                raise SystemExit(f"docker cp 到 {c} 失败: {out.strip()}")
            print(f"  ✓ 已注入 {c}:/app/{rel}")

    run(client, f"rm -rf {remote_dir}", timeout=60, stream=False)

    if not args.no_restart:
        print("==> 重启容器使改动生效")
        run(client, "docker restart crm-app crm-mcp", timeout=180)
        run(client, "sleep 8; docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'crm-(app|mcp|pg)'", timeout=120)

    print("\n✓ 热修完成。⚠ 容器内改动会在下一次 rebuild/up 时丢失，"
          "请务必把相同改动提交 git，并尽快跑一次 release（deploy-remote.py release）让镜像与仓库对齐。")
    return 0


def cmd_deploy(client, args):
    env_dir = f"{args.remote_root}/scripts/tencent-lighthouse-deploy"
    flag = " --seed" if args.seed else ""
    script = f"""
cd {env_dir}
bash deploy.sh{flag}
"""
    print(f"==> 执行远程一键部署（预计 5-15 分钟，取决于镜像拉取速度）")
    return run(client, script, timeout=DEFAULT_TIMEOUT, check=True)[0]


def cmd_status(client, args):
    env_dir = f"{args.remote_root}/scripts/tencent-lighthouse-deploy"
    script = f"""
cd {env_dir}
docker compose -f docker-compose.yml --env-file .env ps 2>&1
echo "=== app 日志尾部 ==="
docker compose -f docker-compose.yml --env-file .env logs --tail=40 app 2>&1
echo "=== 本机自测 ==="
curl -s -o /dev/null -w "http://127.0.0.1:3000/ -> %{{http_code}}\\n" -m 10 http://127.0.0.1:3000/
echo "=== 公网自测 ==="
curl -s -o /dev/null -w "http://127.0.0.1:80/ -> %{{http_code}}\\n" -m 10 http://127.0.0.1/
echo "=== 数据库扩展 ==="
docker compose -f docker-compose.yml --env-file .env exec -T db psql -U agent2b -d crm_native -c "\\dx" 2>&1 | head -10
echo "=== 表数量 ==="
docker compose -f docker-compose.yml --env-file .env exec -T db psql -U agent2b -d crm_native -tAc "select count(*) from information_schema.tables where table_schema='crm'" 2>&1
"""
    return run(client, script, timeout=300)[0]


def cmd_exec(client, args):
    return run(client, args.command)[0]


def main():
    p = argparse.ArgumentParser(description="CRM-ai-native 远程部署驱动")
    p.add_argument("action", choices=["probe", "upload", "push", "release", "hotfix", "initenv", "deploy", "status", "exec"])
    p.add_argument("--host", default=os.environ.get("CRM_SSH_HOST", "81.70.184.198"))
    p.add_argument("--user", default=os.environ.get("CRM_SSH_USER", "ubuntu"))
    p.add_argument("--password", default=None)
    p.add_argument("--password-file", default=os.environ.get("CRM_SSH_PASSWORD_FILE", None))
    p.add_argument("--pkg", default=None)
    p.add_argument("--remote-root", default="/opt/crm-ai-native")
    p.add_argument("--local-root", default=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")),
                   help="release/hotfix 的本地项目根（默认脚本上两级，即仓库根）")
    p.add_argument("--seed", action="store_true", help="部署时一并灌种子数据")
    p.add_argument("--local", default=None, help="push 子命令：本地文件路径")
    p.add_argument("--file", action="append", default=None, help="hotfix 子命令：项目根内的文件路径，可重复")
    p.add_argument("--no-restart", action="store_true", help="hotfix 后不自动重启容器")
    p.add_argument("--remote", default=None, help="push 子命令：远程目标路径")
    p.add_argument("--command", default=None)
    # 注意：不能用 nargs=REMAINDER——它会贪婪吞掉 --password-file 等选项导致认证失败。
    # 改用 parse_known_args 收集 `exec -- "<命令>"` 形式的尾部参数。
    args, unknown = p.parse_known_args()

    if args.action == "exec":
        parts = list(unknown)
        if parts and parts[0] == "--":
            parts = parts[1:]
        args.command = " ".join(parts).strip() or args.command
        if not args.command:
            p.error("exec 需要提供要执行的命令")

    client = build_client(args)
    try:
        fn = {
            "probe": cmd_probe,
            "upload": cmd_upload,
            "push": cmd_push,
            "release": cmd_release,
            "hotfix": cmd_hotfix,
            "initenv": cmd_initenv,
            "deploy": cmd_deploy,
            "status": cmd_status,
            "exec": cmd_exec,
        }[args.action]
        code = fn(client, args)
        sys.exit(code)
    finally:
        client.close()


if __name__ == "__main__":
    main()
