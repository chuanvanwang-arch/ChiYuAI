#!/usr/bin/env bash
# 生产性能配置验证（2026-09-16 性能 P0 的发布后点检脚本）
#
# 用法（服务器侧，经 deploy-remote.py exec 调用）：
#   deploy-remote.py push --local scripts/tencent-lighthouse-deploy/verify-perf.sh --remote /tmp/verify-perf.sh
#   deploy-remote.py exec -- "bash /tmp/verify-perf.sh"
#
# 覆盖：容器健康 / 三通道端点 / gzip / 缓存头 / 条件请求 / SSE / 限流生效与误伤 / 新日志字段
# ⚠ 本机 curl 若为 Windows 版，量 size_download 必须用 `-o NUL`（`-o /dev/null` 会 exit 23、值恒 0）
set -u

echo "========== ① 容器健康 =========="
docker ps --format '{{.Names}} | {{.Status}}'
for c in crm-app crm-mcp crm-pg; do
  printf '  %-9s ' "$c"
  docker inspect -f 'restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c"
done

echo ""
echo "========== ② 端点（裸 IP 通道）=========="
for p in / /landing.html /pipeline.html /portal/common.css /.well-known/oauth-protected-resource; do
  printf '  %-42s ' "$p"
  curl -s -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer}s\n' "http://127.0.0.1$p"
done
# ⚠ 探 /mcp 必须带 Accept，且 POST 体要含 method，否则得到的是 406 / SDK 400 而非 401
printf '  %-42s ' '/mcp POST 无 token（期望 401）'
curl -s -D - -o /dev/null -X POST http://127.0.0.1/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -iE 'HTTP/|www-authenticate' | tr -d '\r' | tr '\n' ' '
echo ""

echo ""
echo "========== ③ HTTPS 通道（release 会抹掉，务必点检）=========="
printf '  https://127.0.0.1/landing.html     '; curl -sk -o /dev/null -w 'code=%{http_code}\n' https://127.0.0.1/landing.html
printf '  https 域名(Host 头)                '; curl -sk -o /dev/null -w 'code=%{http_code}\n' -H 'Host: www.chiyuai.com' https://127.0.0.1/landing.html
printf '  443 监听数                         '; ss -tln 2>/dev/null | grep -c ':443'

echo ""
echo "========== ④ gzip（原 gzip_types 整行被注释 → 全明文）=========="
for p in /portal/common.css /portal/components.js /pipeline.html; do
  raw=$(curl -s -o /dev/null -w '%{size_download}' "http://127.0.0.1$p")
  gz=$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "http://127.0.0.1$p")
  enc=$(curl -s -H 'Accept-Encoding: gzip' -D - -o /dev/null "http://127.0.0.1$p" | grep -i '^content-encoding' | tr -d '\r' | cut -d' ' -f2)
  if [ "${raw:-0}" -gt 0 ]; then pct=$(( (raw - gz) * 100 / raw )); else pct=0; fi
  printf '  %-28s raw=%-7s gzip=%-7s (-%s%%) enc=%s\n' "$p" "$raw" "$gz" "$pct" "${enc:-none}"
done

echo ""
echo "========== ⑤ 缓存头与条件请求 =========="
printf '  静态资源 Cache-Control: '; curl -s -D - -o /dev/null http://127.0.0.1/portal/common.css | grep -i '^cache-control' | tr -d '\r' | cut -d' ' -f2-
printf '  HTML     Cache-Control: '; curl -s -D - -o /dev/null http://127.0.0.1/pipeline.html | grep -i '^cache-control' | tr -d '\r' | cut -d' ' -f2-
etag=$(curl -s -D - -o /dev/null http://127.0.0.1/portal/common.css | grep -i '^etag' | tr -d '\r' | cut -d' ' -f2)
printf '  带 If-None-Match 复访: '
curl -s -o /dev/null -w 'code=%{http_code} size=%{size_download}\n' -H "If-None-Match: $etag" http://127.0.0.1/portal/common.css

echo ""
echo "========== ⑥ SSE /events（须 event-stream 且未被缓冲）=========="
curl -s -D - -o /dev/null -m 3 http://127.0.0.1/events 2>/dev/null | grep -iE '^(HTTP|content-type|cache-control)' | tr -d '\r' | sed 's/^/  /'

echo ""
echo "========== ⑦ 限流（连打 400 次，期望出现 429；本机压测不应影响外部用户）=========="
codes=$(for i in $(seq 1 400); do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/landing.html; done | sort | uniq -c | tr '\n' ' ')
echo "  HTTP 码分布: $codes"
sleep 3
echo "  3s 后单次复测: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/landing.html)"

echo ""
echo "========== ⑧ 观测字段（rt/urt/uct/ust）与真实慢请求 =========="
LOG=/var/log/nginx/access.log
printf '  日志总行数: '; sudo wc -l < "$LOG"
printf '  最近 300 行含 rt= 的行数: '; sudo tail -300 "$LOG" | grep -c 'rt='
echo "  --- 按路径聚合（n / rt 均值 / rt 最大）---"
sudo awk '{rt="";for(i=1;i<=NF;i++) if($i~/^rt=/){rt=substr($i,4)}
  if(rt!=""){n[$7]++; s[$7]+=rt; if(rt>m[$7])m[$7]=rt}} END{for(p in n) printf "%-46s n=%-5d avg=%.4f max=%.4f\n", p, n[p], s[p]/n[p], m[p]}' "$LOG" \
  | sort -t= -k3 -rn | head -12 | sed 's/^/    /'

echo ""
echo "========== ⑨ app 日志 =========="
docker logs crm-app --tail 6 2>&1 | sed 's/^/  /'
printf '  近 200 行 error 计数: '; docker logs crm-app --tail 200 2>&1 | grep -ci error
