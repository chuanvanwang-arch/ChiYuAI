"""地址空间特征：三级降级（②地名词典+层级粗匹配 / ③归一化文本+区划硬约束）。
实测：无经纬度无区划编码 → 确定走②③级；承办单位前两字=区名作免费锚。
"""
import re
from difflib import SequenceMatcher

DISTRICT_HINTS = {"朝阳", "海淀", "丰台", "石景山", "门头沟", "房山", "通州", "顺义",
                  "昌平", "大兴", "怀柔", "平谷", "密云", "延庆", "东城", "西城"}
DISTRICT_KEYS = sorted(DISTRICT_HINTS, key=len, reverse=True)   # 长名优先匹配
DISTRICTS = {h + "区" for h in DISTRICT_HINTS}


def admin_of_office(office_name: str) -> str:
    """承办单位前两字=区名锚；市直部门返回空。"""
    head = office_name[:2]
    if head in DISTRICT_HINTS:
        return head + "区"
    return ""


def normalize_address(address: str) -> str:
    """归一化：去空白/统一区名后缀；打星与不详保留文本形态用于文本相似。"""
    a = re.sub(r"\s+", "", address or "")
    for h in DISTRICT_HINTS:
        if a.startswith("北京市" + h + "区"):
            a = h + "区" + a[len("北京市") + len(h) + 1:]
            break
    return a


def extract_district(address: str) -> str:
    a = normalize_address(address)
    for h in DISTRICT_KEYS:
        if h + "区" in a:
            return h + "区"
    return ""


def _text_sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def space_similarity(admin_a: str, addr_a: str, admin_b: str, addr_b: str,
                     cross_district_penalty: float = 0.0) -> float:
    """空间相似：跨区→0（红线）；同区→归一化文本相似（③级）。
    ②级（地名词典）在 cluster 层升级：命中同别名词典时加成。"""
    if admin_a and admin_b and admin_a != admin_b:
        return cross_district_penalty
    na, nb = normalize_address(addr_a), normalize_address(addr_b)
    s = _text_sim(na, nb)
    # 空地址：不给 0 也不给满分，给中性 0.3
    if not na or not nb:
        return 0.3 if (na or nb) else 0.0
    return s
