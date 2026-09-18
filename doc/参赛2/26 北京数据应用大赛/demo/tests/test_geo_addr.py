from chiyu_group.features.geo_addr import normalize_address, admin_of_office, space_similarity


def test_office_admin_anchor():
    assert admin_of_office("朝阳区分中心") == "朝阳区"
    assert admin_of_office("顺义区仁和镇") == "顺义区"
    assert admin_of_office("市交管局") == ""      # 非区字头


def test_normalize_address_keep_text():
    a = normalize_address("北京市朝阳区朝阳路***")
    assert "朝阳区" in a


def test_space_similarity_cross_district_zero():
    a = normalize_address("北京市朝阳区朝阳路1号")
    b = normalize_address("北京市海淀区中关村大街1号")
    assert space_similarity("朝阳区", a, "海淀区", b) == 0.0


def test_space_similarity_same_district_high():
    a = normalize_address("朝阳区某某小区")
    b = normalize_address("朝阳区某某小区东门")
    assert space_similarity("朝阳区", a, "朝阳区", b) > 0.5
