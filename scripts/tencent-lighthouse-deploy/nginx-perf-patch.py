#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生产 nginx 性能配置补丁（2026-09-16 性能 P0）

设计：先全量计算 → 断言锚点 → 备份 → 一次性写入 → nginx -t → 失败整体回滚 → restart。
幂等：以 marker 'crm_perf_20260916' 判重，重复执行安全。
用法：sudo python3 nginx-perf-patch.py [--dry-run]

改动清单：
  A. /etc/nginx/nginx.conf（http 全局）
     ① log_format perf：追加 rt/urt/uct/ust（默认 combined 无耗时字段 → 慢在哪无法定位）
     ② gzip_types：开启 JS/CSS/JSON/SVG/字体压缩（原 gzip_types 整行被注释 →
        实测 /portal/common.css 11062B 明文发送）
     ③ limit_req_zone / limit_conn_zone：每 IP 限流（实测全站 404 占 57.4%）
  B. server 块（sites-available/crm 与 conf.d/ip-default.conf，缺一不可）
     ④ limit_req / limit_conn 应用
     ⑤ location = /events：关闭缓冲（SSE 事件流必需，否则事件被攒批）
     ⑥ location ^~ /api/：长超时（LLM/Agent 端点原默认 60s 会 504）
     ⑦ 静态资源 location：替换 Express 的 Cache-Control: public, max-age=0
"""
import os, re, shutil, subprocess, sys, time

MARK = 'crm_perf_20260916'
DRY = '--dry-run' in sys.argv
STAMP = time.strftime('%Y%m%d%H%M%S')
BACKUP_DIR = '/tmp/nginx-perf-backup-' + STAMP
NGINX_CONF = '/etc/nginx/nginx.conf'
SITE_CONF = '/etc/nginx/sites-available/crm'
IP_CONF = '/etc/nginx/conf.d/ip-default.conf'

LOG_BLOCK = """\t# === crm_perf_20260916 ① ── 耗时观测 ──────────────────────────────────────
\t# 默认 combined 格式不含耗时字段 → 「系统慢」只能靠感知，无法归因。
\t# 前置字段与 combined 完全一致（保持既有 awk 位置解析可用：$9=status），仅追加 rt/urt/uct/ust。
\tlog_format perf '$remote_addr - $remote_user [$time_local] "$request" '
\t                '$status $body_bytes_sent "$http_referer" "$http_user_agent" '
\t                'rt=$request_time urt=$upstream_response_time '
\t                'uct=$upstream_connect_time ust=$upstream_status';
"""

GZIP_BLOCK = """\t# === crm_perf_20260916 ② ── 压缩 ──────────────────────────────────────────
\t# 原 gzip_types 整行被注释 → nginx 默认只压 text/html，
\t#   JS/CSS/JSON/SVG 全部明文传输（实测 /portal/common.css 11062B 原样发送）。
\tgzip on;
\tgzip_vary on;
\tgzip_proxied any;
\tgzip_comp_level 5;
\tgzip_min_length 1024;
\tgzip_types
\t    text/plain text/css text/xml text/javascript
\t    application/javascript application/json application/xml
\t    application/manifest+json image/svg+xml font/woff2;
"""

LIMIT_BLOCK = """\t# === crm_perf_20260916 ③ ── 每 IP 限流 ────────────────────────────────────
\t# 实测全站 404 占 57.4%（单个 GCP 扫描器 1592 次）。30r/s + burst 60 对正常
\t#   页面加载（约 35 请求）无影响，仅抑制恶意高频扫描。
\tlimit_req_zone $binary_remote_addr zone=crm_req:10m rate=30r/s;
\tlimit_conn_zone $binary_remote_addr zone=crm_conn:10m;
\tlimit_req_status 429;
\tlimit_conn_status 429;
"""

# 注入到 server 块内、`location / {` 之前（nginx 位置匹配按优先级而非书写顺序，位置无关紧要）
SERVER_BLOCK = """    # ═══ crm_perf_20260916 ── 性能配置（本段由补丁脚本幂等注入）═══
    limit_req zone=crm_req burst=60 nodelay;
    limit_conn crm_conn 30;

    # ⑤ SSE 事件流：必须关闭响应缓冲，否则事件被 nginx 攒批，前端收不到实时推进。
    location = /events {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # ⑥ 业务 API：为 LLM / Agent 类长请求留足超时（location / 的默认 60s 会 504）。
    #    ^~ 前缀同时保证 /api/**.js 之类的路径不会被下方静态正则误捡。
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    # ⑦ 静态资源：替换 Express 的 `Cache-Control: public, max-age=0`（每次导航都回源校验）。
    #    max-age=600 为保守值：资源未做哈希指纹，留 10 分钟陈旧窗口，发布后最迟 10 分钟收敛；
    #    ETag 保留，过期后仍可走 304 复用，不会重复下载。
    location ~* \\.(?:js|css|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|map)$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_hide_header Cache-Control;
        proxy_hide_header Expires;
        add_header Cache-Control "public, max-age=600, stale-while-revalidate=86400";
    }

"""

LIMIT_ONLY = ('    # === crm_perf_20260916 ── 限流（本 server 块无 location /）===\n'
              '    limit_req zone=crm_req burst=60 nodelay;\n'
              '    limit_conn crm_conn 30;\n\n')

BACKUP_MAP = [
    (NGINX_CONF, 'etc_nginx_nginx.conf'),
    (SITE_CONF, 'etc_nginx_sites-available_crm'),
    (IP_CONF, 'etc_nginx_conf.d_ip-default.conf'),
]

changed = []


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


# ─────────────────────── 阶段 1：全量计算（不落盘）───────────────────────
planned = {}

# A. nginx.conf
c = read(NGINX_CONF)
orig = c

if 'log_format perf' in c:
    print('A1 log_format perf      : 已存在，跳过')
else:
    c, n = re.subn(r'^([ \t]*)access_log\s+/var/log/nginx/access\.log\s*;',
                   lambda m: LOG_BLOCK + '%saccess_log /var/log/nginx/access.log perf;' % m.group(1),
                   c, count=1, flags=re.M)
    assert n == 1, 'A1 锚点 access_log 命中 %d 次（期望 1）' % n
    changed.append('A1 log_format perf')
    print('A1 log_format perf      : 待注入 ✓')

if re.search(r'^\s*gzip_types', c, re.M):
    print('A2 gzip_types           : 已存在（生效指令），跳过')
else:
    c, n = re.subn(r'^[ \t]*gzip\s+on\s*;', GZIP_BLOCK.rstrip('\n'), c, count=1, flags=re.M)
    assert n == 1, 'A2 锚点 gzip on 命中 %d 次（期望 1）' % n
    changed.append('A2 gzip_types')
    print('A2 gzip_types           : 待注入 ✓')

if 'limit_req_zone' in c:
    print('A3 limit_req_zone       : 已存在，跳过')
else:
    c, n = re.subn(r'^([ \t]*)include\s+/etc/nginx/conf\.d/\*\.conf\s*;',
                   lambda m: LIMIT_BLOCK + m.group(0), c, count=1, flags=re.M)
    assert n == 1, 'A3 锚点 conf.d include 命中 %d 次（期望 1）' % n
    changed.append('A3 limit_req_zone')
    print('A3 limit_req_zone       : 待注入 ✓')

if c != orig:
    planned[NGINX_CONF] = c

# B. server 块
for path, label in ((SITE_CONF, 'B1 sites-available/crm'), (IP_CONF, 'B2 conf.d/ip-default.conf')):
    if not os.path.exists(path):
        raise SystemExit('!! %s 不存在' % path)
    s = read(path)
    if MARK in s:
        print('%-24s: 已含 marker，跳过' % label)
        continue
    s2, n = re.subn(r'^([ \t]*)location\s+/\s*\{',
                    lambda m: SERVER_BLOCK + m.group(0), s, count=1, flags=re.M)
    if n == 1:
        planned[path] = s2
        changed.append(label + ' ④⑤⑥⑦')
        print('%-24s: 待注入 ④⑤⑥⑦（锚点 location /）✓' % label)
    else:
        s2, n2 = re.subn(r'^([ \t]*)listen\s+80\s*;',
                         lambda m: LIMIT_ONLY + m.group(0), s, count=1, flags=re.M)
        assert n2 == 1, '%s 无可用锚点（location / 或 listen 80）' % path
        planned[path] = s2
        changed.append(label + ' ④')
        print('%-24s: 待注入 ④（锚点 listen 80）✓' % label)

print('\n待写入文件: %d 个；改动项: %s' % (len(planned), ', '.join(changed) or '（无）'))

if DRY:
    print('\n--dry-run：不落盘，退出。')
    sys.exit(0)

if not planned:
    print('\n无需改动（幂等），退出。')
    sys.exit(0)

# ─────────────────────── 阶段 2：备份 + 写入 ───────────────────────
os.makedirs(BACKUP_DIR, exist_ok=True)
for live, bak in BACKUP_MAP:
    if os.path.exists(live):
        shutil.copy2(live, os.path.join(BACKUP_DIR, bak))
print('已备份 -> %s' % BACKUP_DIR)

for path, content in planned.items():
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('已写入 %s' % path)


def rollback():
    for live, bak in BACKUP_MAP:
        bp = os.path.join(BACKUP_DIR, bak)
        if os.path.exists(bp):
            shutil.copy2(bp, live)
            print('   已回滚 %s' % live)


# ─────────────────────── 阶段 3：校验 + 重启 ───────────────────────
print('\n=== nginx -t ===')
t = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
print((t.stdout + t.stderr).strip())
if t.returncode != 0:
    print('!! 语法校验失败 → 回滚')
    rollback()
    t2 = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    print('   回滚后 nginx -t rc=%d\n%s' % (t2.returncode, (t2.stdout + t2.stderr).strip()))
    sys.exit(1)

print('=== systemctl restart nginx（reload 不足以生效，已实锤）===')
r = subprocess.run(['systemctl', 'restart', 'nginx'], capture_output=True, text=True)
print('   restart rc=%d %s' % (r.returncode, (r.stdout + r.stderr).strip()))
time.sleep(2)
st = subprocess.run(['systemctl', 'is-active', 'nginx'], capture_output=True, text=True)
print('   nginx is-active=%s' % st.stdout.strip())

d = subprocess.run(['nginx', '-T'], capture_output=True, text=True)
dump = d.stdout + d.stderr
print('=== 生效核验（nginx -T）===')
print('   log_format perf   : %d 处' % dump.count('log_format perf'))
print('   gzip_types 行     : %d 处' % len(re.findall(r'^\s*gzip_types', dump, re.M)))
print('   limit_req_zone    : %d 处' % dump.count('limit_req_zone'))
print('   limit_req 应用    : %d 处' % len(re.findall(r'^\s*limit_req\s+zone=crm_req', dump, re.M)))
print('   /events 缓冲关闭  : %d 处' % dump.count('location = /events'))
print('   /api 长超时       : %d 处' % dump.count('location ^~ /api/'))
print('   静态缓存头        : %d 处' % dump.count('max-age=600'))
print('\n备份目录: %s（如需回滚：cp -a 该目录内文件回原位后 systemctl restart nginx）' % BACKUP_DIR)
