from chiyu_group.ingest.denoise import denoise


def test_template_prefix_removed():
    s = "工单来源：京通，此工单内容为网民留言时填写的标题及原文。\n====市民反映，电梯卡住"
    out = denoise(s)
    assert "工单来源" not in out
    assert "市民反映" in out


def test_tail_noise_removed():
    s = "希望尽快处理。请尽快处理。"
    out = denoise(s)
    assert out == "希望尽快处理。"


def test_multi_blank_collapsed():
    s = "a\n\n\nb   c"
    assert denoise(s) == "a\nb c"
