"""日志轨：原始工单事实仅追加（append-only），永不修改。"""
from typing import Any


class LogTrack:
    """内存实现（评测/演示用）；生产可换 JSONL/DB，语义不变。"""

    def __init__(self):
        self._items: dict[str, dict] = {}

    def append(self, key: str, record: dict):
        if key in self._items:
            raise ValueError(f"duplicate append: {key}")
        self._items[key] = dict(record)

    def get(self, key: str) -> dict | None:
        return self._items.get(key)

    def items(self):
        return sorted(self._items.items(), key=lambda kv: kv[0])

    def __len__(self):
        return len(self._items)

    def __contains__(self, key):
        return key in self._items
