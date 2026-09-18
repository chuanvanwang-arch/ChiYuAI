from chiyu_group.features.entity_graph import extract_entities, EntityGraph, entity_similarity


def test_extract_entities():
    ent = extract_entities("市民反映某某小区物业不让停车，物业私自安装地桩，开发商是XX公司")
    assert "物业" in ent or "某某小区" in ent or "开发商" in ent


def test_entity_similarity_jaccard():
    g = EntityGraph()
    g.add_ticket("T1", {"物业", "某某小区"})
    g.add_ticket("T2", {"物业", "某某小区", "停车"})
    g.add_ticket("T3", {"广场舞", "公园"})
    sim_12 = entity_similarity({"物业", "某某小区"}, {"物业", "某某小区", "停车"}, g)
    sim_13 = entity_similarity({"物业", "某某小区"}, {"广场舞", "公园"}, g)
    assert sim_12 > sim_13


def test_two_hop_decay():
    g = EntityGraph()
    g.add_ticket("A", {"物业X", "小区A"})
    g.add_ticket("B", {"物业X", "商户Y"})
    # 小区A → 物业X → 商户Y 为真实二跳（实体边计 2 次）
    sim = entity_similarity({"小区A"}, {"商户Y"}, g)
    assert 0 < sim <= 0.5   # 二跳弱关联，非零且低于一跳


def test_three_hop_beyond_window():
    """三跳链超出 2 跳窗口 → 相似度为 0（不回退到弱关联）。"""
    g = EntityGraph()
    g.add_ticket("A", {"物业X", "小区A"})
    g.add_ticket("B", {"物业X", "小区B"})
    g.add_ticket("C", {"小区B", "商户Y"})
    sim = entity_similarity({"小区A"}, {"商户Y"}, g)
    assert sim == 0.0
