#!/bin/bash
# 首次启动 PostgreSQL 容器时自动执行（/docker-entrypoint-initdb.d）
# 作用：创建 CRM-ai-native 必需的扩展与 schema
set -e

echo "==> [init] 创建 pgvector / pgcrypto 扩展与 crm schema"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS crm;
EOSQL

echo "==> [init] 扩展就绪：vector / pgcrypto / schema crm"
