"""笔记轨：簇画像按 cluster_id 幂等重写（upsert-by-key）。"""


class NoteTrack:
    def __init__(self):
        self._notes: dict[str, dict] = {}

    def upsert(self, key: str, note: dict):
        self._notes[key] = dict(note)     # 整块重写，不增量合并

    def get(self, key: str) -> dict | None:
        return self._notes.get(key)

    def keys(self):
        return list(self._notes.keys())

    def items(self):
        return list(self._notes.items())

    def __len__(self):
        return len(self._notes)
