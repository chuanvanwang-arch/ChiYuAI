"""官方字段 → 内部 Ticket 对象映射（对齐数据结构表）。"""
import datetime as dt
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Ticket:
    order_id: str
    title: str = ""
    content: str = ""
    push_time: Optional[dt.datetime] = None
    office_name: str = ""
    question_name: str = ""
    address: str = ""
    gid: Optional[str] = None          # 标注（仅评测）
    is_group: Optional[bool] = None    # 标注（仅评测）

    @property
    def text(self) -> str:
        """清洗后的文本输入：标题+内容，截断至 480 字符（≈512 token）。"""
        return (self.title + "。" + self.content).strip()[:480]


# 字段别名表：官方表头 → 内部键（兼容训练/测试两套表头）
FIELD_ALIASES = {
    "工单编号": ["order_id", "工单ID"],
    "工单标题": ["title", "事件标题"],
    "工单内容": ["content", "事件内容", "工单内容"],
    "推送时间": ["push_time", "推送时间（工单创建时间）"],
    "承办单位": ["office_name", "承办单位"],
    "问题分类": ["question_name", "问题分类"],
    "问题点位": ["address", "事发地址"],
    "GID": ["gid", "事件ID", "群诉ID"],
    "是否群诉": ["is_group", "是否群诉"],
}

_TIME_FMTS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S"]


def _parse_time(s: str) -> Optional[dt.datetime]:
    if not s or str(s).strip() in ("不详", ""):
        return None
    for fmt in _TIME_FMTS:
        try:
            return dt.datetime.strptime(str(s).strip(), fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.strptime(str(s).strip()[:10], "%Y-%m-%d")
    except ValueError:
        return None


def raw_to_ticket(raw: dict) -> Ticket:
    """把一行 CSV/dict（官方字段名或英文别名）映射为 Ticket。"""
    def pick(*keys):
        for k in keys:
            if k in raw and raw[k] is not None:
                return raw[k]
        return None

    order_id = pick("工单编号", "order_id", "工单ID") or ""
    title = str(pick("工单标题", "title", "事件标题") or "").strip()
    content = str(pick("工单内容", "content", "事件内容") or "").strip()
    push = _parse_time(str(pick("推送时间", "push_time", "推送时间（工单创建时间）") or ""))
    office = str(pick("承办单位", "office_name") or "").strip()
    qname = str(pick("问题分类", "question_name") or "").strip()
    addr = str(pick("问题点位", "address", "事发地址") or "").strip()
    gid = pick("GID", "gid", "事件ID", "群诉ID")
    isg = pick("是否群诉", "is_group")
    return Ticket(
        order_id=order_id, title=title, content=content, push_time=push,
        office_name=office, question_name=qname, address=addr,
        gid=str(gid) if gid not in (None, "") else None,
        is_group=None if isg in (None, "", "0", "否") else True,
    )
