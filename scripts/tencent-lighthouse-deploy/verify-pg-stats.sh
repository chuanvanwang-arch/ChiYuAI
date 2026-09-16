#!/usr/bin/env bash
# ============================================================================
# pg_stat_statements 启用验收（2026-09-16）
# ----------------------------------------------------------------------------
# 背景：crm-pg 以命令行 `postgres -c shared_preload_libraries=age` 启动，
#       命令行优先级 > postgresql.auto.conf，故 ALTER SYSTEM 被静默覆盖。
#       解法：在 docker-compose.age.yml 显式声明启动命令（2026-09-16 已落地）。
#
# 用途：验证该改动是否真正生效，并采集真实慢 SQL。
# 执行：生产服务器上 bash verify-pg-stats.sh （脚本自包含，任意目录可跑）
# 判据：① .so 存在  ② show 含 pg_stat_statements 且 source=command line
#       ③ age 未丢失  ④ 扩展已建  ⑤ 采样视图可查
# ⛔ 若 ① 失败：立即回滚 compose，不要重启 db（回滚命令见 ① 内）
# ============================================================================
set -u

PSQL() { docker exec crm-pg psql -U agent2b -d crm_native -tAc "$1" 2>&1; }
FAIL=0

echo "========== ① 前置：pg_stat_statements.so 是否存在于镜像内 =========="
if docker exec crm-pg ls -l /usr/lib/postgresql/16/lib/pg_stat_statements.so 2>&1; then
  echo "  ✅ .so 存在"
else
  echo "  ❌ .so 缺失 —— 容器无法加载该库。立即回滚："
  echo "     cd /opt/crm-ai-native/scripts/tencent-lighthouse-deploy"
  echo "     cp docker-compose.age.yml.bak.20260916 docker-compose.age.yml"
  echo "     docker compose -f docker-compose.yml -f docker-compose.age.yml --env-file .env up -d db"
  exit 1
fi

echo ""
echo "========== ② 决定性判据：shared_preload_libraries 实际生效值 =========="
echo -n "  setting = "
PSQL "show shared_preload_libraries"
echo "  --- 来源（source=command line 才说明容器 CMD 生效）---"
PSQL "select setting, source, pending_restart from pg_settings where name='shared_preload_libraries'"

VAL=$(PSQL "show shared_preload_libraries")
case "$VAL" in
  *pg_stat_statements*) echo "  ✅ 含 pg_stat_statements" ;;
  *) echo "  ❌ 未含 pg_stat_statements —— 启动命令未生效"; FAIL=1 ;;
esac
case "$VAL" in
  *age*) echo "  ✅ age 未丢失（AGE 图谱可用）" ;;
  *) echo "  ⛔ age 丢失 —— AGE 图谱功能已失效，须立即修复启动命令"; FAIL=1 ;;
esac

echo ""
echo "========== ③ 已建扩展清单 =========="
PSQL "select extname || '  ' || extversion from pg_extension order by extname"

echo ""
echo "========== ④ 采样视图可用性 =========="
PSQL "select 'pg_stat_statements 行数: ' || count(*) from pg_stat_statements"

echo ""
echo "========== ⑤ 容器与应用健康 =========="
docker ps --filter name=crm- --format '  {{.Names}}\t{{.Status}}\t{{.RunningFor}}'

echo ""
echo "========== ⑥ 真实慢 SQL：按总耗时 TOP20 =========="
echo "  （db 重启后需 10~30 分钟有流量才有代表性）"
docker exec crm-pg psql -U agent2b -d crm_native -c "
SELECT calls,
       round(total_exec_time::numeric,1) AS total_ms,
       round(mean_exec_time::numeric,2)  AS mean_ms,
       round(max_exec_time::numeric,1)   AS max_ms,
       rows,
       left(query, 90) AS q
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;"

echo ""
echo "========== ⑦ 真实慢 SQL：按单次均值 TOP15（calls>=5，剔除低频噪声）=========="
docker exec crm-pg psql -U agent2b -d crm_native -c "
SELECT calls,
       round(mean_exec_time::numeric,2)  AS mean_ms,
       round(total_exec_time::numeric,1) AS total_ms,
       left(query, 90) AS q
FROM pg_stat_statements
WHERE calls >= 5
ORDER BY mean_exec_time DESC
LIMIT 15;"

echo ""
echo "========== ⑧ 需要干净基线时（可选，手动执行）=========="
echo "  docker exec crm-pg psql -U agent2b -d crm_native -c 'select pg_stat_statements_reset()'"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 验收通过：pg_stat_statements 已生效，AGE 未丢失"
else
  echo "❌ 验收未通过：请回看上方 ❌ / ⛔ 项"
fi
