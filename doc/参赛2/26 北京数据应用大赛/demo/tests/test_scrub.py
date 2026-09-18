from chiyu_group.ingest.scrub import scrub_credentials


def test_phone_idcard_name_removed():
    s = "市民:张三，电话13812345678，身份证110101199001011234，银行卡6222021234567890，反映问题"
    out, hit = scrub_credentials(s)
    assert hit is True
    assert "13812345678" not in out
    assert "110101199001011234" not in out
    assert "6222021234567890" not in out


def test_clean_text_unchanged():
    s = "小区夜间施工噪音扰民"
    out, hit = scrub_credentials(s)
    assert out == s and hit is False
