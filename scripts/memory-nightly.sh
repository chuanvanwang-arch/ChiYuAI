#!/usr/bin/env bash
# scripts/memory-nightly.sh — 记忆治理闭环夜批（P4，2026-09-10 收口）
#
# 仅做只读巡检 + 闭环状态累积（写 feedback/proposals JSON 文件），绝不触达 memory_log。
# 真实修补（S1–S4）须人工评审后显式运行 memory-backfill.mjs --apply（HITL 闸，见治理设计 §8/§13）。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
node scripts/memory-health-check.mjs --json logs/mem-health.json >> logs/mem-health.log 2>&1 || true
node scripts/memory-loop-closed.mjs >> logs/mem-loop.log 2>&1 || true
echo "memory-nightly done: $(date -u +%FT%TZ)"
