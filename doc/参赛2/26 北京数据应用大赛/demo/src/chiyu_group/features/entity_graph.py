"""实体抽取与实体-工单二部图：一跳强关联、二跳衰减。"""
import re
from collections import defaultdict

_ENTITY_PAT = re.compile(r"([\u4e00-\u9fa5]{2,8}(?:小区|物业|公司|商户|开发商|学校|医院|公园|大厦|广场))")


def extract_entities(text: str) -> set:
    hits = set(_ENTITY_PAT.findall(text or ""))
    for kw in ("物业", "开发商", "施工单位", "商户"):
        if kw in text:
            hits.add(kw)
    return hits


class EntityGraph:
    """实体-工单二部图：add_ticket 累积共现（幂等）。"""

    def __init__(self):
        self.ticket_entities: dict[str, set] = defaultdict(set)
        self.entity_tickets: dict[str, set] = defaultdict(set)

    def add_ticket(self, ticket_id: str, entities: set):
        for e in entities:
            self.ticket_entities[ticket_id].add(e)
            self.entity_tickets[e].add(ticket_id)

    def neighbors(self, entity: str, hops: int = 1) -> set:
        """经 ≤hop 步可达的实体（一跳=共现工单的其他实体，二跳=经一跳再拓展）。
        返回多步并集：hops=N 时包含 1..N 跳全部可达实体。"""
        out = set()
        frontier = {entity}
        for _ in range(hops):
            nxt = set()
            for e in frontier:
                for tid in self.entity_tickets.get(e, ()):
                    nxt |= self.ticket_entities.get(tid, set())
            nxt -= out | {entity}   # 去掉已并入与自身
            out |= nxt
            frontier = nxt
        return out


def entity_similarity(ea: set, eb: set, graph: EntityGraph | None,
                      jump_decay: float = 0.5) -> float:
    """实体相似 = Jaccard 直接共现 70% + 一跳/二跳衰减关联 30%。"""
    if not ea or not eb:
        return 0.0
    j = len(ea & eb) / len(ea | eb)
    if graph is None:
        return j
    hop_score = 0.0
    for e in ea:
        if e in eb:
            continue
        n1 = graph.neighbors(e, 1)
        if n1 & eb:
            hop_score = max(hop_score, jump_decay)
        elif graph.neighbors(e, 2) & eb:
            hop_score = max(hop_score, jump_decay * jump_decay)
    return 0.7 * j + 0.3 * min(hop_score, 1.0)
