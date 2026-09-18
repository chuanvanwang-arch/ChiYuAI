"""簇生命周期状态机：活跃→静默→蒸馏→归档→复活。归档永不物理删除。"""
import datetime as dt
from enum import Enum


class ClusterState(str, Enum):
    ACTIVE = "active"
    QUIET = "quiet"
    DISTILLED = "distilled"
    ARCHIVED = "archived"


class ClusterLifecycle:
    def __init__(self, quiet_days: int = 7, distill_days: int = 14):
        self.quiet_days = quiet_days
        self.distill_days = distill_days
        self._last_seen: dict[str, dt.datetime] = {}
        self._state: dict[str, ClusterState] = {}

    def touch(self, cid: str, t: dt.datetime):
        """工单命中簇：更新最近活动时间并推进状态。"""
        prev_last = self._last_seen.get(cid)
        self._last_seen[cid] = t
        st = self._state.get(cid, ClusterState.ACTIVE)
        if st == ClusterState.ARCHIVED:
            self._state[cid] = ClusterState.ACTIVE        # 命中即自动复活
            return
        if st in (ClusterState.ACTIVE, ClusterState.QUIET):
            gap = (t - prev_last).days if prev_last else 0
            if gap > self.distill_days:
                self._state[cid] = ClusterState.DISTILLED
            elif gap > self.quiet_days:
                self._state[cid] = ClusterState.QUIET

    def _gap_days(self, cid: str, t: dt.datetime) -> int:
        return (t - self._last_seen.get(cid, t)).days

    def state(self, cid: str) -> ClusterState:
        return self._state.get(cid, ClusterState.ACTIVE)

    def mark_archived(self, cid: str, t: dt.datetime):
        self._last_seen[cid] = t
        self._state[cid] = ClusterState.ARCHIVED

    def revive(self, cid: str, t: dt.datetime):
        self._state[cid] = ClusterState.ACTIVE
        self._last_seen[cid] = t

    def archived_ids(self) -> list[str]:
        return [c for c, s in self._state.items() if s == ClusterState.ARCHIVED]
