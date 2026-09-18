"""判定审计落库：评分明细/证据/红线版本/策略/耗时，形成可回溯链。"""
import datetime as dt
from dataclasses import dataclass, asdict, field
from typing import Optional


@dataclass
class AuditRecord:
    order_id: str
    action: str                      # join|create|revive|manual
    cluster_id: Optional[str]
    scores: dict                     # 8 项评分明细
    fused: float                     # RRF 融合分
    confidence: float                # 置信度反算
    redline_hit: bool
    redline_reason: str = ""
    strategy_version: str = "v1"
    elapsed_ms: float = 0.0
    ts: Optional[dt.datetime] = None


class AuditStore:
    """判定审计存储（内存实现；生产可换 DB，语义不变）。"""

    def __init__(self):
        self._records: dict[str, AuditRecord] = {}

    def add(self, rec: AuditRecord):
        self._records[rec.order_id] = rec

    def get(self, order_id: str) -> dict | None:
        rec = self._records.get(order_id)
        return asdict(rec) if rec else None

    def __len__(self):
        return len(self._records)

    def items(self):
        return list(self._records.items())
