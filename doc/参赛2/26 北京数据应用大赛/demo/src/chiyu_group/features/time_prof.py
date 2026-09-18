"""时间分布特征：邻近性指数衰减 + 周期剖面（小时/星期/月份）。"""
import datetime as dt
import math
from collections import Counter


def time_features(t: dt.datetime) -> dict:
    return {"hour": t.hour, "weekday": t.weekday(), "month": t.month,
            "ts": t.timestamp()}


def temporal_similarity(ta: dt.datetime, tb: dt.datetime, mu: float = 0.5) -> float:
    """邻近性：距簇最近活动时间间隔的指数衰减。mu 越小衰减越快。"""
    d_hours = abs((ta - tb).total_seconds()) / 3600.0
    return math.exp(-mu * d_hours)


class TimeProfile:
    """簇时间剖面（小时/星期/月份分布），用于周期匹配（仅静默/归档簇开放）。"""

    def __init__(self):
        self.hours: Counter = Counter()
        self.weekdays: Counter = Counter()
        self.months: Counter = Counter()
        self.n = 0

    @classmethod
    def from_times(cls, times: list[dt.datetime]) -> "TimeProfile":
        p = cls()
        for t in times:
            p.add(t)
        return p

    def add(self, t: dt.datetime):
        self.hours[t.hour] += 1
        self.weekdays[t.weekday()] += 1
        self.months[t.month] += 1
        self.n += 1

    def match(self, t: dt.datetime) -> float:
        """周期匹配度：小时/星期/月份三个分布的对数似然（平滑）。"""
        if self.n == 0:
            return 0.0
        ph = self.hours.get(t.hour, 0) / self.n
        pw = self.weekdays.get(t.weekday(), 0) / self.n
        pm = self.months.get(t.month, 0) / self.n
        # 平滑避免 0：α=0.05 拉普拉斯
        return (0.95 * ph + 0.05 / 24) * 0.5 + (0.95 * pw + 0.05 / 7) * 0.3 + (0.95 * pm + 0.05 / 12) * 0.2
