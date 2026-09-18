from chiyu_group.decision.redline import check_redline


def test_cross_district_hit():
    hit, reason = check_redline(admin_a="朝阳区", admin_b="海淀区", question_a="a>施工扰民",
                                question_b="a>施工扰民")
    assert hit is True and "跨行政" in reason


def test_conflicting_question_hit():
    hit, reason = check_redline(admin_a="朝阳区", admin_b="朝阳区",
                                question_a="城乡建设>施工管理>施工扰民",
                                question_b="市场管理>市场环境秩序>消费场所")
    assert hit is True and "互斥" in reason


def test_same_question_no_hit():
    hit, reason = check_redline(admin_a="朝阳区", admin_b="朝阳区",
                                question_a="城乡建设>施工管理>施工扰民",
                                question_b="城乡建设>施工管理>施工扰民")
    assert hit is False
