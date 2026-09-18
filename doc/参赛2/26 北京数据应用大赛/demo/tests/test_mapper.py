import datetime as dt
import pytest
from chiyu_group.ingest.mapper import raw_to_ticket, Ticket

def test_raw_to_ticket_maps_official_fields():
    raw = {
        "工单编号": "热线-260402-062267",
        "工单标题": "没有收费标准不合理问题",
        "工单内容": "市民反映……",
        "推送时间": "2026-04-02 18:16:58",
        "承办单位": "朝阳区分中心",
        "问题分类": "市场管理>市场环境秩序>消费场所管理和环境",
        "问题点位": "北京市朝阳区朝阳路***",
    }
    t = raw_to_ticket(raw)
    assert t.order_id == "热线-260402-062267"
    assert t.push_time == dt.datetime(2026, 4, 2, 18, 16, 58)
    assert t.office_name == "朝阳区分中心"
    assert t.question_name == "市场管理>市场环境秩序>消费场所管理和环境"
    assert t.is_group is None  # 无标注字段

def test_raw_to_ticket_with_labels():
    raw = {"工单编号": "T1", "工单标题": "x", "工单内容": "y",
           "推送时间": "2026-04-02 18:16:58", "承办单位": "a",
           "问题分类": "b>c", "问题点位": "d", "GID": "G-1", "是否群诉": "1"}
    t = raw_to_ticket(raw)
    assert t.gid == "G-1"
    assert t.is_group is True

def test_missing_title_defaults_empty():
    t = raw_to_ticket({"工单编号": "T2", "推送时间": "2026-04-02 18:16:58"})
    assert t.title == "" and t.content == ""
