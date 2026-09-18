"""流式回放器：按 push_time 时间序逐条喂入（模拟线上学习）。"""
import datetime as dt
from typing import Callable


class StreamReplay:
    def __init__(self, on_tick: Callable[[dict], None]):
        self.on_tick = on_tick
        self.processed = 0
        self.ticks = 0

    def feed(self, tickets):
        """tickets: 可迭代（含 push_time 属性）。按时间序处理。"""
        ordered = sorted(tickets, key=lambda t: t.push_time or dt.datetime.min)
        for t in ordered:
            self.on_tick(t)
            self.processed += 1
            self.ticks += 1
