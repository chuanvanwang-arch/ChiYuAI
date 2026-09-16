#!/usr/bin/env bash
# 生产性能诊断（只读，不改任何配置）
echo "===== ① 带 Accept-Encoding 实测 gzip 是否生效 ====="
for p in /landing.html /pipeline.html / /mcp; do
  printf '  %-20s ' "$p"
  enc=$(curl -s -H 'Accept-Encoding: gzip, br' -D - -o /tmp/_b.bin "http://127.0.0.1$p" 2>/dev/null | grep -i '^content-encoding' | tr -d '\r')
  printf 'wire=%-7s %s\n' "$(wc -c < /tmp/_b.bin)" "${enc:-（未压缩）}"
done

echo ""
echo "===== ② 页面引用的 JS/CSS 资产逐个实测 ====="
for pg in /pipeline.html /lead-pool.html /billing.html /; do
  echo "--- $pg ---"
  assets=$(curl -s "http://127.0.0.1$pg" | grep -oE '(src|href)="[^"]+\.(js|css)"' | grep -oE '/[^"]+\.(js|css)' | sort -u | head -12)
  if [ -z "$assets" ]; then echo "   （无外部 js/css，全内联）"; fi
  for a in $assets; do
    printf '   %-52s ' "$a"
    curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w 'code=%{http_code} wire=%{size_download}B ttfb=%{time_starttransfer}s\n' "http://127.0.0.1$a"
  done
done

echo ""
echo "===== ③ 缓存头（浏览器能否复用）====="
for p in / /pipeline.html /landing.html; do
  printf '  %-18s ' "$p"
  curl -sI "http://127.0.0.1$p" | grep -iE 'cache-control|etag|last-modified|expires' | tr -d '\r' | tr '\n' ' '
  echo
done

echo ""
echo "===== ④ nginx 请求总量与 TOP 路径 ====="
LOG=/var/log/nginx/access.log
echo "  日志总行数: $(sudo wc -l < $LOG)"
echo "  --- TOP 15 路径 ---"
sudo awk '{print $7}' $LOG | sort | uniq -c | sort -rn | head -15
echo "  --- TOP 8 客户端 ---"
sudo awk '{print $1}' $LOG | sort | uniq -c | sort -rn | head -8
echo "  --- 状态码分布 ---"
sudo awk '{print $9}' $LOG | sort | uniq -c | sort -rn | head -8

echo ""
echo "===== ⑤ 本地回环 API 耗时（无凭据，看闸/静态层）====="
for p in /api/board/named-account-manage /api/my-todo/badge /api/config/llm-configs; do
  printf '  %-40s ' "$p"
  curl -s -o /dev/null -w 'code=%{http_code} ttfb=%{time_starttransfer}s\n' "http://127.0.0.1$p"
done

echo ""
echo "===== ⑥ 容器日志中的错误与慢迹象 ====="
echo "  --- crm-app 近 500 行 error 计数 ---"
docker logs crm-app --tail 500 2>&1 | grep -ci error
echo "  --- crm-mcp 近 200 行 error 计数 ---"
docker logs crm-mcp --tail 200 2>&1 | grep -ci error
echo "  --- crm-app 近 30 行 ---"
docker logs crm-app --tail 30 2>&1 | sed 's/^/    /'

echo ""
echo "===== ⑦ LLM 配置（provider/模型/是否可达）====="
docker exec crm-pg psql -U agent2b -d crm_native -c "select id,provider,model,enabled,left(base_url,40) as base_url from crm.llm_config" 2>&1 | head -12

echo ""
echo "===== ⑧ 最近一次 LLM 调用耗时（token_accounting）====="
docker exec crm-pg psql -U agent2b -d crm_native -c "select id,tenant_id,model,tokens_in,tokens_out,created_at from crm.token_accounting order by created_at desc limit 6" 2>&1 | head -14

echo ""
echo "===== ⑨ 静态资源是否由 nginx 直出（检查 root/try_files）====="
sudo nginx -T 2>/dev/null | grep -nE 'root |try_files|sendfile|tcp_nopush|keepalive_timeout|worker_processes|worker_connections' | head -20
echo "  --- 静态资产目录是否存在于宿主机 ---"
ls -d /opt/crm-ai-native/src/web 2>/dev/null && echo "  src/web 在宿主机存在（可被 nginx 直出）" || echo "  ✗ src/web 不在宿主机（只能经 Express）"
